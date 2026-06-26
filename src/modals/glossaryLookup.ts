import { App, Component, MarkdownRenderer, Modal, Notice, TAbstractFile, TFile } from "obsidian";
import { GlossaryEntry, normalizeKey, readGlossary, upsertEntry, writeGlossary } from "../store/glossary";
import { glossaryPath } from "../store/paths";
import { defineTermWithClaude } from "../glossaryGen";
import { toObsidianMath } from "../format";
import type AugmentedPdfPlugin from "../main";

/** How many matching rows we render at once (navigation is clamped to this too). */
const ROW_CAP = 100;

const SOURCE_BADGE: Record<string, string> = {
  paper: "📄 paper",
  general: "🧠 general",
  reference: "↗ reference",
  web: "🌐 web",
  user: "✍️ yours",
};

/**
 * Glossary lookup: hotkey → type → definition appears. A custom Modal (NOT FuzzySuggestModal, which
 * is text-only/synchronous and can't render the markdown/LaTeX definition while you type). On open it
 * reads + parses the glossary ONCE, then filters synchronously per keystroke. A miss offers the two
 * fallbacks: write your own (offline, free) or ask Claude (read-only, one term).
 *
 * Writes are read-modify-write (persist() re-reads disk and merges) and the modal live-refreshes on
 * any on-disk change, so a concurrent background build can never be clobbered and the view never works
 * from a stale snapshot.
 */
export class GlossaryLookupModal extends Modal {
  private readonly comp = new Component();
  /** Per-render child component, so each redraw releases the previous definition's render children. */
  private defComp?: Component;
  private terms: GlossaryEntry[] = [];
  private filtered: GlossaryEntry[] = [];
  private selected = 0;
  private loaded = false;
  /** True while the write-your-own editor is open, so a disk refresh doesn't wipe in-progress typing. */
  private editing = false;
  /** True while an "Ask Claude" call is in flight, to prevent overlapping calls. */
  private busy = false;
  private activeCancel: (() => void) | null = null;

  private inputEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private defEl!: HTMLElement;

  constructor(app: App, private plugin: AugmentedPdfPlugin, private pdfFile: TFile) {
    super(app);
  }

