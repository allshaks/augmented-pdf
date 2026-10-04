import { App, TFile } from "obsidian";

/** A link to drop into a source note, next to a passage that was discussed in a chat. */
export interface PendingBacklink {
  sourcePath: string; // vault path of the note the passage lives in
  anchorText: string; // the passage text, used to relocate the insertion point
}

/**
 * The marker inserted next to a passage: a wikilink (so Obsidian's backlinks/graph pick it up)
 * labelled 💬 so it reads clearly as "the chat about this".
 *
 * No hidden tag is needed for idempotency: the transcript basename already carries the chat's unique
 * session id (e.g. "2026-07-17 1852 — … — 7fb0c544"), so the link itself distinguishes one chat from
 * another. (An earlier version appended an <!--apc-bl:id--> HTML comment; Obsidian's Live Preview
 * renders HTML comments as visible raw text, so it showed up next to the link — dropped.)
 */
export function backlinkMarker(transcriptBasename: string): string {
  return `[[${transcriptBasename}|💬 chat]]`;
}

/**
 * Insert `marker` at the END of the line containing the end of `anchorText`.
 *
 * Deliberately NOT at the selection boundary: the passage is left completely untouched (so an
 * existing `[[link]]` / `$math$` inside it can't be split — the exact conflict the feature must
 * avoid), and the marker sits at a guaranteed-safe boundary — the newline. Pure and idempotent:
 * a line that already carries this marker is returned unchanged.
 *
 * Relocation is by exact substring match. A source-view/live-preview selection is verbatim note
 * text, so it matches; a reading-view selection over inline-formatted text (rendered ≠ source) may
 * not, in which case nothing is inserted and the caller is told (inserted=false).
 */
export function insertBacklinkAtAnchor(
  content: string,
  anchorText: string,
  marker: string
): { content: string; inserted: boolean } {
  const anchor = anchorText.trim();
  if (!anchor) return { content, inserted: false };
  const idx = content.indexOf(anchor);
  if (idx < 0) return { content, inserted: false };

  const endOfMatch = idx + anchor.length;
  const nl = content.indexOf("\n", endOfMatch);
  const lineEnd = nl < 0 ? content.length : nl;
  const lineStart = content.lastIndexOf("\n", Math.max(0, endOfMatch - 1)) + 1;
  const line = content.slice(lineStart, lineEnd);
  if (line.includes(marker)) return { content, inserted: false }; // already linked → no-op

  return { content: content.slice(0, lineEnd) + " " + marker + content.slice(lineEnd), inserted: true };
}

/**
 * Write a backlink into `sourcePath` next to `anchorText`. Read-modify-write via vault.process so a
 * concurrent edit can't be clobbered. Returns whether a marker was actually inserted (false = anchor
 * not found, or already present, or the file isn't a writable markdown note).
 */
export async function writeBacklink(
  app: App,
  sourcePath: string,
  anchorText: string,
  marker: string
): Promise<boolean> {
  const f = app.vault.getAbstractFileByPath(sourcePath);
  if (!(f instanceof TFile) || f.extension !== "md") return false;
  let inserted = false;
  await app.vault.process(f, (content) => {
    const r = insertBacklinkAtAnchor(content, anchorText, marker);
    inserted = r.inserted;
    return r.content;
  });
  return inserted;
}
