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
