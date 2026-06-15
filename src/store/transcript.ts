import { App, TFile, moment } from "obsidian";
import { ChatContext, Turn } from "../types";
import { chatsFolder, ensureFolder, oneLine, slugify, stemOf } from "./paths";

/**
 * The transcript note — the full chat for one thread, in "<stem> (chats)/". Rewritten in place
 * while the thread is active (each turn + when the summary lands); never touched once the thread
 * ends. It links back to the hub (the hub owns the highlight), so we get exactly one highlight
 * per passage.
 */

export interface TranscriptOpts {
  file: TFile | null; // null on first write -> create; otherwise modify in place
  sessionId: string;
  model: string;
  turns: Turn[];
  totalCost: number;
  hubBasename: string;
  createdISO: string;
  summary: string | null;
}

export async function writeTranscript(app: App, ctx: ChatContext, o: TranscriptOpts): Promise<TFile> {
  const body = buildBody(ctx, o);
  if (o.file) {
    await app.vault.modify(o.file, body);
    return o.file;
  }
  const folder = chatsFolder(ctx.pdfPath, ctx.pdfName);
  await ensureFolder(app, folder);
  const stamp = moment().format("YYYY-MM-DD HHmm");
  const slug = slugify(firstUserText(o.turns));
  const short = o.sessionId.slice(0, 8);
  const path = `${folder}/${stamp} — ${slug} — ${short}.md`;
  return app.vault.create(path, body);
}

function buildBody(ctx: ChatContext, o: TranscriptOpts): string {
  const stem = stemOf(ctx.pdfName);
  const fm = [
    "---",
    "augmented-pdf: transcript",
    `pdf: "[[${ctx.pdfName}]]"`,
    `page: ${ctx.page}`,
    `selection: "${ctx.selId}"`,
    `color: ${ctx.color}`,
    `hub: "[[${o.hubBasename}]]"`,
    ...(ctx.litNote ? [`lit-note: "[[${ctx.litNote}]]"`] : []),
    `session-id: ${o.sessionId}`,
    `model: ${o.model}`,
    `created: ${o.createdISO}`,
    `cost_usd: ${o.totalCost.toFixed(4)}`,
    `summary: ${o.summary ? JSON.stringify(oneLine(o.summary)) : '""'}`,
    "tags: [augmented-pdf/chat]",
    "---",
    "",
  ].join("\n");

  const parts: string[] = [
    fm,
    `[[${o.hubBasename}|← Back to annotation]]`,
    "",
    "```augmented-pdf-chat",
    "continue",
    "```",
    "",
    `> [!quote] Highlighted passage (p.${ctx.page})`,
    "> " + ctx.passage.replace(/\n/g, "\n> "),
    "",
    `# Chat — ${stem}, p.${ctx.page}`,
    "",
  ];
  if (o.summary) {
    parts.push("## Summary", o.summary, "");
  }
  for (const t of o.turns) {
    parts.push(`## ${t.role === "user" ? "You" : "Claude"}`, t.text, "");
  }
  return parts.join("\n");
}

function firstUserText(turns: Turn[]): string {
  return turns.find((t) => t.role === "user")?.text ?? "chat";
}

/** Parse the You/Claude turns back out of a transcript's markdown (for reloading a chat). */
export function parseTranscriptTurns(content: string): Turn[] {
  const turns: Turn[] = [];
  const heads = [...content.matchAll(/^##\s+(You|Claude)\s*$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const role = heads[i][1] === "You" ? "user" : "claude";
    const start = (heads[i].index ?? 0) + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? content.length : content.length;
    const text = content.slice(start, end).trim();
    if (text) turns.push({ role, text });
  }
  return turns;
}
