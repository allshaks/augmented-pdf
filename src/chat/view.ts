import { ItemView, MarkdownRenderer, Menu, Notice, TFile, WorkspaceLeaf, moment } from "obsidian";
import { AiMessage, AiRunHandle } from "../ai/provider";
import { ChatContext, EFFORT_LEVELS, MODEL_CHOICES, Turn } from "../types";
import { appendChatEntry, findHub, findOrCreateHub, readPriorSummaries, updateEntrySummary } from "../store/hub";
import { writeTranscript } from "../store/transcript";
import { PendingBacklink, backlinkMarker, writeBacklink } from "../store/backlink";
import { generateSummary } from "../summary";
import { oneLine, stemOf } from "../store/paths";
import { toObsidianMath } from "../format";
import { MAX_ATTACHMENTS, buildAttachmentsBlock, buildSourceBlock } from "./context";
import { FileSuggestModal } from "../modals/fileSuggest";
import type AugmentedPdfPlugin from "../main";

export const CHAT_VIEW_TYPE = "augmented-pdf-chat";

const SUMMARY_IDLE_MS = 15000;

/** Friendly present-tense label for a tool the model is running mid-stream. */
function toolVerb(name?: string): string {
  switch (name) {
    case "Read":
      return "Reading…";
    case "Grep":
    case "Glob":
      return "Searching…";
    case "Write":
      return "Writing…";
    case "Edit":
    case "MultiEdit":
      return "Editing…";
    case "Bash":
      return "Running command…";
    case "Skill":
      return "Running skill…";
    case "Task":
      return "Working…";
    case "TodoWrite":
      return "Planning…";
    case "WebFetch":
    case "WebSearch":
      return "Searching the web…";
    default:
      return name ? `Running ${name}…` : "Working…";
  }
}

/**
 * Turn a CLI error into advice the user can act on. "Try again" is right for an overloaded API but
 * actively wrong for an expired login — the CLI already retried (up to 10x) and no amount of
 * retrying will re-authenticate. Exported for testing.
 */
export function errorAdvice(detail: string): string {
  const d = detail.toLowerCase();
  if (/oauth|authentication_error|401|re-authenticate|failed to authenticate/.test(d)) {
    return (
      "Your Claude CLI login has expired. Run `claude login` in a terminal, then send this message " +
      "again — retrying here won't help until you do."
    );
  }
  if (/credit balance|insufficient/.test(d)) {
    return "Your Claude account is out of credit. Top up (or enable usage credits) and try again.";
  }
  if (/enoent|not found|spawn/.test(d)) {
    return "The `claude` binary couldn't be run — check the Claude CLI path in Augmented PDF settings.";
  }
  if (/overloaded|529|rate.?limit|timeout|econnreset|network|fetch failed/.test(d)) {
    return "Usually transient (busy or a network blip) — try again in a moment.";
  }
  return "See the developer console for the full error envelope.";
}

/** Refs captured per-thread so async work survives the thread being reset. */
interface ThreadRefs {
  ctx: ChatContext;
  sessionId: string;
  model: string;
  resolvedModel: string | null;
  turns: Turn[];
  totalCost: number;
  hub: TFile;
  transcript: TFile;
  createdISO: string;
}

/**
 * A single streaming reply, with ALL the state needed to finish and save itself. This is what
 * makes "start a new chat while another is thinking" work: when the panel switches, the in-flight
 * Generation is detached (keeps running) and persists to its own note on completion, independent
 * of the view's now-reset state.
 */
interface Generation {
  ctx: ChatContext | null;
  sessionId: string;
  model: string;
  resolvedModel: string | null; // concrete model the alias resolved to, from the CLI's init event
  turns: Turn[]; // shared ref with this.turns at send() time
  totalCost: number;
  hubFile: TFile | null;
  transcriptFile: TFile | null;
  createdISO: string | null;
  entryAppended: boolean;
  summary: string | null; // last known thread summary (preserved across transcript rewrites)
  child: AiRunHandle | null;
  ticker: number | null;
  indicator: HTMLElement | null;
  detached: boolean;
  pendingBacklinks: PendingBacklink[]; // "link back to this chat" marks to write once the transcript exists
}

export class ChatView extends ItemView {
  plugin: AugmentedPdfPlugin;

  private ctx: ChatContext | null = null;
  private sessionId: string | null = null;
  private turnCount = 0;
  private totalCost = 0;
  private turns: Turn[] = [];
  private model: string;
  /** Concrete model the alias resolved to this thread (from the CLI's init event); null until known. */
  private resolvedModel: string | null = null;
  private effort: string; // session reasoning effort (toolbar); "default" => omit --effort
  private child: AiRunHandle | null = null;

  // persistence state
  private hubFile: TFile | null = null;
  private transcriptFile: TFile | null = null;
  private createdISO: string | null = null;
  private threadSummary: string | null = null;
  private entryAppended = false;
  private summarizedTurnCount = 0;
  private summaryTimer: number | null = null;
  private priorContext = "";
  /** The currently-attached streaming reply (null between turns). Detached gens finish on their own. */
  private activeGen: Generation | null = null;
  /** Live, SESSION-scoped skill posture (initialized from the persisted default). The toolbar
   * checkbox flips this only; it does NOT persist, so enabling skills for one run never silently
   * arms bypassPermissions for future chats. The settings tab sets the persisted default. */
  private skillsEnabled = false;
  /** Live, SESSION-scoped web posture (initialized from the persisted default). Pre-approves the
   * read-only WebSearch/WebFetch tools so the model can look things up online. The toolbar checkbox
   * flips this only; it does NOT persist. The settings tab sets the persisted default. */
  private webEnabled = false;
  /** True only for an explicitly-started context-free chat (so the empty panel isn't mislabeled). */
  private generalChat = false;
  /** Vault paths of files @-attached to THIS thread, inlined into the prompt and saved with it. */
  private attachments: string[] = [];
  /** Selection snapshotted on mousedown, before the click could collapse it. See captureSelectionOnMousedown. */
  private pendingSelection = "";
  /** Backlinks to drop into source notes once this thread has a saved transcript. See store/backlink.ts. */
  private pendingBacklinks: PendingBacklink[] = [];
  /** Set once the view is closed, so a backgrounded reply's completion never writes to dead DOM. */
  private closed = false;
  /** Auto-scroll only while pinned to the bottom; cleared when the user scrolls up (so streaming
   *  doesn't yank them back down), restored when they scroll back to the bottom. */
  private stickToBottom = true;

