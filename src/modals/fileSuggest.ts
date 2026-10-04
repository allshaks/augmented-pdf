import { App, FuzzyMatch, FuzzySuggestModal, TFile } from "obsidian";

/**
 * Fuzzy picker over the vault's notes and PDFs, for attaching a file to a chat as context (the "@"
 * mention). Searches on the full path, so "wiki/eps" narrows as well as "epsilon" does — which
 * matters here, because note basenames are not unique.
 */
export class FileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private onPick: (file: TFile) => void,
    private exclude: Set<string> = new Set()
  ) {
    super(app);
    this.setPlaceholder("Attach a file as context…");
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter((f) => (f.extension === "md" || f.extension === "pdf") && !this.exclude.has(f.path));
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, el: HTMLElement): void {
    const f = match.item;
    el.createDiv({ cls: "apc-suggest-title", text: f.basename });
    el.createEl("small", { cls: "apc-suggest-sub", text: f.path });
  }

  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}
