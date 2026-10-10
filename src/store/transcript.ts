import { App, TFile, moment } from "obsidian";
import { ChatContext, Turn } from "../types";
import { ensureFolder, oneLine, slugify, stemOf, transcriptsFolder } from "./paths";
import { sourceLink } from "./hub";

/**
 * The transcript note — the full chat for one thread. Rewritten in place while the thread is active
 * (each turn + when the summary lands); never touched once the thread ends. It links back to the hub
 * (the hub owns the anchor), so we get exactly one hub per highlight — or per file, for whole-file
 * chats.
 *
 * Lives beside the PDF in "<stem> (chats)/", or under "<root>/<mirrored path>/" for a markdown note.
 */

export interface TranscriptOpts {
  file: TFile | null; // null on first write -> create; otherwise modify in place
  sessionId: string;
  model: string;
  /** Concrete model the alias resolved to, e.g. "claude-opus-5" — recorded as `model-id`. */
  resolvedModel?: string | null;
  /** Which backend ran this chat ("claude" | "codex" | "gwdg"); omitted from the note for Claude. */
  provider?: string;
  /** The backend's own session id when it mints one (Codex's thread_id), needed to resume. */
  providerSession?: string | null;
  turns: Turn[];
  totalCost: number;
  hubBasename: string;
  createdISO: string;
  summary: string | null;
}

export async function writeTranscript(
  app: App,
  ctx: ChatContext,
  o: TranscriptOpts,
  mdRoot: string
): Promise<TFile> {
  const body = buildBody(ctx, o);
  if (o.file) {
    await app.vault.modify(o.file, body);
    return o.file;
  }
  const folder = transcriptsFolder(ctx, mdRoot);
  await ensureFolder(app, folder);
  const stamp = moment().format("YYYY-MM-DD HHmm");
  const slug = slugify(firstUserText(o.turns));
  const short = o.sessionId.slice(0, 8);
  const path = `${folder}/${stamp} — ${slug} — ${short}.md`;
  return app.vault.create(path, body);
}

function buildBody(ctx: ChatContext, o: TranscriptOpts): string {
  const stem = stemOf(ctx.fileName);
  const anchor =
    ctx.scope === "selection"
      ? [
          // `pdf:` is kept alongside `source:` so existing transcripts and any Dataview queries
          // over them keep working unchanged.
          `pdf: "[[${ctx.fileName}]]"`,
          `page: ${ctx.page}`,
          `selection: "${ctx.selId}"`,
          `color: ${ctx.color}`,
        ]
      : ctx.kind === "pdf"
        ? [`pdf: "[[${ctx.fileName}]]"`]
        : [];
  const fm = [
    "---",
    "augmented-pdf: transcript",
    `scope: ${ctx.scope}`,
    `kind: ${ctx.kind}`,
    `source: "${sourceLink(ctx)}"`,
    `source-path: ${JSON.stringify(ctx.filePath)}`,
    ...anchor,
    `hub: "[[${o.hubBasename}]]"`,
    ...(ctx.litNote ? [`lit-note: "[[${ctx.litNote}]]"`] : []),
    ...(ctx.attachments?.length ? [`context: ${JSON.stringify(ctx.attachments)}`] : []),
    `session-id: ${o.sessionId}`,
    // `model:` stays the ALIAS (unchanged for the existing transcripts and any Dataview over them);
    // `model-id` records which concrete model actually answered, since the alias floats with releases.
    `model: ${o.model}`,
    ...(o.resolvedModel ? [`model-id: ${JSON.stringify(o.resolvedModel)}`] : []),
    // Sessions don't cross providers, so a reopened chat must know whose it is. Claude chats omit
    // the key (absent = claude), keeping every existing transcript's shape unchanged.
    ...(o.provider && o.provider !== "claude" ? [`provider: ${o.provider}`] : []),
    ...(o.providerSession ? [`provider-session: ${JSON.stringify(o.providerSession)}`] : []),
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
  ];
  if (ctx.scope === "selection") {
    parts.push(`> [!quote] Highlighted passage (p.${ctx.page})`, "> " + ctx.passage.replace(/\n/g, "\n> "), "");
  } else if (ctx.passage) {
    // A whole-file chat that started from selected text: the passage belongs to THIS chat (the hub
    // is per-file), so it's recorded here rather than on the hub.
    parts.push("> [!quote] Selected text", "> " + ctx.passage.replace(/\n/g, "\n> "), "");
  }
  if (ctx.attachments?.length) {
    parts.push(`**Context:** ${ctx.attachments.map((p) => `[[${p.replace(/\.md$/i, "")}]]`).join(" · ")}`, "");
  }
  parts.push(ctx.scope === "selection" ? `# Chat — ${stem}, p.${ctx.page}` : `# Chat — ${stem}`, "");
  if (o.summary) {
    parts.push("## Summary", o.summary, "");
  }
  for (const t of o.turns) {
    parts.push(`## ${t.role === "user" ? "You" : assistantName(o.provider)}`, t.text, "");
  }
  return parts.join("\n");
}

/** Who answered, for reply headings and chat bubbles. Claude stays "Claude" (every existing note). */
export function assistantName(provider?: string | null): string {
  return provider === "codex" ? "Codex" : provider === "gwdg" ? "GWDG" : "Claude";
}

function firstUserText(turns: Turn[]): string {
  return turns.find((t) => t.role === "user")?.text ?? "chat";
}

/** Parse the You/<assistant> turns back out of a transcript's markdown (for reloading a chat). */
export function parseTranscriptTurns(content: string): Turn[] {
  const turns: Turn[] = [];
  const heads = [...content.matchAll(/^##\s+(You|Claude|Codex|GWDG)\s*$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const role = heads[i][1] === "You" ? "user" : "claude";
    const start = (heads[i].index ?? 0) + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? content.length : content.length;
    const text = content.slice(start, end).trim();
    if (text) turns.push({ role, text });
  }
  return turns;
}
