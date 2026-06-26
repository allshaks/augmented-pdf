import { runClaude } from "./claude/runner";
import {
  GlossaryEntry,
  parseGlossaryArray,
  preserveWorthy,
  readGlossary,
  unionDedup,
  writeGlossary,
} from "./store/glossary";
import type AugmentedPdfPlugin from "./main";

/**
 * Glossary generation via the Claude CLI (Route B: Claude's Read tool ingests the PDF directly).
 *
 * The build is CHUNKED by page range. A whole large paper can't be extracted in one call — the spike
 * showed ~12 pages already produces ~32k output tokens, so ~60 pages would need ~160k, far past the
 * model's single-response output ceiling (which is why a full-paper build returned zero parseable
 * terms). Instead we extract ~12-page windows, each a bounded, reliably-parsed array, and merge them.
 *
 * Both build chunks and the single-term define accumulate the streamed text and parse THAT (never
 * trust `result`, which truncates for large output), and register their child in plugin.liveChildren.
 */

/** Pages per extraction chunk — kept small so each call's output stays well under the limit. */
const CHUNK_PAGES = 12;
/** Safety cap on chunks (≈ 288 pages) so a misbehaving stop-condition can't loop forever. */
const MAX_CHUNKS = 24;

interface RunProgress {
  phase: string;
  terms: number;
}

export interface BuildProgress {
  /** Human phase, e.g. "pages 13-24: reading the PDF". */
  phase: string;
  /** Terms accumulated so far across finished chunks + the current chunk's live estimate. */
  terms: number;
  /** Running cost across finished chunks (USD). */
  costUsd: number;
}

export interface BuildOutcome {
  count: number;
  costUsd: number;
  error?: string;
}

export interface DefineOutcome {
  entry: GlossaryEntry | null;
  costUsd: number;
  error?: string;
}

const TERM_SPEC =
  `extract every technical term, acronym, named method, dataset, and key entity a careful reader would ` +
  `want defined. For each term: prefer the paper's OWN in-text definition (set source to "paper", and ` +
  `page to the actual page number); if its definition is deferred to a cited reference, set source to ` +
  `"reference" and put the citation in the reference field; otherwise give a concise general-knowledge ` +
  `definition (source "general"). Output ONLY the raw JSON array, starting with [ and ending with ], ` +
  `with no markdown, no code fence, and no prose. Each element must be an object with keys: term ` +
  `(string), aliases (array of strings), definition (string of 1 to 3 sentences, LaTeX with $...$ ` +
  `allowed, may be empty only when source is reference), page (integer or null), source (one of: ` +
  `paper, general, reference), reference (string or null).`;

function chunkPrompt(relPath: string, startPage: number, endPage: number): string {
  return (
    `Read pages ${startPage} to ${endPage} of the PDF at "${relPath}". If the document has no pages in ` +
    `that range at all, output exactly: []  — nothing else. Otherwise, from those pages, ${TERM_SPEC}`
  );
}

function definePrompt(relPath: string, term: string): string {
  return (
    `Read the PDF at "${relPath}". Define the term "${term}" as it is used in THIS paper, in 1 to 3 ` +
    `sentences (LaTeX with $...$ allowed). If the paper defines it directly, use that and give the page. ` +
    `If the paper only uses it but defers its definition to a cited reference, set source "reference" and ` +
    `name that reference. Otherwise give a concise general-knowledge definition (source "general"). ` +
    `Output ONLY a JSON array containing EXACTLY ONE object with keys: term, aliases (array), definition ` +
    `(string), page (integer or null), source (one of: paper, general, reference), reference (string or ` +
    `null). No prose outside the array.`
  );
}

function countTerms(acc: string): number {
  return (acc.match(/"term"\s*:/g) || []).length;
}

interface OneShot<T> {
  promise: Promise<T>;
  cancel: () => void;
}

