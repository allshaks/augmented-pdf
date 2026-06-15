import { App, TFile, TFolder, moment } from "obsidian";
import { ChatContext } from "../types";
import { annotationsFolder, ensureFolder, hubKey, oneLine, slugify, stemOf } from "./paths";
import { overlaps, parseSelId } from "./selection";

export interface NearbyHub {
  file: TFile;
  selId: string;
  page: number;
  chatCount: number;
  passage: string;
  color?: string;
}

/** Hubs on the same page whose selection overlaps (but isn't identical to) the given selection. */
export function findNearbyHubs(app: App, ctx: ChatContext): NearbyHub[] {
  const folder = app.vault.getAbstractFileByPath(annotationsFolder(ctx.pdfPath, ctx.pdfName));
  if (!(folder instanceof TFolder)) return [];
  const target = parseSelId(ctx.selId);
  if (!target) return [];
  const out: NearbyHub[] = [];
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const fm = app.metadataCache.getFileCache(child)?.frontmatter;
    if (!fm || fm["augmented-pdf"] !== "hub" || Number(fm.page) !== ctx.page) continue;
    const selId = String(fm.selection ?? "");
    const t = parseSelId(selId);
    if (t && overlaps(target, t)) {
      out.push({
        file: child,
        selId,
        page: Number(fm.page),
        chatCount: Number(fm["chat-count"] ?? 0),
        passage: typeof fm.passage === "string" ? fm.passage : "",
        color: fm.color ? String(fm.color) : undefined,
      });
    }
  }
  return out;
}

/**
 * The "hub" annotation note — one per highlight (keyed by page + selId). It holds the single
 * PDF++ selection link (the highlight) plus an append-only "## Chats" list, one entry per chat,
 * each = { summary, link to transcript }. Only this file is ever mutated; appends never touch
 * earlier entries.
 */

/** Find an existing hub for this highlight, without creating one. */
export function findHub(app: App, ctx: ChatContext): TFile | null {
  const folder = app.vault.getAbstractFileByPath(annotationsFolder(ctx.pdfPath, ctx.pdfName));
  if (!(folder instanceof TFolder)) return null;
  const key = hubKey(ctx.page, ctx.selId);
  for (const child of folder.children) {
    // Match exact key or "key — slug.md" (trailing space avoids 96 vs 960 prefix collisions).
    if (child instanceof TFile && (child.name === key + ".md" || child.name.startsWith(key + " "))) {
      return child;
    }
  }
  return null;
}

export async function findOrCreateHub(app: App, ctx: ChatContext): Promise<TFile> {
  const existing = findHub(app, ctx);
  if (existing) return existing;

  const folder = annotationsFolder(ctx.pdfPath, ctx.pdfName);
  await ensureFolder(app, folder);
  const path = `${folder}/${hubKey(ctx.page, ctx.selId)} — ${slugify(ctx.passage)}.md`;
  return app.vault.create(path, hubTemplate(ctx));
}

function hubTemplate(ctx: ChatContext): string {
  const stem = stemOf(ctx.pdfName);
  const link = `[[${ctx.pdfName}#page=${ctx.page}&selection=${ctx.selId}&color=${ctx.color}|${stem}, page ${ctx.page}]]`;
  return [
    "---",
    "augmented-pdf: hub",
    `pdf: "[[${ctx.pdfName}]]"`,
    `page: ${ctx.page}`,
    `selection: "${ctx.selId}"`,
    `color: ${ctx.color}`,
    `highlight-key: "${ctx.pdfName}|${ctx.page}|${ctx.selId}"`,
    `passage: ${JSON.stringify(oneLine(ctx.passage))}`,
    ...(ctx.litNote ? [`lit-note: "[[${ctx.litNote}]]"`] : []),
    "chat-count: 0",
    "tags: [augmented-pdf/annotation]",
    "---",
    "",
    `> [!quote] Highlighted passage (p.${ctx.page})`,
    "> " + ctx.passage.replace(/\n/g, "\n> "),
    "",
    `**Source:** ${link}`,
    ...(ctx.litNote ? ["", `**Paper:** [[${ctx.litNote}]]`] : []),
    "",
    "```augmented-pdf-chat",
    "new",
    "```",
    "",
    "## Chats",
    "",
  ].join("\n");
}

/** Append one chat entry (summary pending) under "## Chats". Append-only; bumps chat-count. */
export async function appendChatEntry(
  app: App,
  hub: TFile,
  e: { anchorId: string; title: string; transcriptBasename: string }
): Promise<void> {
  await app.vault.process(hub, (content) => {
    const entry =
      `\n### ${moment().format("YYYY-MM-DD HH:mm")} — ${e.title} <!--apc:${e.anchorId}-->\n` +
      `*(summary pending…)*\n` +
      `→ [[${e.transcriptBasename}|Full chat ↗]]\n`;
    return bumpChatCount(appendUnderChats(content, entry), +1);
  });
}

/** Replace an entry's "(summary pending)" line with the generated summary, located by anchor id. */
export async function updateEntrySummary(app: App, hub: TFile, anchorId: string, summary: string): Promise<void> {
  await app.vault.process(hub, (content) => {
    const marker = `<!--apc:${anchorId}-->`;
    const markerIdx = content.indexOf(marker);
    if (markerIdx < 0) return content;
    const headingEnd = content.indexOf("\n", markerIdx);
    if (headingEnd < 0) return content;
    const summaryStart = headingEnd + 1;
    const summaryEnd = content.indexOf("\n", summaryStart);
    const end = summaryEnd < 0 ? content.length : summaryEnd;
    return content.slice(0, summaryStart) + oneLine(summary) + content.slice(end);
  });
}

/** Prior chat summaries (the "## Chats" section text) for cross-thread continuity. */
export async function readPriorSummaries(app: App, hub: TFile): Promise<string> {
  const content = await app.vault.cachedRead(hub);
  const i = content.indexOf("## Chats");
  if (i < 0) return "";
  return content.slice(i + "## Chats".length).trim();
}

function appendUnderChats(content: string, entry: string): string {
  // "## Chats" is the last section, so appending at EOF keeps chronological order.
  if (content.includes("## Chats")) return content.replace(/\s*$/, "") + "\n" + entry;
  return content.replace(/\s*$/, "") + "\n\n## Chats\n" + entry;
}

function bumpChatCount(content: string, delta: number): string {
  return content.replace(/^chat-count: (\d+)\s*$/m, (_m, n) => `chat-count: ${parseInt(n, 10) + delta}`);
}
