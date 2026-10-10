import { App, TFile, loadPdfJs } from "obsidian";
import { ChatContext } from "../types";

/**
 * Builds the document context that goes into the system prompt.
 *
 * Markdown is inlined directly (reliable, and works under a tool-less provider like GWDG). PDFs are
 * NOT inlined — they're binary, and a whole paper would blow the context anyway — so the model is
 * pointed at the vault-relative path and reads it with the Read tool, exactly as the glossary
 * builder already does. That means whole-PDF chats need the Claude CLI provider.
 */

/** Per-file cap on inlined text; past this we truncate and point at the path for the remainder. */
export const MAX_INLINE_CHARS = 40_000;
/** Cap on total attachment text, so a few large notes can't crowd out the conversation. */
export const MAX_TOTAL_ATTACH_CHARS = 80_000;
/** Cap on how many files can be attached at once. */
export const MAX_ATTACHMENTS = 8;
/**
 * Cap on a whole PDF's extracted text when it has to be inlined (~30k tokens) — enough for most
 * papers while fitting the context of GWDG's smaller models (Llama 3.1 8B: 128k tokens).
 */
export const MAX_PDF_INLINE_CHARS = 120_000;

export interface PdfText {
  text: string;
  /** Page count (0 when unknown — Docling's Markdown has no page breaks). */
  pages: number;
  /** Pages that fit completely under the cap (local extraction only). */
  pagesIncluded: number;
  truncated: boolean;
  /** How the text was produced: GWDG's Docling (Markdown) or local pdf.js (plain text). */
  source: "docling" | "pdfjs";
  /** Set when Docling was wanted but failed and local extraction was used instead. */
  note?: string;
}

/** Turns a vault PDF path into Markdown (GWDG Docling, via the plugin's disk cache). */
export type PdfConverter = (path: string) => Promise<string>;

/** The slice of the pdf.js API used here — satisfied by Obsidian's bundled copy and by pdfjs-dist. */
interface PdfJsLike {
  getDocument(src: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>;
      destroy?(): Promise<void>;
    }>;
  };
}

/**
 * A PDF's text, page by page with "[page N]" markers (so answers can cite pages), stopping at `cap`
 * characters. For providers that can't open files: the extraction happens HERE, locally, so the
 * paper's text is sent only to the chosen provider. Exported for testing with a real pdf.js.
 */
export async function extractPdfText(
  pdfjs: PdfJsLike,
  data: ArrayBuffer | Uint8Array,
  cap: number
): Promise<Omit<PdfText, "source" | "note">> {
  const doc = await pdfjs.getDocument({ data: data instanceof Uint8Array ? data : new Uint8Array(data) }).promise;
  let out = "";
  let pagesIncluded = 0;
  let truncated = false;
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    const body = tc.items
      .map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : " "))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    const chunk = `[page ${i}]\n${body}\n\n`;
    if (out.length + chunk.length > cap) {
      out += chunk.slice(0, Math.max(0, cap - out.length));
      truncated = true;
      break;
    }
    out += chunk;
    pagesIncluded = i;
  }
  try {
    await doc.destroy?.();
  } catch {
    /* ignore */
  }
  // A scan has pages but no text layer: report it as empty rather than a list of bare markers.
  const hasText = out.replace(/\[page \d+\]/g, "").trim().length > 0;
  return { text: hasText ? out.trim() : "", pages: doc.numPages, pagesIncluded, truncated };
}

/** Extraction is re-run every turn otherwise (the prompt is rebuilt per turn) — cache by mtime+size. */
const pdfCache = new Map<string, { mtime: number; size: number; r: PdfText }>();

/**
 * A PDF's content for inlining. With a converter (GWDG Docling) it's Markdown; otherwise — or when
 * the converter fails — plain text extracted locally with Obsidian's pdf.js, with `note` saying so.
 */
export async function pdfTextFor(
  app: App,
  path: string,
  cap = MAX_PDF_INLINE_CHARS,
  convert?: PdfConverter
): Promise<PdfText | null> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return null;
  const key = `${path}|${cap}|${convert ? "docling" : "pdfjs"}`;
  const hit = pdfCache.get(key);
  if (hit && hit.mtime === f.stat.mtime && hit.size === f.stat.size) return hit.r;

  let r: PdfText | null = null;
  let note: string | undefined;
  if (convert) {
    try {
      const md = await convert(path);
      const truncated = md.length > cap;
      r = { text: truncated ? md.slice(0, cap) : md, pages: 0, pagesIncluded: 0, truncated, source: "docling" };
    } catch (e) {
      note = `Docling couldn't convert it (${e instanceof Error ? e.message : String(e)}) — used plain-text extraction instead`;
      console.warn("[augmented-pdf] Docling failed; falling back to pdf.js", path, e);
    }
  }
  if (!r?.text) {
    const x = await extractPdfText(await loadPdfJs(), await app.vault.readBinary(f), cap);
    r = { ...x, source: "pdfjs", note };
  }
  pdfCache.set(key, { mtime: f.stat.mtime, size: f.stat.size, r });
  return r;
}

function clip(text: string, path: string, cap: number): { text: string; clipped: boolean } {
  if (text.length <= cap) return { text, clipped: false };
  return {
    text:
      text.slice(0, cap) +
      `\n\n…[truncated at ${cap} characters — the full file is at "${path}"; read it for the rest]`,
    clipped: true,
  };
}

