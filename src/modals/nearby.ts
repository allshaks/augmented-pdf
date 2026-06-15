import { App, Modal } from "obsidian";
import { NearbyHub } from "../store/hub";

export type NearbyChoice = "existing" | "new";

/**
 * Shown when a new selection overlaps an existing highlight (but isn't identical). Lets the user
 * fold the chat into the existing accumulating annotation instead of creating a near-duplicate.
 * Dismissing (Esc) defaults to "new" — never silently merges.
 */
export class NearbyHighlightModal extends Modal {
  private decided = false;

  constructor(app: App, private nearby: NearbyHub, private onChoice: (c: NearbyChoice) => void) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Nearby highlight found");
    const n = this.nearby.chatCount;
    contentEl.createEl("p", {
      text: `A highlight on page ${this.nearby.page} already has ${n} chat${n === 1 ? "" : "s"} and overlaps your selection:`,
    });
    contentEl.createEl("blockquote", {
      text: (this.nearby.passage || "(existing highlight)").slice(0, 240),
    });
    contentEl.createEl("p", { text: "Add this chat to that highlight, or start a new one?" });

    const btns = contentEl.createDiv({ cls: "modal-button-container" });
    btns.createEl("button", { cls: "mod-cta", text: "Add to existing" }).onclick = () => this.choose("existing");
    btns.createEl("button", { text: "New highlight" }).onclick = () => this.choose("new");
  }

  private choose(c: NearbyChoice): void {
    this.decided = true;
    this.onChoice(c);
    this.close();
  }

  onClose(): void {
    if (!this.decided) this.onChoice("new"); // dismissal = safe default
    this.contentEl.empty();
  }
}