  async onOpen(): Promise<void> {
    this.comp.load();
    this.modalEl.addClass("apc-gloss-modal");
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: "apc-gloss-src", text: `Glossary · ${this.pdfFile.basename}` });
    this.inputEl = contentEl.createEl("input", {
      cls: "apc-gloss-input",
      attr: { type: "text", placeholder: "Look up a term…" },
    });
    const body = contentEl.createDiv({ cls: "apc-gloss-body" });
    this.listEl = body.createDiv({ cls: "apc-gloss-list" });
    this.defEl = body.createDiv({ cls: "apc-gloss-def" });

    this.inputEl.addEventListener("input", () => this.applyFilter());
    this.inputEl.addEventListener("keydown", (e) => this.onKey(e));

    this.defEl.setText("Loading glossary…");
    const g = await readGlossary(this.app, this.pdfFile.path, this.pdfFile.name);
    this.terms = g?.terms ?? [];
    this.loaded = true;

    // Live-refresh when the glossary file changes on disk (a background build finishing, another modal
    // saving, external sync) so the open modal never reads from — or writes over — a stale snapshot.
    const gpath = glossaryPath(this.pdfFile.path, this.pdfFile.name);
    const onChange = (f: TAbstractFile) => {
      if (f.path === gpath) void this.reload();
    };
    this.comp.registerEvent(this.app.vault.on("modify", onChange));
    this.comp.registerEvent(this.app.vault.on("create", onChange));

    this.applyFilter();
    this.inputEl.focus();
  }

  onClose(): void {
    try {
      this.activeCancel?.();
    } catch {
      /* ignore */
    }
    this.comp.unload(); // unloads registered events + the def render child component
    this.contentEl.empty();
  }

  /** Re-read the glossary from disk into memory (and re-render unless the user is mid-edit). */
  private async reload(): Promise<void> {
    const g = await readGlossary(this.app, this.pdfFile.path, this.pdfFile.name);
    this.terms = g?.terms ?? [];
    if (!this.editing) this.applyFilter();
  }

  // ---- filtering -----------------------------------------------------------

  private applyFilter(): void {
    const q = this.inputEl.value.trim();
    if (!q) {
      this.filtered = this.terms.slice().sort((a, b) => a.term.localeCompare(b.term));
    } else {
      const nq = normalizeKey(q);
      const scored: { e: GlossaryEntry; score: number }[] = [];
      for (const e of this.terms) {
        let score = 0;
        for (const k of [e.term, ...e.aliases].map(normalizeKey)) {
          if (!k) continue;
          if (k === nq) score = Math.max(score, 4);
          else if (k.startsWith(nq)) score = Math.max(score, 3);
          else if (k.includes(nq)) score = Math.max(score, 2);
        }
        if (score) scored.push({ e, score });
      }
      scored.sort((a, b) => b.score - a.score || a.e.term.localeCompare(b.e.term));
      this.filtered = scored.map((s) => s.e);
    }
    this.selected = 0;
    this.renderList();
    void this.renderDef();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const n = Math.min(this.filtered.length, ROW_CAP);
    if (!n) return;
    this.selected = e.key === "ArrowDown" ? (this.selected + 1) % n : (this.selected - 1 + n) % n;
    this.renderList();
    void this.renderDef();
  }

  // ---- rendering -----------------------------------------------------------

  private renderList(): void {
    this.listEl.empty();
    if (!this.loaded) return;
    this.filtered.slice(0, ROW_CAP).forEach((e, i) => {
      const row = this.listEl.createDiv({ cls: "apc-gloss-row" });
      if (i === this.selected) row.addClass("is-selected");
      row.createSpan({ cls: "apc-gloss-row-term", text: e.term });
      row.createSpan({ cls: "apc-gloss-badge", text: SOURCE_BADGE[e.source] ?? e.source });
      row.onclick = () => {
        this.selected = i;
        this.renderList();
        void this.renderDef();
        this.inputEl.focus();
      };
      if (i === this.selected) row.scrollIntoView({ block: "nearest" });
    });
    if (this.filtered.length > ROW_CAP) {
      this.listEl.createDiv({ cls: "apc-gloss-more", text: `…and ${this.filtered.length - ROW_CAP} more — keep typing` });
    }
  }

  private async renderDef(): Promise<void> {
    if (!this.loaded) return;
    this.defComp?.unload();
    this.defComp = undefined;
    this.defEl.empty();
    const q = this.inputEl.value.trim();

    // Empty glossary + empty query → offer to build (the "build on first lookup" path).
    if (!this.terms.length && !q) {
      this.defEl.createDiv({ cls: "apc-gloss-empty", text: "No glossary for this PDF yet." });
      const row = this.defEl.createDiv({ cls: "apc-gloss-actions" });
      const build = row.createEl("button", { cls: "mod-cta", text: "Build glossary (Claude reads the PDF)" });
      build.onclick = () => {
        void this.plugin.runGlossaryBuild(this.pdfFile);
        this.defEl.empty();
        this.defEl.createDiv({
          cls: "apc-gloss-empty",
          text: "Building in the background — this list refreshes automatically when it's done. You can keep reading meanwhile.",
        });
      };
      this.defEl.createDiv({ cls: "apc-gloss-hint", text: "Or just type a term and add it yourself." });
      return;
    }

    const entry = this.filtered[this.selected];
    if (!entry) {
      this.defEl.createDiv({ cls: "apc-gloss-empty", text: q ? `No entry for “${q}”.` : "No matching terms." });
      if (q) this.renderActions(q, "");
      return;
    }

    this.defEl.createEl("div", { cls: "apc-gloss-def-term", text: entry.term });
    this.defEl.createDiv({ cls: "apc-gloss-prov", text: this.provenance(entry) });

    if (entry.definition) {
      const pane = this.defEl.createDiv({ cls: "apc-gloss-def-body" });
      this.defComp = new Component();
      this.comp.addChild(this.defComp);
      try {
        await MarkdownRenderer.render(this.app, toObsidianMath(entry.definition), pane, this.pdfFile.path, this.defComp);
      } catch {
        pane.setText(entry.definition);
      }
    } else {
      this.defEl.createDiv({
        cls: "apc-gloss-hint",
        text: entry.reference ? `Defined in ${entry.reference} — not fetched yet.` : "No definition stored yet.",
      });
    }
    this.renderActions(entry.term, entry.definition);
  }

  private provenance(e: GlossaryEntry): string {
    const parts: string[] = [SOURCE_BADGE[e.source] ?? e.source];
    if (e.page) parts.push(`p.${e.page}`);
    if (e.reference) parts.push(e.reference);
    if (e.sourceUrl) parts.push(e.sourceUrl);
    return parts.join(" · ");
  }

  private renderActions(term: string, existingDef: string): void {
    const row = this.defEl.createDiv({ cls: "apc-gloss-actions" });
    const own = row.createEl("button", { text: existingDef ? "✍️ Edit / write your own" : "✍️ Write your own" });
    own.onclick = () => this.showWriteOwn(term, existingDef);
    const ask = row.createEl("button", { text: "✨ Ask Claude" });
    ask.onclick = () => void this.askClaude(term);
  }

  // ---- the two fallbacks ---------------------------------------------------

  private showWriteOwn(term: string, existingDef: string): void {
    this.editing = true;
    this.defComp?.unload();
    this.defComp = undefined;
    this.defEl.empty();
    this.defEl.createEl("div", { cls: "apc-gloss-def-term", text: term });
    const ta = this.defEl.createEl("textarea", { cls: "apc-gloss-editor" });
    ta.value = existingDef;
    ta.placeholder = "Type the definition (markdown & $LaTeX$ supported)…";
    const row = this.defEl.createDiv({ cls: "apc-gloss-actions" });
    const save = row.createEl("button", { cls: "mod-cta", text: "Save" });
    const cancel = row.createEl("button", { text: "Cancel" });
    save.onclick = async () => {
      const def = ta.value.trim();
      if (!def) {
        new Notice("Definition is empty.");
        return;
      }
      this.editing = false;
      const ok = await this.persist({ term, aliases: [], definition: def, page: null, source: "user", reference: null });
      if (ok) {
        this.inputEl.value = term;
        this.applyFilter();
        this.inputEl.focus();
      }
    };
    cancel.onclick = () => {
      this.editing = false;
      this.applyFilter();
      this.inputEl.focus();
    };
    ta.focus();
  }

  private async askClaude(term: string): Promise<void> {
    if (this.busy) {
      new Notice("Already defining a term — wait for it to finish.");
      return;
    }
    this.busy = true;
    this.defComp?.unload();
    this.defComp = undefined;
    this.defEl.empty();
    this.defEl.createEl("div", { cls: "apc-gloss-def-term", text: term });
    const status = this.defEl.createDiv({ cls: "apc-gloss-hint", text: "Asking Claude to define this from the paper…" });
    const run = defineTermWithClaude(this.plugin, this.pdfFile.path, term);
    this.activeCancel = run.cancel;
    let res;
    try {
      res = await run.promise;
    } finally {
      this.activeCancel = null;
      this.busy = false;
    }
    const stillShowing = status.isConnected; // did the user navigate away during the await?
    if (!res.entry) {
      if (stillShowing) {
        status.setText(`Couldn't define it: ${res.error ?? "no result"}.`);
        this.renderActions(term, "");
      }
      return;
    }
    // Always save the fetched definition (even if the user moved on), but only hijack the view if
    // they're still looking at this term.
    const ok = await this.persist(res.entry);
    if (ok && stillShowing) {
      this.inputEl.value = res.entry.term;
      this.applyFilter();
      this.inputEl.focus();
    }
  }

  /**
   * Read-modify-write: re-read the glossary from disk, upsert the entry, and persist — so a save can
   * never clobber terms written by a concurrent build (the open-time snapshot is never the base).
   */
  private async persist(entry: GlossaryEntry): Promise<boolean> {
    try {
      const cur = await readGlossary(this.app, this.pdfFile.path, this.pdfFile.name);
      const merged = upsertEntry(cur?.terms ?? this.terms, entry);
      await writeGlossary(this.app, this.pdfFile.path, this.pdfFile.name, merged, {
        model: this.plugin.settings.glossaryModel || "sonnet",
        builtAt: new Date().toISOString(),
      });
      this.terms = merged;
      return true;
    } catch (e) {
      new Notice("Couldn't save the glossary (see console).");
      console.error("[augmented-pdf] writeGlossary failed", e);
      return false;
    }
  }
}
