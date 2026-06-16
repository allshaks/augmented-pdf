import { App } from "obsidian";

export function stemOf(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, "");
}

export function dirOf(pdfPath: string): string {
  const i = pdfPath.lastIndexOf("/");
  return i >= 0 ? pdfPath.slice(0, i) : "";
}

export function annotationsFolder(pdfPath: string, pdfName: string): string {
  const d = dirOf(pdfPath);
  return (d ? d + "/" : "") + `${stemOf(pdfName)} (annotations)`;
}

export function chatsFolder(pdfPath: string, pdfName: string): string {
  const d = dirOf(pdfPath);
  return (d ? d + "/" : "") + `${stemOf(pdfName)} (chats)`;
}

/** Deterministic per-highlight key used as the hub filename prefix. Dots (not commas) for FS safety. */
export function hubKey(page: number, selId: string): string {
  return `p${page}-s${selId.replace(/,/g, ".")}`;
}

export async function ensureFolder(app: App, path: string): Promise<void> {
  if (!app.vault.getAbstractFileByPath(path)) {
    try {
      await app.vault.createFolder(path);
    } catch {
      /* already exists or race — fine */
    }
  }
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-")
      .slice(0, 40) || "chat"
  );
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Append `line` at the end of the `## <heading>` section, creating the section at EOF if absent.
 * Used by smart-paste to file colored links under per-category headings in the literature note.
 */
export function appendUnderHeading(content: string, heading: string, line: string): string {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^##[ \\t]+${esc}[ \\t]*$`, "m").exec(content);
  if (!m) {
    return content.replace(/[ \t\r\n]*$/, "") + `\n\n## ${heading}\n${line}\n`;
  }
  const afterHeading = m.index + m[0].length;
  const rest = content.slice(afterHeading);
  const nextRel = rest.search(/^#{1,6}[ \t]+/m); // next heading of any level
  const insertAt = nextRel >= 0 ? afterHeading + nextRel : content.length;
  const head = content.slice(0, insertAt).replace(/[ \t\r\n]*$/, "");
  const tail = content.slice(insertAt);
  return head + `\n${line}\n` + (tail ? "\n" + tail.replace(/^[ \t\r\n]+/, "") : "");
}

/** Pull the passage text out of a `> [!quote] …` callout (hub or transcript body). */
export function extractQuotePassage(content: string): string {
  const m = content.match(/> \[!quote\][^\n]*\n((?:>.*\n?)+)/);
  if (!m) return "";
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n")
    .trim();
}
