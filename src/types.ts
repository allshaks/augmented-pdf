export interface ChatContext {
  pdfName: string; // e.g. "Attention Is All You Need.pdf"
  pdfPath: string; // vault-relative path to the PDF
  page: number;
  selId: string; // "beginIndex,beginOffset,endIndex,endOffset"
  color: string;
  passage: string;
  /** Basename of the sibling Zotero/literature note ({stem}.md), if found, for cross-linking. */
  litNote?: string;
}

export interface Turn {
  role: "user" | "claude";
  text: string;
  costUsd?: number;
}

/**
 * Reasoning-effort choices for the chat. "default" means omit --effort (use the CLI's own default);
 * the rest map directly to `claude --effort <level>`.
 */
export const EFFORT_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