async function readFile(app: App, path: string): Promise<string | null> {
  const f = app.vault.getAbstractFileByPath(path);
  if (!(f instanceof TFile)) return null;
  try {
    return await app.vault.cachedRead(f);
  } catch (e) {
    console.warn("[augmented-pdf] context read failed", path, e);
    return null;
  }
}

/** The system-prompt block describing the document the chat is about. */
export async function buildSourceBlock(
  app: App,
  ctx: ChatContext,
  opts: { inlinePdf?: boolean; convertPdf?: PdfConverter } = {}
): Promise<string> {
  if (ctx.scope === "selection") {
    return (
      `You are helping the user understand a passage from the PDF "${ctx.fileName}" (page ${ctx.page}).\n` +
      `Highlighted passage:\n"""\n${ctx.passage}\n"""\n` +
      `Answer concisely and stay grounded in this passage.`
    );
  }

  const selected = ctx.passage
    ? `\n\nThe user had this text selected — treat it as the focus of the question:\n"""\n${ctx.passage}\n"""`
    : "";

  if (ctx.kind === "pdf") {
    // A provider that can't open files gets the paper's text inline (send() has already verified
    // there IS extractable text, so this branch never falls back to a path it can't read).
    if (opts.inlinePdf) {
      const r = await pdfTextFor(app, ctx.filePath, MAX_PDF_INLINE_CHARS, opts.convertPdf).catch((e) => {
        console.warn("[augmented-pdf] PDF text extraction failed", ctx.filePath, e);
        return null;
      });
      if (r?.text && r.source === "docling") {
        return (
          `You are helping the user with the PDF "${ctx.fileName}". Its content, converted to Markdown ` +
          `(tables and structure kept):\n"""\n${r.text}\n"""` +
          (r.truncated
            ? `\n\n(The document was cut off at ${MAX_PDF_INLINE_CHARS} characters; later parts are missing — say so if the question needs them.)`
            : "") +
          selected +
          `\n\nAnswer concisely and stay grounded in the document.`
        );
      }
      if (r?.text) {
        return (
          `You are helping the user with the PDF "${ctx.fileName}" (${r.pages} pages). Its text, ` +
          `extracted with [page N] markers:\n"""\n${r.text}\n"""` +
          (r.truncated
            ? `\n\n(Only pages 1–${r.pagesIncluded} of ${r.pages} fit; say so if the question needs later pages.)`
            : "") +
          selected +
          `\n\nAnswer concisely, stay grounded in the document, and cite page numbers where useful.`
        );
      }
    }
    return (
      `You are helping the user with the whole PDF "${ctx.fileName}", at the vault-relative path ` +
      `"${ctx.filePath}" (the current working directory is the user's Obsidian vault). ` +
      `Read that file when you need its contents.` +
      selected +
      `\n\nAnswer concisely and stay grounded in the document.`
    );
  }

  const body = await readFile(app, ctx.filePath);
  if (body === null) {
    return (
      `You are helping the user with the note "${ctx.fileName}" at "${ctx.filePath}", which could ` +
      `not be read from the vault. Try reading that path directly.` +
      selected
    );
  }
  const { text } = clip(body, ctx.filePath, MAX_INLINE_CHARS);
  return (
    `You are helping the user with their Obsidian note "${ctx.fileName}" (at "${ctx.filePath}").\n` +
    `Its full contents:\n"""\n${text}\n"""` +
    selected +
    `\n\nAnswer concisely and stay grounded in this note.`
  );
}

/** The system-prompt block for @-attached files. Empty string when nothing is attached. */
export async function buildAttachmentsBlock(
  app: App,
  paths: string[] | undefined,
  opts: { inlinePdf?: boolean; convertPdf?: PdfConverter } = {}
): Promise<string> {
  if (!paths?.length) return "";
  const parts: string[] = [];
  let budget = MAX_TOTAL_ATTACH_CHARS;
  for (const path of paths.slice(0, MAX_ATTACHMENTS)) {
    if (/\.pdf$/i.test(path)) {
      // Inline the attached PDF's text for providers that can't open files, within the budget.
      if (opts.inlinePdf && budget > 0) {
        const r = await pdfTextFor(app, path, Math.min(MAX_INLINE_CHARS, budget), opts.convertPdf).catch(() => null);
        if (r?.text) {
          budget -= r.text.length;
          const cut = r.truncated ? (r.source === "docling" ? "\n(truncated)" : `\n(truncated after page ${r.pagesIncluded} of ${r.pages})`) : "";
          parts.push(`### ${path}\n"""\n${r.text}\n"""${cut}`);
          continue;
        }
      }
      parts.push(`### ${path}\n(PDF — read the file at "${path}" if you need it.)`);
      continue;
    }
    const body = await readFile(app, path);
    if (body === null) {
      parts.push(`### ${path}\n(could not be read from the vault)`);
      continue;
    }
    if (budget <= 0) {
      parts.push(`### ${path}\n(omitted — attachment size budget exhausted; read "${path}" if needed.)`);
      continue;
    }
    const { text } = clip(body, path, Math.min(MAX_INLINE_CHARS, budget));
    budget -= text.length;
    parts.push(`### ${path}\n"""\n${text}\n"""`);
  }
  return (
    `\n\nThe user has attached these files from their vault as additional context:\n\n` + parts.join("\n\n")
  );
}
