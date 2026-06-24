import { App, FuzzyMatch, FuzzySuggestModal, TFile, moment } from "obsidian";

export interface ChatPickerEntry {
  file: TFile;
  /** Source paper (PDF stem) for display/search, or "" for a context-free/general chat. */
  paper: string;
  /** Human label — the opening question (falls back to the summary, then the filename). */
  label: string;
  /** Epoch ms, for newest-first ordering and the subtitle. */
  created: number;
}

/**
 * Vault-wide "open a previous chat" picker. The in-header "Chats ▾" menu lists only the CURRENT
 * paper's chats (and needs a paper context to exist), so from the empty/default panel there's no way
 * to reach a saved chat. This modal lists every transcript across the vault, searchable by paper or
 * opening question, so a previous chat is always reachable.
 *
 * Entries are precomputed (labels need async file reads) and handed in, because FuzzySuggestModal's
 * getItems() is synchronous.
 */
export class AllChatsModal extends FuzzySuggestModal<ChatPickerEntry> {
  constructor(
    app: App,
    private entries: ChatPickerEntry[],
    private onPick: (entry: ChatPickerEntry) => void
  ) {
    super(app);
    this.setPlaceholder("Search saved chats by paper or question…");
  }

  getItems(): ChatPickerEntry[] {
    return this.entries;
  }

  /** Fuzzy search matches on either the paper name or the question. */
  getItemText(e: ChatPickerEntry): string {
    return `${e.paper} ${e.label}`;
  }

  renderSuggestion(match: FuzzyMatch<ChatPickerEntry>, el: HTMLElement): void {
    const e = match.item;
    el.createDiv({ cls: "apc-suggest-title", text: e.label || "(chat)" });
    const when = e.created ? moment(e.created).format("YYYY-MM-DD HH:mm") : "";
    const sub = [e.paper || "General chat", when].filter(Boolean).join(" · ");
    el.createEl("small", { cls: "apc-suggest-sub", text: sub });
  }

  onChooseItem(e: ChatPickerEntry): void {
    this.onPick(e);
  }
}
