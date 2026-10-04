import { App, TFile } from "obsidian";
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

function clip(text: string, path: string, cap: number): { text: string; clipped: boolean } {
  if (text.length <= cap) return { text, clipped: false };
  return {
    text:
      text.slice(0, cap) +
      `\n\n…[truncated at ${cap} characters — the full file is at "${path}"; use the Read tool for the rest]`,
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
export async function buildSourceBlock(app: App, ctx: ChatContext): Promise<string> {
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
    return (
      `You are helping the user with the whole PDF "${ctx.fileName}", at the vault-relative path ` +
      `"${ctx.filePath}" (the current working directory is the user's Obsidian vault). ` +
      `Use the Read tool on that path to read it when you need its contents.` +
      selected +
      `\n\nAnswer concisely and stay grounded in the document.`
    );
  }

  const body = await readFile(app, ctx.filePath);
  if (body === null) {
    return (
      `You are helping the user with the note "${ctx.fileName}" at "${ctx.filePath}", which could ` +
      `not be read from the vault. Use the Read tool on that path if it is available.` +
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
export async function buildAttachmentsBlock(app: App, paths: string[] | undefined): Promise<string> {
  if (!paths?.length) return "";
  const parts: string[] = [];
  let budget = MAX_TOTAL_ATTACH_CHARS;
  for (const path of paths.slice(0, MAX_ATTACHMENTS)) {
    if (/\.pdf$/i.test(path)) {
      parts.push(`### ${path}\n(PDF — read it with the Read tool on "${path}" if you need it.)`);
      continue;
    }
    const body = await readFile(app, path);
    if (body === null) {
      parts.push(`### ${path}\n(could not be read from the vault)`);
      continue;
    }
    if (budget <= 0) {
      parts.push(`### ${path}\n(omitted — attachment size budget exhausted; Read "${path}" if needed.)`);
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