/** Run one read-only Claude call over the PDF, resolving the accumulated text + cost. */
function runOverPdf(
  plugin: AugmentedPdfPlugin,
  prompt: string,
  onUpdate?: (u: RunProgress) => void
): OneShot<{ text: string; costUsd: number; error?: string }> {
  let cancelled = false;
  let child: { kill(): void } | null = null;
  let phase = "starting";
  let terms = 0;
  const emit = () => onUpdate?.({ phase, terms });
  const promise = new Promise<{ text: string; costUsd: number; error?: string }>((resolve) => {
    let acc = "";
    child = runClaude(
      {
        binPath: plugin.settings.claudeBinPath,
        prompt,
        model: plugin.settings.glossaryModel || "sonnet",
        allowedTools: "Read",
        permissionMode: "dontAsk",
        cwd: plugin.vaultCwd(),
        settingSources: "project,local",
        noMcp: true,
      },
      {
        onBlock: (kind, name) => {
          if (kind === "thinking") phase = "thinking";
          else if (kind === "tool_use") phase = name === "Read" ? "reading the PDF" : `running ${name ?? "tool"}`;
          else if (kind === "text") phase = "writing terms";
          emit();
        },
        onText: (t) => {
          acc += t;
          terms = countTerms(acc);
          phase = "writing terms";
          emit();
        },
        onDone: (r) => {
          if (child) plugin.liveChildren.delete(child);
          if (r.isError) {
            resolve({ text: "", costUsd: r.costUsd ?? 0, error: r.result || r.subtype || "Claude returned an error" });
            return;
          }
          // Prefer the accumulated stream — `result` truncates for large output (spike finding).
          const text = acc.length >= (r.result?.length ?? 0) ? acc : r.result ?? acc;
          resolve({ text, costUsd: r.costUsd ?? 0 });
        },
        onError: (e) => {
          if (child) plugin.liveChildren.delete(child);
          resolve({ text: "", costUsd: 0, error: cancelled ? "cancelled" : e.message });
        },
      }
    );
    plugin.liveChildren.add(child);
  });
  return {
    promise,
    cancel: () => {
      cancelled = true;
      try {
        child?.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Build (or rebuild) the whole glossary for a PDF, CHUNK BY CHUNK, and save it. Iterates ~12-page
 * windows until a window comes back empty (past the end of the document), merging + deduping across
 * chunks and preserving any user-authored / web-fetched entries.
 */
export function startGlossaryBuild(
  plugin: AugmentedPdfPlugin,
  pdfPath: string,
  pdfName: string,
  onProgress?: (u: BuildProgress) => void
): OneShot<BuildOutcome> {
  let cancelled = false;
  let activeCancel: (() => void) | null = null;

  const promise = (async (): Promise<BuildOutcome> => {
    // Resume an interrupted build, or start fresh. Resuming keeps every existing term and continues
    // after the last covered page; a fresh build keeps only user/web/filled-reference entries and
    // re-extracts the rest.
    const existing = await readGlossary(plugin.app, pdfPath, pdfName);
    const resuming =
      !!existing &&
      existing.meta.complete === false &&
      typeof existing.meta.builtThroughPage === "number" &&
      existing.meta.builtThroughPage > 0;
    const pagesDone = resuming ? (existing!.meta.builtThroughPage as number) : 0;
    let running: GlossaryEntry[] = existing
      ? resuming
        ? [...existing.terms]
        : existing.terms.filter(preserveWorthy)
      : [];
    let totalCost = 0;
    let lastEnd = pagesDone;

    const save = (complete: boolean) =>
      writeGlossary(plugin.app, pdfPath, pdfName, running, {
        model: plugin.settings.glossaryModel || "sonnet",
        builtAt: new Date().toISOString(),
        builtThroughPage: lastEnd,
        complete,
      });

    for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
      if (cancelled) {
        if (running.length) await save(false);
        return { count: running.length, costUsd: totalCost, error: "cancelled" };
      }
      const startPage = pagesDone + chunk * CHUNK_PAGES + 1;
      const endPage = startPage + CHUNK_PAGES - 1;

      // Run the chunk; retry ONCE on a transient error that produced no terms.
      let terms: GlossaryEntry[] = [];
      let chunkErr: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const run = runOverPdf(plugin, chunkPrompt(pdfPath, startPage, endPage), (u) =>
          onProgress?.({ phase: `pages ${startPage}-${endPage}: ${u.phase}`, terms: running.length + u.terms, costUsd: totalCost })
        );
        activeCancel = run.cancel;
        const res = await run.promise;
        activeCancel = null;
        totalCost += res.costUsd;
        terms = parseGlossaryArray(res.text);
        chunkErr = res.error;
        if (res.error === "cancelled") {
          if (running.length) await save(false);
          return { count: running.length, costUsd: totalCost, error: "cancelled" };
        }
        if (terms.length || !res.error) break; // got terms, or a clean empty (end) → don't retry
      }

      if (chunkErr && !terms.length) {
        // Unrecoverable chunk failure: persist what we have (resumable) and report the error.
        if (running.length) await save(false);
        return { count: running.length, costUsd: totalCost, error: chunkErr };
      }
      if (!terms.length) {
        await save(true); // empty range → end of document → complete
        return { count: running.length, costUsd: totalCost };
      }
      running = unionDedup(running, terms);
      lastEnd = endPage;
      await save(false); // CHECKPOINT after every chunk, so an interruption leaves a usable partial
      onProgress?.({ phase: `pages ${startPage}-${endPage}: saved`, terms: running.length, costUsd: totalCost });
    }

    await save(true); // hit MAX_CHUNKS — mark complete to avoid endless resume
    return { count: running.length, costUsd: totalCost };
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      activeCancel?.();
    },
  };
}

/** Define a single term from the PDF (read-only, on-demand). Does NOT persist — the caller decides. */
export function defineTermWithClaude(
  plugin: AugmentedPdfPlugin,
  pdfPath: string,
  term: string
): OneShot<DefineOutcome> {
  const run = runOverPdf(plugin, definePrompt(pdfPath, term));
  const promise = (async (): Promise<DefineOutcome> => {
    const { text, costUsd, error } = await run.promise;
    if (error) return { entry: null, costUsd, error };
    const parsed = parseGlossaryArray(text);
    const first = parsed[0];
    if (!first) return { entry: null, costUsd, error: "Could not parse a definition from the response" };
    return { entry: { ...first, term }, costUsd };
  })();
  return { promise, cancel: run.cancel };
}
