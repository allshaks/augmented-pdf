import { App, TFile } from "obsidian";
import { glossaryPath } from "./paths";
import { stripControlChars } from "../format";

/**
 * Per-PDF glossary storage.
 *
 * The glossary lives in a sibling note `{stem} (glossary).md` next to the PDF (mirroring the
 * `(annotations)`/`(chats)` convention). Frontmatter (`augmented-pdf: glossary`) makes it findable
 * via metadataCache; the actual term data is a JSON array hidden inside an HTML comment so the note
 * stays clean in reading view. The comment (not a ```json fence) avoids fence-collision; we sanitize
 * `-->`/`<!--` out of stored strings so a definition can never break the wrapper.
 *
 * Design notes earned from the build spike:
 *  - Generation output can be large; the CLI `result` envelope truncates it, so glossaryGen parses
 *    the ACCUMULATED stream, then hands the text here via parseGlossaryArray().
 *  - Definitions contain `[` (citations like [12], intervals like [0,1]), so the tolerant parser
 *    anchors on the first `[{`, never the first `[`.
 */

export type DefSource = "paper" | "general" | "reference" | "web" | "user";

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  /** May be "" for a reference-deferred term that hasn't been fetched yet. */
  definition: string;
  /** Page in THIS paper where the term appears/defined, if known. */
  page: number | null;
  source: DefSource;
  /** The cited work a definition is attributed to (for source "reference" | "web"). */
  reference: string | null;
  /** URL a web-fetched definition came from. */
  sourceUrl?: string | null;
}

export interface GlossaryMeta {
  model?: string;
  builtAt?: string;
  /** Highest page covered so far — lets an interrupted chunked build resume instead of restarting. */
  builtThroughPage?: number;
  /** True once every chunk is done; false/absent means a partial build that can be resumed. */
  complete?: boolean;
}

export interface LoadedGlossary {
  file: TFile;
  terms: GlossaryEntry[];
  meta: GlossaryMeta;
}

const DATA_OPEN = "<!--augmented-pdf:glossary-data";
const DATA_CLOSE = "augmented-pdf:glossary-data-end-->";

/** Lookup key: lowercase, alphanumerics only — so "CKA", "c.k.a." and "cka" all collide. */
export function normalizeKey(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Neutralize anything that could break the HTML-comment wrapper or corrupt spawn args later. */
function cleanField(s: string): string {
  return stripControlChars(s || "")
    .replace(/<!--/g, "")
    .replace(/-->/g, "→")
    .trim();
}

function normalizeEntry(e: unknown): GlossaryEntry | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const term = typeof o.term === "string" ? o.term.trim() : "";
  if (!term) return null;
  const src = o.source;
  const source: DefSource =
    src === "general" || src === "reference" || src === "web" || src === "user" ? src : "paper";
  return {
    term,
    aliases: Array.isArray(o.aliases)
      ? o.aliases.filter((a): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim())
      : [],
    definition: typeof o.definition === "string" ? o.definition.trim() : "",
    page: typeof o.page === "number" && Number.isFinite(o.page) ? Math.trunc(o.page) : null,
    source,
    reference: typeof o.reference === "string" && o.reference.trim() ? o.reference.trim() : null,
    sourceUrl: typeof o.sourceUrl === "string" && o.sourceUrl.trim() ? o.sourceUrl.trim() : null,
  };
}

/**
 * Tolerant parse of an LLM-emitted glossary array. Anchors on the first `[{` (definitions contain
 * stray `[`), JSON.parses, and on failure retries by trimming to the last `}` + `]` (recovers a
 * response cut off mid-stream). Per-entry validation drops malformed entries rather than failing.
 */
