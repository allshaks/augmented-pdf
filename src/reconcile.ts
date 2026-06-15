import { Notice, TFile } from "obsidian";
import type AugmentedPdfPlugin from "./main";
import { appendChatEntry, updateEntrySummary } from "./store/hub";
import { summarizeConversation } from "./summary";
import { oneLine } from "./store/paths";

/**
 * Recover from interrupted persistence: transcripts whose hub lost (or never got) its "## Chats"
 * entry, and entries whose summary is still pending (app closed before the deferred summary ran, or
 * the summary call failed). Cheap parts (re-append) always run; the API part (regenerate summaries)
 * is gated behind `generateSummaries` so startup never silently spends.
 */

interface TranscriptInfo {
  file: TFile;
  sessionId: string;
  hub: TFile | null;
  hasEntry: boolean;
  pendingSummary: boolean;
}

function stripBrackets(v: unknown): string {
  return String(v ?? "").replace(/^\[\[|\]\]$/g, "").trim();
}

function collectTranscripts(plugin: AugmentedPdfPlugin): TranscriptInfo[] {
  const { app } = plugin;
  const infos: TranscriptInfo[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm["augmented-pdf"] !== "transcript") continue;
    const sessionId = String(fm["session-id"] ?? "");
    if (!sessionId) continue;
    const hub = app.metadataCache.getFirstLinkpathDest(stripBrackets(fm.hub), file.path);
    const pendingSummary = !fm.summary || String(fm.summary).trim() === "";
    infos.push({ file, sessionId, hub, hasEntry: false, pendingSummary });
  }
  return infos;
}

/** Quick, no-API scan for the startup nudge. */
export async function countReconcileWork(plugin: AugmentedPdfPlugin): Promise<{ missing: number; pending: number }> {
  let missing = 0;
  let pending = 0;
  for (const info of collectTranscripts(plugin)) {
    if (info.hub) {
      const content = await plugin.app.vault.cachedRead(info.hub);
      if (!content.includes(`<!--apc:${info.sessionId}-->`)) missing++;
    }
    if (info.pendingSummary) pending++;
  }
  return { missing, pending };
}

export async function reconcileAnnotations(
  plugin: AugmentedPdfPlugin,
  opts: { generateSummaries: boolean }
): Promise<void> {
  const { app } = plugin;
  const infos = collectTranscripts(plugin);
  let reAppended = 0;
  let summarized = 0;

  for (const info of infos) {
    if (!info.hub) continue;
    const hubContent = await app.vault.cachedRead(info.hub);

    // 1) Re-append a missing hub entry (cheap, no API).
    if (!hubContent.includes(`<!--apc:${info.sessionId}-->`)) {
      const fm = app.metadataCache.getFileCache(info.file)?.frontmatter;
      const title = oneLine(firstUserLine(await app.vault.cachedRead(info.file))).slice(0, 80) || "Chat";
      await appendChatEntry(app, info.hub, {
        anchorId: info.sessionId,
        title,
        transcriptBasename: info.file.basename,
      });
      const existingSummary = fm?.summary ? String(fm.summary).trim() : "";
      if (existingSummary) await updateEntrySummary(app, info.hub, info.sessionId, existingSummary);
      reAppended++;
    }

    // 2) Fill a pending summary (costs an API call — gated).
    if (opts.generateSummaries && info.pendingSummary) {
      const body = await app.vault.read(info.file);
      const convo = conversationText(body);
      if (convo) {
        const summary = await summarizeConversation(plugin, convo);
        if (summary) {
          await updateEntrySummary(app, info.hub, info.sessionId, summary);
          await app.vault.process(info.file, (c) => setFrontmatterSummary(c, summary));
          summarized++;
        }
      }
    }
  }

  new Notice(
    `Augmented PDF reconcile: re-linked ${reAppended} chat${reAppended === 1 ? "" : "s"}` +
      (opts.generateSummaries ? `, summarized ${summarized}` : "") +
      ".",
    6000
  );
}

function firstUserLine(transcript: string): string {
  const m = transcript.match(/^##\s+You\s*\n([^\n]+)/m);
  return m ? m[1] : "";
}

/** Extract the conversation (everything from the first "## You" heading). */
function conversationText(transcript: string): string {
  const i = transcript.search(/^##\s+You\s*$/m);
  return i >= 0 ? transcript.slice(i).trim() : "";
}

function setFrontmatterSummary(content: string, summary: string): string {
  const val = JSON.stringify(oneLine(summary));
  if (/^summary:.*$/m.test(content)) return content.replace(/^summary:.*$/m, `summary: ${val}`);
  // no summary key — insert before closing frontmatter fence
  return content.replace(/^---\s*$/m, `---`).replace(/\n---\s*\n/, `\nsummary: ${val}\n---\n`);
}
