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