export function parseGlossaryArray(raw: string): GlossaryEntry[] {
  if (!raw) return [];
  let s = raw;
  const start = s.search(/\[\s*\{/);
  if (start >= 0) s = s.slice(start);
  let arr: unknown = null;
  try {
    arr = JSON.parse(s);
  } catch {
    const lastClose = s.lastIndexOf("}");
    if (lastClose >= 0) {
      try {
        arr = JSON.parse(s.slice(0, lastClose + 1) + "]");
      } catch {
        /* give up */
      }
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: GlossaryEntry[] = [];
  for (const e of arr) {
    const n = normalizeEntry(e);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Merge a fresh build with an existing glossary, PRESERVING the user's work: manual ("user"),
 * web-fetched ("web"), and already-filled reference entries always win over a re-extracted entry
 * with the same key, so rebuilding never clobbers a definition you authored or fetched.
 */
/** A user-authored / web-fetched / already-filled reference entry — worth keeping across a rebuild. */
export function preserveWorthy(e: GlossaryEntry): boolean {
  return e.source === "user" || e.source === "web" || (e.source === "reference" && !!e.definition);
}

/**
 * Union of term lists, deduped by normalized key. On a collision the higher-priority entry wins
 * (user > web > filled-reference > everything else); ties keep the first seen. Used both to
 * accumulate chunks incrementally and to fold a fresh build into preserved user/web entries.
 */
export function unionDedup(...lists: GlossaryEntry[][]): GlossaryEntry[] {
  const rank = (e: GlossaryEntry) =>
    e.source === "user" ? 3 : e.source === "web" ? 2 : e.source === "reference" && !!e.definition ? 1 : 0;
  const map = new Map<string, GlossaryEntry>();
  for (const e of lists.flat()) {
    const k = normalizeKey(e.term);
    const cur = map.get(k);
    if (!cur || rank(e) > rank(cur)) map.set(k, e);
  }
  return [...map.values()];
}

/** Upsert a single entry by normalized key (used by manual + on-demand definitions). */
export function upsertEntry(terms: GlossaryEntry[], entry: GlossaryEntry): GlossaryEntry[] {
  const key = normalizeKey(entry.term);
  const next = terms.filter((e) => normalizeKey(e.term) !== key);
  next.push(entry);
  return next;
}

function buildFileContent(pdfName: string, terms: GlossaryEntry[], meta: GlossaryMeta): string {
  const safe = terms.map((t) => ({
    term: cleanField(t.term),
    aliases: t.aliases.map(cleanField),
    definition: cleanField(t.definition),
    page: t.page,
    source: t.source,
    reference: t.reference ? cleanField(t.reference) : null,
    sourceUrl: t.sourceUrl ?? null,
  }));
  const json = JSON.stringify(safe);
  const fmLines = [
    "---",
    "augmented-pdf: glossary",
    `pdf: "[[${pdfName}]]"`,
    "schema: 1",
    `model: ${meta.model || "sonnet"}`,
    `built-at: ${meta.builtAt || new Date().toISOString()}`,
    `terms-count: ${terms.length}`,
    `complete: ${meta.complete ? "true" : "false"}`,
  ];
  if (typeof meta.builtThroughPage === "number") fmLines.push(`built-through-page: ${meta.builtThroughPage}`);
  fmLines.push("tags: [augmented-pdf/glossary]", "---");
  const fm = fmLines.join("\n");
  const partial =
    meta.complete === false ? " (partial — build interrupted; run “Glossary: build / refresh” to continue)" : "";
  const note =
    `\n\n> [!info] Glossary — ${terms.length} term${terms.length === 1 ? "" : "s"}${partial}. ` +
    `Look them up with the “Glossary: look up a term” command (bind a hotkey in Settings → Hotkeys). ` +
    `This note is managed by Augmented PDF.\n`;
  const data = `\n${DATA_OPEN}\n${json}\n${DATA_CLOSE}\n`;
  return fm + note + data;
}

/** Load and parse the glossary for a PDF, or null if none exists. */
export async function readGlossary(app: App, pdfPath: string, pdfName: string): Promise<LoadedGlossary | null> {
  const f = app.vault.getAbstractFileByPath(glossaryPath(pdfPath, pdfName));
  if (!(f instanceof TFile)) return null;
  const content = await app.vault.cachedRead(f);
  const a = content.indexOf(DATA_OPEN);
  const b = content.indexOf(DATA_CLOSE);
  const terms = a >= 0 && b > a ? parseGlossaryArray(content.slice(a + DATA_OPEN.length, b)) : [];
  const fm = app.metadataCache.getFileCache(f)?.frontmatter ?? {};
  return {
    file: f,
    terms,
    meta: {
      model: fm.model,
      builtAt: fm["built-at"],
      builtThroughPage: typeof fm["built-through-page"] === "number" ? fm["built-through-page"] : undefined,
      complete: fm.complete === true,
    },
  };
}

/** Create or overwrite the glossary note for a PDF. */
export async function writeGlossary(
  app: App,
  pdfPath: string,
  pdfName: string,
  terms: GlossaryEntry[],
  meta: GlossaryMeta
): Promise<TFile> {
  const path = glossaryPath(pdfPath, pdfName);
  const content = buildFileContent(pdfName, terms, meta);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.process(existing, () => content);
    return existing;
  }
  return await app.vault.create(path, content);
}