  // DOM
  private headerEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelSelect!: HTMLSelectElement;
  private skillsToggle!: HTMLInputElement;
  private webToggle!: HTMLInputElement;
  private chipsEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: AugmentedPdfPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.model = plugin.settings.model;
    this.effort = plugin.settings.effort;
    this.skillsEnabled = plugin.settings.allowSkills; // session starts at the persisted default
    this.webEnabled = plugin.settings.allowWeb; // ditto for web access
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Ask Claude";
  }
  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.render();
  }
  async onClose(): Promise<void> {
    this.closed = true;
    // Detach an in-flight reply so it finishes + saves in the background even after the panel closes;
    // otherwise summarize the (idle) thread before leaving.
    this.prepareSwitch();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("augmented-pdf-chat");

    this.headerEl = root.createDiv({ cls: "apc-header" });

    const toolbar = root.createDiv({ cls: "apc-toolbar" });
    toolbar.createSpan({ cls: "apc-toolbar-label", text: "Model" });
    this.modelSelect = toolbar.createEl("select", { cls: "dropdown apc-model" });
    for (const m of MODEL_CHOICES) {
      const o = this.modelSelect.createEl("option", { text: m, value: m });
      if (m === this.model) o.selected = true;
    }
    this.modelSelect.onchange = () => {
      this.model = this.modelSelect.value;
    };

    toolbar.createSpan({ cls: "apc-toolbar-label", text: "Effort" });
    const effortSelect = toolbar.createEl("select", { cls: "dropdown apc-effort" });
    for (const lvl of EFFORT_LEVELS) {
      const o = effortSelect.createEl("option", { text: lvl, value: lvl });
      if (lvl === this.effort) o.selected = true;
    }
    effortSelect.onchange = () => {
      this.effort = effortSelect.value;
    };

    // Session-scoped quick toggle: flips write-access for THIS chat only (does not persist).
    // The persisted default lives in settings; here we just override it for the session.
    const skillsLabel = toolbar.createEl("label", { cls: "apc-skills-toggle" });
    skillsLabel.setAttr(
      "title",
      "Let vault skills write files & run commands for THIS chat (bypassPermissions). " +
        "Session-only — resets to the settings default next time. Off = read-only."
    );
    this.skillsToggle = skillsLabel.createEl("input", { type: "checkbox" });
    this.skillsToggle.checked = this.skillsEnabled;
    skillsLabel.createSpan({ text: "Skills" });
    this.skillsToggle.onchange = () => {
      this.skillsEnabled = this.skillsToggle.checked;
      this.renderHeader();
    };

    // Session-scoped quick toggle: lets the model search the web for THIS chat only (does not persist).
    // Read-only — pre-approves WebSearch/WebFetch without unlocking writes/shell (that's "Skills").
    const webLabel = toolbar.createEl("label", { cls: "apc-skills-toggle" });
    webLabel.setAttr(
      "title",
      "Let the model search the web & fetch URLs for THIS chat (read-only). " +
        "Session-only — resets to the settings default next time. Off = no internet access."
    );
    this.webToggle = webLabel.createEl("input", { type: "checkbox" });
    this.webToggle.checked = this.webEnabled;
    webLabel.createSpan({ text: "Web" });
    this.webToggle.onchange = () => {
      this.webEnabled = this.webToggle.checked;
    };

    // Skills/Web are Claude-CLI-only — disable the toggles when GWDG is the active provider.
    if (this.plugin.settings.aiProvider !== "claude") {
      this.skillsToggle.disabled = true;
      this.webToggle.disabled = true;
      skillsLabel.setAttr("title", "Vault skills require the Claude CLI provider (Settings → AI provider).");
      webLabel.setAttr("title", "Web access requires the Claude CLI provider (Settings → AI provider).");
    }

    // Pull the text selected in the open note/PDF into the message box as a quote.
    const quoteBtn = toolbar.createEl("button", { cls: "apc-quote-btn", text: "❝ Selection" });
    quoteBtn.setAttr("title", "Add the text selected in the open note or PDF to your message");
    this.captureSelectionOnMousedown(quoteBtn);
    quoteBtn.onclick = () => void this.plugin.addSelectionToChat(this.takePendingSelection());

    // Points the new chat at whatever file is open (PDF or note) — no selection required. Falls back
    // to a context-free chat when nothing suitable is open.
    const newBtn = toolbar.createEl("button", { cls: "apc-new", text: "New chat" });
    newBtn.setAttr("title", "Start a chat about the file currently open (or the selection in it)");
    this.captureSelectionOnMousedown(newBtn);
    newBtn.onclick = () => void this.plugin.newChatForActiveFile(this.takePendingSelection());

    // Vault-wide picker — reachable from any state, so a previous chat can be reopened even from the
    // empty/default panel (the in-header "Chats ▾" only lists the current paper's chats).
    const openBtn = toolbar.createEl("button", { cls: "apc-open", text: "Open chat" });
    openBtn.setAttr("title", "Open a saved chat from any paper");
    openBtn.onclick = () => void this.plugin.openChatPicker();

    this.messagesEl = root.createDiv({ cls: "apc-messages" });
    // Track whether the user is pinned to the bottom. This fires on programmatic scrolls too (which
    // land at the bottom → stays pinned) and on user scrolls (scrolling up unpins → streaming stops
    // yanking them down; scrolling back to the bottom re-pins).
    this.registerDomEvent(this.messagesEl, "scroll", () => {
      this.stickToBottom = this.isNearBottom();
    });

    const inputRow = root.createDiv({ cls: "apc-input-row" });
    this.chipsEl = inputRow.createDiv({ cls: "apc-chips" });
    this.renderChips();
    this.inputEl = inputRow.createEl("textarea", {
      cls: "apc-input",
      attr: {
        rows: "1",
        placeholder: "Ask about this file…  (Enter to send · Shift+Enter = newline · @ to attach a file)",
      },
    });
    this.inputEl.addEventListener("input", () => this.autoGrowInput());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
        return;
      }
      // "@" opens the file picker. Only at a word boundary, so an email address or a decorator typed
      // mid-word doesn't hijack the keystroke.
      if (e.key === "@" && this.atWordBoundary()) {
        e.preventDefault();
        this.promptForAttachment();
      }
    });
    const btns = inputRow.createDiv({ cls: "apc-buttons" });
    this.sendBtn = btns.createEl("button", { cls: "mod-cta apc-send", text: "Send" });
    this.sendBtn.onclick = () => void this.send();
    this.stopBtn = btns.createEl("button", { cls: "apc-stop", text: "Stop" });
    this.stopBtn.onclick = () => this.stop();
    this.stopBtn.hide();

    this.statusEl = root.createDiv({ cls: "apc-status" });

    this.renderHeader();
  }

  private renderHeader(): void {
    this.headerEl.empty();
    if (!this.ctx) {
      // Explicitly-started general chat vs. the initial empty panel (don't infer from sessionId,
      // which resetThread always sets — that would mislabel a freshly-cleared empty panel).
      if (this.generalChat) {
        this.headerEl.createDiv({ cls: "apc-src", text: "General chat · vault skills" });
        this.headerEl.createDiv({
          cls: "apc-prior",
          text: this.skillsEnabled
            ? "⚡ Skills on — writes & shell commands enabled; treat all prompt/skill input as trusted. (Not saved to a note.)"
            : "Read-only — tick “Skills” above to let skills write to the vault. (Not saved to a note.)",
        });
        return;
      }
      this.headerEl.createDiv({
        cls: "apc-empty",
        text: "Open a PDF or a note and hit “New chat” — the chat follows whatever file is open, and a selection is optional. You can also reopen a saved chat with “Open chat” above.",
      });
      return;
    }
    const srcRow = this.headerEl.createDiv({ cls: "apc-src-row" });
    const label =
      this.ctx.scope === "selection"
        ? `${this.ctx.fileName} · p.${this.ctx.page}`
        : `${stemOf(this.ctx.fileName)} · whole ${this.ctx.kind === "pdf" ? "document" : "note"}`;
    srcRow.createDiv({ cls: "apc-src", text: label });
    const picker = srcRow.createEl("button", { cls: "apc-chats-btn", text: "Chats ▾" });
    picker.setAttr("title", "Open another chat saved for this file");
    picker.onclick = (evt) => void this.showChatPicker(evt);
    // A whole-file chat has a quote only when the user happened to start it from a selection.
    if (this.ctx.passage) this.headerEl.createEl("blockquote", { cls: "apc-quote", text: this.ctx.passage });
    if (this.skillsEnabled) {
      // On-state cue on the higher-risk path: a malicious PDF's text is in this prompt.
      this.headerEl.createDiv({
        cls: "apc-skills-on",
        text: "⚡ Skills on — this chat can write files & run commands.",
      });
    }
    if (this.priorContext) {
      const n = (this.priorContext.match(/^### /gm) ?? []).length;
      const what =
        this.ctx.scope === "selection" ? "this highlight" : this.ctx.kind === "pdf" ? "this document" : "this note";
      this.headerEl.createDiv({
        cls: "apc-prior",
        text: `${n} previous chat${n === 1 ? "" : "s"} on ${what} — context included.`,
      });
    }
  }

  /**
   * Read the note/PDF selection on mousedown and stash it.
   *
   * Clicking a sidebar button collapses the DOM selection in the pane the user was reading, and it
   * also makes the sidebar the active leaf — so by the time `click` fires, a reading-view selection
   * is already gone. `mousedown` fires before both, so it's the last moment the selection still
   * exists. (In source/live-preview CodeMirror keeps its selection either way; this is what rescues
   * reading view and PDFs.)
   */
  private captureSelectionOnMousedown(btn: HTMLElement): void {
    this.registerDomEvent(btn, "mousedown", () => {
      this.pendingSelection = this.plugin.currentSelectionText();
    });
  }

  /** Consume the mousedown snapshot, falling back to a live read (e.g. keyboard activation). */
  private takePendingSelection(): string {
    const s = this.pendingSelection || this.plugin.currentSelectionText();
    this.pendingSelection = ""; // never let a stale snapshot leak into a later click
    return s;
  }

  /** Whether this panel is scoped to a document (vs. the empty panel or a general chat). */
  hasContext(): boolean {
    return this.ctx !== null;
  }

  /** True while nothing has been said yet — so re-scoping the panel can't discard a thread. */
  isPristine(): boolean {
    return this.turns.length === 0 && !this.activeGen;
  }

  /** Attach a vault file as context, if it isn't already and there's room. */
  attachFile(path: string): void {
    if (this.attachments.includes(path) || this.attachments.length >= MAX_ATTACHMENTS) return;
    this.attachments.push(path);
    this.renderChips();
  }

  /**
   * Queue a "link back to this chat" to drop next to `anchorText` in a source note. Written once the
   * thread has a saved transcript (see persistGen); markdown sources only — a PDF can't be edited,
   * and our own generated notes are skipped so a chat never backlinks a hub/transcript.
   */
  queueBacklink(sourcePath: string, anchorText: string): void {
    if (!this.plugin.settings.linkSelectionToChat) return;
    const text = anchorText.trim();
    if (!text || !/\.md$/i.test(sourcePath)) return;
    const f = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    if (f instanceof TFile) {
      const kind = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter?.["augmented-pdf"];
      if (kind === "hub" || kind === "transcript") return;
    }
    if (this.pendingBacklinks.some((b) => b.sourcePath === sourcePath && b.anchorText === text)) return;
    this.pendingBacklinks.push({ sourcePath, anchorText: text });
  }

  /** Drop a quoted passage into the message box; the user types their question around it. */
  insertQuote(text: string): void {
    const quote = text
      .trim()
      .split("\n")
      .map((l) => "> " + l)
      .join("\n");
    const cur = this.inputEl.value.replace(/\s*$/, "");
    this.inputEl.value = (cur ? cur + "\n\n" : "") + quote + "\n\n";
    this.autoGrowInput();
    this.inputEl.focus();
    // Caret after the quote, so typing continues the question rather than editing the passage.
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
  }

  /** True when the caret sits at the start of a word, so "@" means "attach" rather than plain text. */
  private atWordBoundary(): boolean {
    const before = this.inputEl.value.slice(0, this.inputEl.selectionStart ?? 0);
    return before === "" || /\s$/.test(before);
  }

  /** Fuzzy-pick a vault file and attach it to this thread as context. */
  private promptForAttachment(): void {
    if (this.attachments.length >= MAX_ATTACHMENTS) {
      new Notice(`You can attach at most ${MAX_ATTACHMENTS} files to one chat.`);
      return;
    }
    // Exclude what's already attached and the file the chat is already about (it's in the prompt).
    const exclude = new Set(this.attachments);
    if (this.ctx) exclude.add(this.ctx.filePath);
    new FileSuggestModal(
      this.plugin.app,
      (f) => {
        this.attachments.push(f.path);
        this.renderChips();
        this.inputEl.focus();
      },
      exclude
    ).open();
  }

  private renderChips(): void {
    if (!this.chipsEl) return;
    this.chipsEl.empty();
    this.chipsEl.toggle(this.attachments.length > 0);
    for (const path of this.attachments) {
      const chip = this.chipsEl.createDiv({ cls: "apc-chip" });
      chip.createSpan({ cls: "apc-chip-name", text: path.replace(/^.*\//, "").replace(/\.md$/i, "") });
      chip.setAttr("title", path);
      const x = chip.createSpan({ cls: "apc-chip-x", text: "✕" });
      x.onclick = () => {
        this.attachments = this.attachments.filter((p) => p !== path);
        this.renderChips();
      };
    }
  }

  /** Popup menu listing every saved chat for the current file; selecting one re-opens it. */
  private async showChatPicker(evt: MouseEvent): Promise<void> {
    if (!this.ctx) {
      new Notice("Open a chat about a file first.");
      return;
    }
    const entries = await this.plugin.listFileChats(this.ctx);
    if (!entries.length) {
      new Notice("No saved chats for this file yet.");
      return;
    }
    const menu = new Menu();
    for (const e of entries) {
      menu.addItem((item) => {
        item.setTitle(e.label);
        if (this.transcriptFile && e.file.path === this.transcriptFile.path) item.setChecked(true);
        item.onClick(() => void this.plugin.openChatFromTranscript(e.file));
      });
    }
    menu.showAtMouseEvent(evt);
  }

  /** Open a context-free chat (no PDF passage) — for vault-wide skills and general Q&A. */
  startGeneralChat(): void {
    this.prepareSwitch(); // detach an in-flight reply (keep it running) or summarize the idle thread
    this.resetThread(); // assigns a fresh session id; clears generalChat — set it below
    this.ctx = null;
    this.generalChat = true;
    this.renderHeader();
    this.statusEl?.setText("General chat — not saved to a note.");
    window.setTimeout(() => this.inputEl?.focus(), 0);
  }

  /** Called by the settings tab when the persisted default changes, so an open panel stays in sync. */
  applySkillDefault(enabled: boolean): void {
    this.skillsEnabled = enabled;
    if (this.skillsToggle) this.skillsToggle.checked = enabled;
    this.renderHeader();
  }

  /** Called by the settings tab when the persisted web default changes, so an open panel stays in sync. */
  applyWebDefault(enabled: boolean): void {
    this.webEnabled = enabled;
    if (this.webToggle) this.webToggle.checked = enabled;
  }

  /** Seed a NEW chat thread for a file or selection. */
  setContext(ctx: ChatContext): void {
    this.prepareSwitch(); // detach an in-flight reply (keep it running) or summarize the idle thread
    this.resetThread();
    this.ctx = ctx;
    this.attachments = ctx.attachments?.slice() ?? [];
    this.renderChips();
    // A note selection that became this chat's focus deserves a link back, next to the passage.
    if (ctx.scope === "file" && ctx.kind === "md" && ctx.passage) this.queueBacklink(ctx.filePath, ctx.passage);
    this.renderHeader();
    window.setTimeout(() => this.inputEl?.focus(), 0);
    void this.loadPriorContext(ctx);
  }

  /** Load an existing chat (from its transcript) into the sidebar to read/continue it. */
  loadThread(o: {
    ctx: ChatContext;
    sessionId: string;
    turns: Turn[];
    totalCost: number;
    model: string;
    resolvedModel?: string | null;
    hubFile: TFile | null;
    transcriptFile: TFile;
    createdISO: string;
    summary: string | null;
  }): void {
    this.prepareSwitch(); // detach an in-flight reply (keep it running) or summarize the idle thread
    if (this.summaryTimer !== null) {
      window.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
    this.pendingBacklinks = []; // reopening a saved chat: its passages were already backlinked
    this.ctx = o.ctx;
    this.attachments = o.ctx.attachments?.slice() ?? [];
    this.renderChips();
    this.generalChat = false;
    this.sessionId = o.sessionId;
    this.turns = o.turns.slice();
    // >0 so the next message --resumes the original session rather than forcing a new id
    this.turnCount = this.turns.filter((t) => t.role === "claude").length;
    this.totalCost = o.totalCost;
    this.model = o.model;
    this.resolvedModel = o.resolvedModel ?? null;
    this.hubFile = o.hubFile;
    this.transcriptFile = o.transcriptFile;
    this.createdISO = o.createdISO;
    this.threadSummary = o.summary;
    this.entryAppended = true; // the hub entry already exists
    this.summarizedTurnCount = this.turns.length;
    this.priorContext = "";

    if (this.modelSelect && Array.from(this.modelSelect.options).some((opt) => opt.value === o.model)) {
      this.modelSelect.value = o.model;
    }
    this.messagesEl.empty();
    this.statusEl.setText(`Loaded chat · ${o.transcriptFile.basename}`);
    this.renderHeader();
    this.stickToBottom = true; // loading a chat → show its latest
    for (const t of this.turns) this.addBubble(t.role, t.text, true);
    this.scrollToBottom();
    window.setTimeout(() => this.inputEl?.focus(), 0);
    void this.loadPriorContext(o.ctx);
  }

  private resetThread(): void {
    // Callers run prepareSwitch() first (detaches any in-flight reply). This is a safety net: if a
    // reply is somehow still attached, detach it so it finishes in the background rather than dying.
    if (this.activeGen) this.detachActiveGen();
    if (this.summaryTimer !== null) {
      window.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
    this.sessionId = crypto.randomUUID();
    this.resolvedModel = null;
    this.generalChat = false;
    this.turnCount = 0;
    this.totalCost = 0;
    this.turns = [];
    this.hubFile = null;
    this.transcriptFile = null;
    this.createdISO = null;
    this.threadSummary = null;
    this.entryAppended = false;
    this.summarizedTurnCount = 0;
    this.priorContext = "";
    this.stickToBottom = true;
    this.attachments = [];
    this.pendingBacklinks = []; // switching threads drops any selection queued-but-never-sent
    this.renderChips();
    this.messagesEl?.empty();
    this.statusEl?.setText("");
  }

  private async loadPriorContext(ctx: ChatContext): Promise<void> {
    try {
      const hub = findHub(this.plugin.app, ctx, this.plugin.settings.mdChatsRoot);
      if (!hub) return;
      const prior = await readPriorSummaries(this.plugin.app, hub);
      // Guard against the thread having changed while we awaited.
      if (this.ctx === ctx && prior) {
        this.priorContext = prior;
        this.renderHeader();
      }
    } catch (e) {
      console.warn("[augmented-pdf] loadPriorContext failed", e);
    }
  }

  private addBubble(role: "user" | "claude", text: string, markdown = false): HTMLElement {
    const wrap = this.messagesEl.createDiv({ cls: `apc-msg apc-${role}` });
    wrap.createDiv({ cls: "apc-role", text: role === "user" ? "You" : "Claude" });
    const body = wrap.createDiv({ cls: "apc-body" });
    if (markdown && text) void this.renderMd(body, text);
    else body.setText(text);
    this.autoScroll();
    return body;
  }

  /** Render markdown (incl. math/code) into a bubble, replacing its contents. */
  private async renderMd(el: HTMLElement, md: string): Promise<void> {
    el.style.whiteSpace = "normal"; // undo the streaming pre-wrap before rendering blocks
    el.empty();
    let text = md;
    try {
      text = toObsidianMath(md);
    } catch (e) {
      console.warn("[augmented-pdf] toObsidianMath failed; rendering raw", e);
    }
    try {
      await MarkdownRenderer.render(this.app, text, el, "", this);
    } catch (e) {
      // Never let a render failure (e.g. a MathJax choke) blank the bubble or break the turn.
      console.error("[augmented-pdf] markdown render failed; showing plain text", e);
      el.style.whiteSpace = "pre-wrap";
      el.setText(md);
    }
  }

  /** Grow the input textarea to fit its content, up to a cap (then it scrolls). */
  private autoGrowInput(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  /** Is the view scrolled to (within ~60px of) the bottom? */
  private isNearBottom(): boolean {
    const el = this.messagesEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  /** Scroll to the bottom only if the user hasn't scrolled up (used for streaming/thinking updates). */
  private autoScroll(): void {
    if (this.stickToBottom) this.scrollToBottom();
  }

  private setStreaming(on: boolean): void {
    this.sendBtn.toggle(!on);
    this.stopBtn.toggle(on);
    this.inputEl.disabled = on;
    if (on) this.statusEl.setText("Thinking…");
  }

  private async send(): Promise<void> {
    if (this.child) {
      new Notice("A reply is in progress — wait or press Stop.");
      return;
    }
    const q = this.inputEl.value.trim();
    if (!q) return;
    // Mint a FRESH session id for every first-turn attempt (turnCount === 0), so retrying after a
    // failed turn 1 never reuses an id the CLI already registered ("Session ID … is already in use").
    // Continuations (turnCount > 0) keep the established id and --resume it.
    if (this.turnCount === 0 || !this.sessionId) this.sessionId = crypto.randomUUID();
    this.inputEl.value = "";
    this.autoGrowInput();

    if (this.summaryTimer !== null) {
      window.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }

    this.stickToBottom = true; // sending re-pins to the bottom to show the new turn
    this.addBubble("user", q, true);
    this.turns.push({ role: "user", text: q });

    // One self-contained Generation per reply, capturing everything needed to finish + save on its
    // own. `turns` shares the array reference with this.turns; resetThread reassigns this.turns to a
    // fresh array, so a detached gen keeps the old thread's turns. This is what lets a reply keep
    // running (and save itself) after the panel switches to a new chat.
    // Fold the @-attachments into the thread's context before capturing it, so a detached generation
    // saves exactly the set that was in its prompt even if the panel switches mid-reply.
    if (this.ctx) this.ctx = { ...this.ctx, attachments: this.attachments.slice() };
    // Hand any queued backlinks to THIS reply's generation (which owns the transcript they'll point
    // to) and clear ours, so they attach to this transcript and aren't re-written on a later turn.
    const backlinks = this.pendingBacklinks.slice();
    this.pendingBacklinks = [];
    const gen: Generation = {
      ctx: this.ctx,
      sessionId: this.sessionId!,
      model: this.model,
      resolvedModel: this.resolvedModel,
      turns: this.turns,
      totalCost: this.totalCost,
      hubFile: this.hubFile,
      transcriptFile: this.transcriptFile,
      createdISO: this.createdISO,
      entryAppended: this.entryAppended,
      summary: this.threadSummary,
      child: null,
      ticker: null,
      indicator: null,
      detached: false,
      pendingBacklinks: backlinks,
    };
    this.activeGen = gen;

    // The assistant reply renders as a sequence of segments inside one bubble: each text content
    // block is its own markdown paragraph, interleaved with live activity lines ("Thinking… Ns",
    // "Reading…", …) for the model's thinking/tool pauses. Driven by content_block_start (onBlock),
    // so mid-stream pauses are visible and consecutive text blocks don't glue together.
    const wrap = this.messagesEl.createDiv({ cls: "apc-msg apc-claude" });
    wrap.createDiv({ cls: "apc-role", text: "Claude" });
    const stream = wrap.createDiv({ cls: "apc-stream" });
    this.scrollToBottom();

    const segments: string[] = []; // finished text segments — joined for persistence
    const blocksSeen: string[] = []; // content-block trace, for diagnosing a reply that never arrives
    let textEl: HTMLElement | null = null; // the currently-streaming text segment (null when detached)
    let textAcc = "";
    let inText = false;
    let activityKind: "thinking" | "tool" | null = null;
    let activityStart = 0;
    let toolInputChars = 0; // bytes of the current tool's input generated so far (Write/Edit payload)

    const closeTextSegment = () => {
      if (!inText) return;
      segments.push(textAcc);
      if (!gen.detached && textEl) void this.renderMd(textEl, textAcc); // finalize as markdown
      textEl = null;
      textAcc = "";
      inText = false;
    };
    const startTextSegment = () => {
      inText = true;
      textAcc = "";
      textEl = gen.detached ? null : stream.createDiv({ cls: "apc-body" });
      if (textEl) textEl.style.whiteSpace = "pre-wrap"; // readable while streaming; renderMd resets it
    };
    // Convert the live activity line into a static trace (or drop it). Thinking ≥1s leaves
    // "Thought for Ns" (the indicator the user likes); shorter thinking and any tool pause vanish.
    const finalizeActivity = () => {
      if (gen.ticker != null) {
        window.clearInterval(gen.ticker);
        gen.ticker = null;
      }
      const el = gen.indicator;
      gen.indicator = null;
      if (el) {
        const ms = Date.now() - activityStart;
        if (activityKind === "thinking" && ms >= 1000) {
          el.setText(`Thought for ${(ms / 1000).toFixed(1)}s`);
          el.removeClass("apc-thinking");
          el.addClass("apc-thought");
        } else {
          el.remove();
        }
      }
      activityKind = null;
    };
    const startActivity = (kind: "thinking" | "tool", label: string) => {
      activityKind = kind;
      activityStart = Date.now();
      toolInputChars = 0;
      if (gen.detached) return; // a backgrounded reply needs no live indicator
      const el = stream.createDiv({ cls: "apc-thinking" });
      el.hide();
      gen.indicator = el;
      gen.ticker = window.setInterval(() => {
        const ms = Date.now() - activityStart;
        if (ms < 350) return; // debounce so sub-350ms blocks never flicker into view
        // Always show elapsed time (a static label reads as "stuck"). For a tool that's generating a
        // large payload — Write/Edit regenerating file content, the slow, output-bound path — also
        // show how much has been produced, so a long wait looks like progress, not a hang.
        const secs = ` ${Math.round(ms / 1000)}s`;
        const size = toolInputChars > 1024 ? ` · ${(toolInputChars / 1024).toFixed(1)} KB` : "";
        el.setText(`${label}${secs}${size}`);
        el.show();
        this.autoScroll();
      }, 250);
    };

    this.setStreaming(true);

    const isFirst = this.turnCount === 0;
    const provider = this.plugin.getProvider();
    // Skills/web are Claude-CLI-only; under a chat-only provider (GWDG) they're unavailable.
    const useSkills = this.skillsEnabled && provider.capabilities.skills;
    const useWeb = this.webEnabled && provider.capabilities.web;
    // A whole-PDF chat works by having the model Read the file; a provider without tools would
    // answer from the filename alone, so say so rather than let it hallucinate the paper.
    if (gen.ctx?.scope === "file" && gen.ctx.kind === "pdf" && !provider.capabilities.readsFiles) {
      new Notice(
        `${provider.label} can't open PDFs — whole-document chats need the Claude CLI provider ` +
          `(Settings → AI provider). Highlight a passage instead, or attach a note.`,
        10000
      );
    }
    let sys: string;
    if (gen.ctx) {
      sys = await buildSourceBlock(this.plugin.app, gen.ctx);
      if (isFirst && this.priorContext) {
        const what = gen.ctx.scope === "selection" ? "This passage" : "This file";
        sys += `\n\n${what} has been discussed before. Prior chat summaries (for continuity):\n` + this.priorContext;
      }
    } else {
      sys =
        "You are a helpful assistant working inside the user's Obsidian vault " +
        "(the current working directory). Answer concisely.";
    }
    sys += await buildAttachmentsBlock(this.plugin.app, gen.ctx?.attachments ?? this.attachments);
    if (useSkills) {
      sys +=
        "\n\nThe vault's Claude Code skills are available (e.g. /capture-idea, /ingest-raw, " +
        "/query-vault, /find-connections). When the user asks you to capture, save, ingest, query, " +
        "or otherwise act on the vault, use the appropriate skill; file writes and shell commands " +
        "are permitted in this vault." +
        // Steer to the fast editing path: a full-file Write must regenerate the whole file (slow,
        // and it shows as a long "Writing…" the user reads as a hang). Read-then-Edit only emits the
        // changed span. Read is also a hard prerequisite of Edit, so this removes the failed first
        // Edit attempt too.
        "\n\nTo modify an existing file, Read it first, then make a focused Edit (the Edit tool " +
        "requires a prior Read in this session). Prefer a targeted Edit over rewriting the whole file " +
        "with Write — a full-file Write regenerates the entire file and is much slower. Reserve Write " +
        "for genuinely new files.";
    }
    sys +=
      "\n\nFor math, use Obsidian MathJax: $...$ inline and $$...$$ for display; never \\( \\) or \\[ \\].";

    // When the account is out of its usage window, the CLI emits a rate_limit_event then blocks
    // (silently, possibly for hours) waiting for the reset. Surface that clearly and stop, since
    // retrying would just re-hit the same limit.
    let rateLimitHandled = false;
    const handleRateLimited = (info: { resetsAt?: number; rateLimitType?: string }) => {
      if (rateLimitHandled) return;
      rateLimitHandled = true;
      this.untrackChild(gen);
      try {
        gen.child?.kill();
      } catch {
        /* ignore */
      }
      finalizeActivity();
      closeTextSegment();
      const when = info?.resetsAt ? moment(info.resetsAt * 1000).format("ddd HH:mm") : "later";
      const kind = info?.rateLimitType === "five_hour" ? "5-hour usage limit" : "usage limit";
      if (!gen.detached) {
        stream.createDiv({
          cls: "apc-body apc-error",
          text: `⏳ Claude ${kind} reached — paused until it resets (${when}). This is your Claude plan limit, not a plugin error; try again then.`,
        });
      }
      if (this.activeGen === gen) {
        this.activeGen = null;
        this.child = null;
        this.setStreaming(false);
      }
    };

    // Read-only allow-list for non-skills mode. WebSearch/WebFetch are appended only when the user
    // enabled web access (toolbar "Web" toggle / settings default) — web is read-only but also an
    // exfiltration channel, so it's opt-in. In skills mode, bypassPermissions already allows web.
    const readOnlyTools = useWeb ? "Read,Grep,Glob,WebSearch,WebFetch" : "Read,Grep,Glob";

    // Full message history for stateless providers (GWDG); the CLI ignores it and uses session resume.
    // gen.turns already ends with the just-pushed user message, so don't append q again.
    const messages: AiMessage[] = [
      ...(sys ? [{ role: "system", content: sys } as AiMessage] : []),
      ...gen.turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.text } as AiMessage)),
    ];

    try {
      gen.child = provider.run(
      {
        prompt: q,
        systemPrompt: sys,
        messages,
        model: gen.model,
        effort: this.effort && this.effort !== "default" ? this.effort : undefined,
        // Skills mode bypasses per-action approval so skills can write/run commands; otherwise stay
        // read-only — pre-approve readOnlyTools (Read/Grep/Glob, +web when enabled), deny the rest.
        // (CLI-only knobs; the GWDG provider ignores them.)
        ...(useSkills
          ? { permissionMode: "bypassPermissions" }
          : { allowedTools: readOnlyTools, permissionMode: "dontAsk" }),
        sessionId: isFirst ? gen.sessionId : undefined,
        resumeId: isFirst ? undefined : gen.sessionId,
      },
      {
        onEvent: (type, raw) => {
          // The CLI's init event reports which concrete model the alias resolved to
          // ("opus" -> "claude-opus-5"). Aliases float with releases, so record what actually ran.
          if (type === "system") {
            const init = raw as { subtype?: string; model?: string };
            if (init?.subtype === "init" && typeof init.model === "string" && init.model) {
              gen.resolvedModel = init.model;
              if (this.activeGen === gen) this.resolvedModel = init.model;
            }
          }
          if (type === "rate_limit_event") {
            const info = (raw as {
              rate_limit_info?: {
                status?: string;
                resetsAt?: number;
                rateLimitType?: string;
                overageStatus?: string;
                isUsingOverage?: boolean;
              };
            })?.rate_limit_info;
            const status = String(info?.status ?? "");
            // status "rejected" only means the INCLUDED 5-hour allowance is used up — the request still
            // proceeds (and succeeds) when usage credits/overage cover it. So only hard-block when the
            // limit is hit AND no credits are covering it; otherwise let the call run.
            const usingCredits =
              info?.isUsingOverage === true || String(info?.overageStatus ?? "").startsWith("allow");
            if (status && !status.startsWith("allowed") && !usingCredits) handleRateLimited(info ?? {});
          }
        },
        onBlock: (kind, name) => {
          blocksSeen.push(kind + (name ? `(${name})` : ""));
          if (kind === "text") {
            finalizeActivity(); // "Thinking…" → "Thought for Ns"
            closeTextSegment(); // safety: close any still-open text block first
            startTextSegment();
          } else if (kind === "thinking" || kind === "tool_use") {
            closeTextSegment(); // capture preceding text + separate it from the pause
            finalizeActivity();
            startActivity(kind === "thinking" ? "thinking" : "tool", kind === "thinking" ? "Thinking…" : toolVerb(name));
          }
        },
        onToolInput: (n) => {
          // Feeds the "Writing… 12s · 8.4 KB" progress; the ticker reads toolInputChars each frame.
          toolInputChars += n;
        },
        onText: (t) => {
          if (!inText) {
            // Defensive: a CLI without content_block_start events still streams text.
            finalizeActivity();
            startTextSegment();
          }
          textAcc += t;
          if (!gen.detached && textEl) textEl.setText(textAcc); // skip writes to orphaned DOM
          if (!gen.detached) this.autoScroll();
        },
        onDone: (r) => {
          this.untrackChild(gen);
          finalizeActivity();
          closeTextSegment();
          if (r.costUsd) gen.totalCost += r.costUsd;
          let reply = toObsidianMath(segments.join("\n\n").trim());
          // The STREAMED text is authoritative — the `.result` envelope truncates on large outputs,
          // which is why we accumulate onText in the first place. But if nothing streamed at all, the
          // envelope still carries the model's final answer, and showing it beats showing nothing.
          // (Chats with skills on have been seen finishing with no text block; rather than discard a
          // perfectly good answer, fall back and render it.)
          let usedEnvelope = false;
          if (!reply && !r.isError && String(r.result ?? "").trim()) {
            reply = toObsidianMath(String(r.result).trim());
            usedEnvelope = true;
          }
          // is_error result = the CLI completed but the API/run errored (often transient: overloaded,
          // a network blip, a usage limit). Surface the actual reason and log the full envelope.
          let errDetail = "";
          if (r.isError) {
            errDetail = (String(r.result || "").trim() || r.subtype || "unknown error").slice(0, 400);
            console.error("[augmented-pdf] result error:", r.raw);
            if (!reply) reply = `⚠️ (error: ${errDetail})`;
          }
          gen.turns.push({ role: "claude", text: reply, costUsd: r.costUsd });
          if (!gen.detached) {
            if (r.isError) {
              stream.createDiv({ cls: "apc-body apc-error", text: `⚠️ ${errDetail}\n\n${errorAdvice(errDetail)}` });
            } else if (usedEnvelope) {
              // The CLI parses a leading "/" as a slash command and reports an unknown one as a
              // SUCCESS (is_error false, cost 0) whose only content is this line — so it can't be
              // caught as an error. Spell out the cause, or it reads as the chat silently ignoring you.
              if (/^Unknown command:/.test(reply)) {
                stream.createDiv({
                  cls: "apc-body apc-error",
                  text:
                    `${reply} — a message beginning with “/” is read as a slash command, not as text, ` +
                    `so nothing was sent to the model. Remove the leading “/” and send it as a normal ` +
                    `message (skills trigger from plain language), or use a skill that exists.`,
                });
              } else {
                void this.renderMd(stream.createDiv({ cls: "apc-body" }), reply);
              }
            } else if (!reply) {
              // A run that finishes cleanly yet says nothing is never normal — leave a durable trace
              // instead of a bare "(no response)" the user can't act on or report.
              console.warn("[augmented-pdf] empty response", {
                blocks: blocksSeen,
                subtype: r.subtype,
                result: r.result,
                skills: useSkills,
                model: gen.model,
                effort: this.effort,
                raw: r.raw,
              });
              stream.createDiv({
                cls: "apc-body apc-error",
                text:
                  `(no reply text — the model ran [${blocksSeen.join(" → ") || "nothing"}] and stopped` +
                  `${r.subtype ? `, subtype "${r.subtype}"` : ""}. Full envelope logged to the console.)`,
              });
            }
            const meta = wrap.createDiv({ cls: "apc-meta" });
            meta.setText(
              provider.capabilities.usd
                ? `${gen.resolvedModel ?? gen.model} · $${(r.costUsd ?? 0).toFixed(4)}  ·  thread total $${gen.totalCost.toFixed(4)}`
                : `${this.plugin.settings.gwdgModel} · ${provider.label}`
            );
            this.autoScroll();
          }
          void this.completeGeneration(gen);
        },
        onError: (e) => {
          this.untrackChild(gen);
          finalizeActivity();
          closeTextSegment();
          console.error("[augmented-pdf] chat error", e);
          if (this.activeGen === gen) {
            // Attached reply: show the error inline, with what to do about it, and reset.
            stream.createDiv({ cls: "apc-body apc-error", text: `⚠️ ${e.message}\n\n${errorAdvice(e.message)}` });
            this.activeGen = null;
            this.child = null;
            this.setStreaming(false);
          } else if (gen.detached && gen.ctx) {
            // Backgrounded reply failed: we promised to save it, so persist whatever streamed plus an
            // error marker, and tell the user (the bubble left with the switched-away panel).
            const partial = toObsidianMath(segments.join("\n\n").trim());
            gen.turns.push({ role: "claude", text: (partial ? partial + "\n\n" : "") + `⚠️ (reply failed: ${e.message})` });
            new Notice("A background chat hit an error — saved what it had to its note.");
            void this.completeGeneration(gen);
          }
        },
      }
    );
    } catch (e) {
      // spawn() can throw synchronously (e.g. a NUL byte in an arg, or resource exhaustion). Without
      // this the throw escapes send() and leaves the panel stuck on "Thinking…". Recover immediately.
      const msg = (e as Error)?.message ?? String(e);
      console.error("[augmented-pdf] spawn failed", e);
      finalizeActivity();
      closeTextSegment();
      stream.createDiv({ cls: "apc-body apc-error", text: "⚠️ Couldn't start Claude: " + msg });
      this.activeGen = null;
      this.child = null;
      this.setStreaming(false);
      return;
    }
    this.child = gen.child;
    if (gen.child) this.plugin.liveChildren.add(gen.child);
    if (!gen.child?.pid) {
      // Spawned object with no PID = the process never came up, and no 'error' event may fire.
      finalizeActivity();
      closeTextSegment();
      stream.createDiv({ cls: "apc-body apc-error", text: "⚠️ Couldn't start Claude (no process). Try again." });
      this.untrackChild(gen);
      try {
        gen.child?.kill();
      } catch {
        /* ignore */
      }
      this.activeGen = null;
      this.child = null;
      this.setStreaming(false);
    }
  }

  /** Stop tracking a generation's child once it has terminated (so onunload doesn't try to re-kill). */
  private untrackChild(gen: Generation): void {
    if (gen.child) this.plugin.liveChildren.delete(gen.child);
  }

  /** Stop and discard the active reply (the Stop button). Detached/background replies are unaffected. */
  private stop(): void {
    const gen = this.activeGen;
    if (gen) {
      this.untrackChild(gen);
      if (gen.child) {
        try {
          gen.child.kill();
        } catch {
          /* ignore */
        }
      }
      if (gen.ticker != null) {
        window.clearInterval(gen.ticker);
        gen.ticker = null;
      }
      gen.indicator?.remove();
      gen.indicator = null;
      this.activeGen = null;
    }
    this.child = null;
    if (this.sendBtn) this.setStreaming(false);
  }

  /**
   * Detach the in-flight reply so it keeps running and saves itself in the background — the panel is
   * then free for a new chat. (Background-continue; see Generation.)
   */
  private detachActiveGen(): void {
    const gen = this.activeGen;
    if (!gen) return;
    gen.detached = true;
    if (gen.ticker != null) {
      window.clearInterval(gen.ticker); // stop animating the (soon-cleared) indicator
      gen.ticker = null;
    }
    this.activeGen = null;
    this.child = null;
    this.setStreaming(false);
    if (gen.child) new Notice("Earlier chat is still working — it'll be saved to its note when done.");
  }

  /** Before switching chats: detach an in-flight reply (keep it running) or summarize the idle one. */
  private prepareSwitch(): void {
    if (this.activeGen && this.child) this.detachActiveGen();
    else this.concludeThread();
  }

  /**
   * Persist a finished generation, then summarize it. Works for the active thread AND a detached
   * (background) one. Only syncs state back into the view if the gen is still the attached thread.
   */
  private async completeGeneration(gen: Generation): Promise<void> {
    const attached = this.activeGen === gen; // false once detached or switched away
    if (attached) {
      this.child = null;
      this.activeGen = null;
      this.turnCount++;
      this.totalCost = gen.totalCost;
      this.setStreaming(false);
    }
    if (!gen.ctx) {
      if (attached) this.statusEl?.setText("General chat — not saved to a note.");
      return; // general chats aren't saved
    }
    if (!gen.turns.some((t) => t.role === "claude")) return;
    try {
      await this.persistGen(gen);
      // Re-check identity AFTER the await: if the user switched chats during persistence, this.* now
      // belongs to a different thread, so don't sync into it — just finish the gen in the background.
      const stillActive = attached && this.ctx === gen.ctx && this.sessionId === gen.sessionId;
      if (stillActive) {
        this.hubFile = gen.hubFile;
        this.transcriptFile = gen.transcriptFile;
        this.createdISO = gen.createdISO;
        this.entryAppended = gen.entryAppended;
        this.statusEl?.setText(`Saved · annotation: ${gen.hubFile?.basename ?? ""}`);
        this.scheduleSummary(); // idle summary of the active thread
      } else if (gen.hubFile && gen.transcriptFile) {
        await this.summarizeThread({
          ctx: gen.ctx,
          sessionId: gen.sessionId,
          model: gen.model,
          resolvedModel: gen.resolvedModel,
          turns: gen.turns.slice(),
          totalCost: gen.totalCost,
          hub: gen.hubFile,
          transcript: gen.transcriptFile,
          createdISO: gen.createdISO ?? moment().format(),
        });
      }
    } catch (e) {
      console.error("[augmented-pdf] completeGeneration failed", e);
      if (attached) this.statusEl?.setText("Save failed (see console)");
    }
  }

  /** Create/update the transcript and ensure a hub entry exists for a generation's thread. */
  private async persistGen(gen: Generation): Promise<void> {
    if (!gen.ctx || !gen.sessionId) return;
    const mdRoot = this.plugin.settings.mdChatsRoot;
    if (!gen.createdISO) gen.createdISO = moment().format();
    if (!gen.hubFile) gen.hubFile = await findOrCreateHub(this.plugin.app, gen.ctx, mdRoot);
    gen.transcriptFile = await writeTranscript(
      this.plugin.app,
      gen.ctx,
      {
        file: gen.transcriptFile,
        sessionId: gen.sessionId,
        model: gen.model,
        resolvedModel: gen.resolvedModel,
        turns: gen.turns,
        totalCost: gen.totalCost,
        hubBasename: gen.hubFile.basename,
        createdISO: gen.createdISO,
        summary: gen.summary,
      },
      mdRoot
    );
    if (!gen.entryAppended) {
      await appendChatEntry(this.plugin.app, gen.hubFile, {
        anchorId: gen.sessionId,
        title: oneLine(gen.turns.find((t) => t.role === "user")?.text ?? "Chat").slice(0, 80),
        transcriptBasename: gen.transcriptFile.basename,
      });
      gen.entryAppended = true;
    }
    // Now that the transcript exists, drop the queued "link back to this chat" marks into their
    // source notes. Anchor-not-found (e.g. a reading-view selection over formatted text, or an edit
    // since) is permanent → drop it; a genuine write failure is kept for a later turn to retry.
    if (gen.pendingBacklinks.length) {
      const marker = backlinkMarker(gen.transcriptFile.basename);
      const retry: PendingBacklink[] = [];
      for (const b of gen.pendingBacklinks) {
        try {
          const ok = await writeBacklink(this.plugin.app, b.sourcePath, b.anchorText, marker);
          if (!ok) console.warn("[augmented-pdf] backlink anchor not found; skipped", b.sourcePath);
        } catch (e) {
          console.warn("[augmented-pdf] backlink write failed; will retry", b.sourcePath, e);
          retry.push(b);
        }
      }
      gen.pendingBacklinks = retry;
    }
  }

  private scheduleSummary(): void {
    if (this.summaryTimer !== null) window.clearTimeout(this.summaryTimer);
    this.summaryTimer = window.setTimeout(() => {
      this.summaryTimer = null;
      void this.maybeSummarize();
    }, SUMMARY_IDLE_MS);
  }

  /** Generate (deferred) the summary for the current thread and patch hub + transcript. */
  private async maybeSummarize(): Promise<void> {
    if (!this.ctx || !this.sessionId || !this.hubFile || !this.transcriptFile) return;
    const n = this.turns.length;
    if (n === 0 || n <= this.summarizedTurnCount) return;
    if (!this.turns.some((t) => t.role === "claude")) return;
    this.summarizedTurnCount = n; // optimistic — avoid duplicate runs
    await this.summarizeThread({
      ctx: this.ctx,
      sessionId: this.sessionId,
      model: this.model,
      resolvedModel: this.resolvedModel,
      turns: this.turns.slice(),
      totalCost: this.totalCost,
      hub: this.hubFile,
      transcript: this.transcriptFile,
      createdISO: this.createdISO ?? moment().format(),
    });
  }

  /** Conclude the current thread (idle/close/switch): summarize if there's new content. */
  private concludeThread(): void {
    if (this.summaryTimer !== null) {
      window.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
    void this.maybeSummarize();
  }

  private async summarizeThread(refs: ThreadRefs): Promise<void> {
    try {
      const summary = await generateSummary(this.plugin, refs.turns);
      if (!summary) return;
      await updateEntrySummary(this.plugin.app, refs.hub, refs.sessionId, summary);
      await writeTranscript(
        this.plugin.app,
        refs.ctx,
        {
          file: refs.transcript,
          sessionId: refs.sessionId,
          model: refs.model,
          resolvedModel: refs.resolvedModel,
          turns: refs.turns,
          totalCost: refs.totalCost,
          hubBasename: refs.hub.basename,
          createdISO: refs.createdISO,
          summary,
        },
        this.plugin.settings.mdChatsRoot
      );
      // Reflect in the live UI only if still the same thread AND the panel is still open
      // (a backgrounded reply can finish after the view closed — don't write to dead DOM).
      if (!this.closed && this.sessionId === refs.sessionId) {
        this.threadSummary = summary;
        this.statusEl.setText(`Summarized · annotation: ${refs.hub.basename}`);
      }
    } catch (e) {
      console.error("[augmented-pdf] summarizeThread failed", e);
    }
  }
}
