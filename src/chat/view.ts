import { ItemView, MarkdownRenderer, Menu, Notice, TFile, WorkspaceLeaf, moment } from "obsidian";
import { runClaude } from "../claude/runner";
import { ChatContext, EFFORT_LEVELS, Turn } from "../types";
import { appendChatEntry, findHub, findOrCreateHub, readPriorSummaries, updateEntrySummary } from "../store/hub";
import { writeTranscript } from "../store/transcript";
import { generateSummary } from "../summary";
import { oneLine } from "../store/paths";
import { toObsidianMath } from "../format";
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

/** Refs captured per-thread so async work survives the thread being reset. */
interface ThreadRefs {
  ctx: ChatContext;
  sessionId: string;
  model: string;
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
  turns: Turn[]; // shared ref with this.turns at send() time
  totalCost: number;
  hubFile: TFile | null;
  transcriptFile: TFile | null;
  createdISO: string | null;
  entryAppended: boolean;
  summary: string | null; // last known thread summary (preserved across transcript rewrites)
  child: ReturnType<typeof runClaude> | null;
  ticker: number | null;
  indicator: HTMLElement | null;
  detached: boolean;
}

export class ChatView extends ItemView {
  plugin: AugmentedPdfPlugin;

  private ctx: ChatContext | null = null;
  private sessionId: string | null = null;
  private turnCount = 0;
  private totalCost = 0;
  private turns: Turn[] = [];
  private model: string;
  private effort: string; // session reasoning effort (toolbar); "default" => omit --effort
  private child: ReturnType<typeof runClaude> | null = null;

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
  /** True only for an explicitly-started context-free chat (so the empty panel isn't mislabeled). */
  private generalChat = false;
  /** Set once the view is closed, so a backgrounded reply's completion never writes to dead DOM. */
  private closed = false;

  // DOM
  private headerEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelSelect!: HTMLSelectElement;
  private skillsToggle!: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, plugin: AugmentedPdfPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.model = plugin.settings.model;
    this.effort = plugin.settings.effort;
    this.skillsEnabled = plugin.settings.allowSkills; // session starts at the persisted default
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
    for (const m of ["haiku", "sonnet", "opus"]) {
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

    const newBtn = toolbar.createEl("button", { cls: "apc-new", text: "New chat" });
    newBtn.onclick = () => {
      this.prepareSwitch();
      this.resetThread();
      this.renderHeader();
    };

    this.messagesEl = root.createDiv({ cls: "apc-messages" });

    const inputRow = root.createDiv({ cls: "apc-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "apc-input",
      attr: { rows: "1", placeholder: "Ask about the passage…  (Enter to send · Shift+Enter = newline)" },
    });
    this.inputEl.addEventListener("input", () => this.autoGrowInput());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
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
        text: "Select text in a PDF and choose “Ask Claude about selection”, or run “Ask Claude (general chat / run a vault skill)”.",
      });
      return;
    }
    const srcRow = this.headerEl.createDiv({ cls: "apc-src-row" });
    srcRow.createDiv({ cls: "apc-src", text: `${this.ctx.pdfName} · p.${this.ctx.page}` });
    const picker = srcRow.createEl("button", { cls: "apc-chats-btn", text: "Chats ▾" });
    picker.setAttr("title", "Open another chat saved for this paper");
    picker.onclick = (evt) => void this.showChatPicker(evt);
    this.headerEl.createEl("blockquote", { cls: "apc-quote", text: this.ctx.passage });
    if (this.skillsEnabled) {
      // On-state cue on the higher-risk path: a malicious PDF's text is in this prompt.
      this.headerEl.createDiv({
        cls: "apc-skills-on",
        text: "⚡ Skills on — this chat can write files & run commands.",
      });
    }
    if (this.priorContext) {
      const n = (this.priorContext.match(/^### /gm) ?? []).length;
      this.headerEl.createDiv({
        cls: "apc-prior",
        text: `${n} previous chat${n === 1 ? "" : "s"} on this highlight — context included.`,
      });
    }
  }

  /** Popup menu listing every saved chat for the current paper; selecting one re-opens it. */
  private async showChatPicker(evt: MouseEvent): Promise<void> {
    if (!this.ctx) {
      new Notice("Open a chat from a PDF passage first.");
      return;
    }
    const entries = await this.plugin.listPaperChats(this.ctx.pdfPath, this.ctx.pdfName);
    if (!entries.length) {
      new Notice("No saved chats for this paper yet.");
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

  /** Seed a NEW chat thread for a selection. */
  setContext(ctx: ChatContext): void {
    this.prepareSwitch(); // detach an in-flight reply (keep it running) or summarize the idle thread
    this.resetThread();
    this.ctx = ctx;
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
    this.ctx = o.ctx;
    this.generalChat = false;
    this.sessionId = o.sessionId;
    this.turns = o.turns.slice();
    // >0 so the next message --resumes the original session rather than forcing a new id
    this.turnCount = this.turns.filter((t) => t.role === "claude").length;
    this.totalCost = o.totalCost;
    this.model = o.model;
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
    this.messagesEl?.empty();
    this.statusEl?.setText("");
  }

  private async loadPriorContext(ctx: ChatContext): Promise<void> {
    try {
      const hub = findHub(this.plugin.app, ctx);
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
    this.scrollToBottom();
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

  private setStreaming(on: boolean): void {
    this.sendBtn.toggle(!on);
    this.stopBtn.toggle(on);
    this.inputEl.disabled = on;
    if (on) this.statusEl.setText("Claude is thinking…");
  }

  private async send(): Promise<void> {
    if (this.child) {
      new Notice("A reply is in progress — wait or press Stop.");
      return;
    }
    const q = this.inputEl.value.trim();
    if (!q) return;
    // No PDF passage required — a context-free chat can still run vault-wide skills / general Q&A.
    if (!this.sessionId) this.sessionId = crypto.randomUUID();
    this.inputEl.value = "";
    this.autoGrowInput();

    if (this.summaryTimer !== null) {
      window.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }

    this.addBubble("user", q, true);
    this.turns.push({ role: "user", text: q });

    // One self-contained Generation per reply, capturing everything needed to finish + save on its
    // own. `turns` shares the array reference with this.turns; resetThread reassigns this.turns to a
    // fresh array, so a detached gen keeps the old thread's turns. This is what lets a reply keep
    // running (and save itself) after the panel switches to a new chat.
    const gen: Generation = {
      ctx: this.ctx,
      sessionId: this.sessionId!,
      model: this.model,
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
    let textEl: HTMLElement | null = null; // the currently-streaming text segment (null when detached)
    let textAcc = "";
    let inText = false;
    let activityKind: "thinking" | "tool" | null = null;
    let activityStart = 0;

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
      if (gen.detached) return; // a backgrounded reply needs no live indicator
      const el = stream.createDiv({ cls: "apc-thinking" });
      el.hide();
      gen.indicator = el;
      gen.ticker = window.setInterval(() => {
        const ms = Date.now() - activityStart;
        if (ms < 350) return; // debounce so sub-350ms blocks never flicker into view
        el.setText(kind === "thinking" ? `${label} ${Math.round(ms / 1000)}s` : label);
        el.show();
        this.scrollToBottom();
      }, 250);
    };

    this.setStreaming(true);

    const isFirst = this.turnCount === 0;
    let sys: string;
    if (this.ctx) {
      sys =
        `You are helping the user understand a passage from the PDF "${this.ctx.pdfName}" (page ${this.ctx.page}).\n` +
        `Highlighted passage:\n"""\n${this.ctx.passage}\n"""\n` +
        `Answer concisely and stay grounded in this passage.`;
      if (isFirst && this.priorContext) {
        sys +=
          `\n\nThis passage has been discussed before. Prior chat summaries (for continuity):\n` +
          this.priorContext;
      }
    } else {
      sys =
        "You are a helpful assistant working inside the user's Obsidian vault " +
        "(the current working directory). Answer concisely.";
    }
    if (this.skillsEnabled) {
      sys +=
        "\n\nThe vault's Claude Code skills are available (e.g. /capture-idea, /ingest-raw, " +
        "/query-vault, /find-connections). When the user asks you to capture, save, ingest, query, " +
        "or otherwise act on the vault, use the appropriate skill; file writes and shell commands " +
        "are permitted in this vault.";
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

    try {
      gen.child = runClaude(
      {
        binPath: this.plugin.settings.claudeBinPath,
        prompt: q,
        appendSystemPrompt: sys,
        model: gen.model,
        effort: this.effort && this.effort !== "default" ? this.effort : undefined,
        // Skills mode bypasses per-action approval so skills can write/run commands; otherwise
        // stay read-only (pre-approve only Read/Grep/Glob and deny everything else non-interactively).
        ...(this.skillsEnabled
          ? { permissionMode: "bypassPermissions" }
          : { allowedTools: "Read,Grep,Glob", permissionMode: "dontAsk" }),
        cwd: this.plugin.vaultCwd(),
        // Skip user-level settings (the remember plugin's SessionStart hook) — it runs on every call
        // and stalls startup on the iCloud vault. Keeps auth + the vault's own .claude/skills.
        settingSources: "project,local",
        // Disable MCP so the account's claude.ai connectors don't connect (30s each) at startup.
        noMcp: true,
        sessionId: isFirst ? gen.sessionId : undefined,
        resumeId: isFirst ? undefined : gen.sessionId,
      },
      {
        onEvent: (type, raw) => {
          if (type === "rate_limit_event") {
            const info = (raw as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string } })
              ?.rate_limit_info;
            const status = String(info?.status ?? "");
            // "allowed"/"allowed_warning" mean the call proceeds; anything else = blocked on the limit.
            if (status && !status.startsWith("allowed")) handleRateLimited(info ?? {});
          }
        },
        onBlock: (kind, name) => {
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
        onText: (t) => {
          if (!inText) {
            // Defensive: a CLI without content_block_start events still streams text.
            finalizeActivity();
            startTextSegment();
          }
          textAcc += t;
          if (!gen.detached && textEl) textEl.setText(textAcc); // skip writes to orphaned DOM
          if (!gen.detached) this.scrollToBottom();
        },
        onDone: (r) => {
          this.untrackChild(gen);
          finalizeActivity();
          closeTextSegment();
          if (r.costUsd) gen.totalCost += r.costUsd;
          const reply = toObsidianMath(segments.join("\n\n").trim());
          gen.turns.push({ role: "claude", text: reply, costUsd: r.costUsd });
          if (!gen.detached) {
            if (!segments.length) {
              stream.createDiv({ cls: "apc-body", text: r.isError ? "(error — see console)" : "(no response)" });
            }
            const meta = wrap.createDiv({ cls: "apc-meta" });
            meta.setText(`${gen.model} · $${(r.costUsd ?? 0).toFixed(4)}  ·  thread total $${gen.totalCost.toFixed(4)}`);
            this.scrollToBottom();
          }
          void this.completeGeneration(gen);
        },
        onError: (e) => {
          this.untrackChild(gen);
          finalizeActivity();
          closeTextSegment();
          console.error("[augmented-pdf] chat error", e);
          if (this.activeGen === gen) {
            // Attached reply: show the error inline and reset (unchanged behavior).
            stream.createDiv({ cls: "apc-body apc-error", text: "⚠️ " + e.message });
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
    if (!gen.createdISO) gen.createdISO = moment().format();
    if (!gen.hubFile) gen.hubFile = await findOrCreateHub(this.plugin.app, gen.ctx);
    gen.transcriptFile = await writeTranscript(this.plugin.app, gen.ctx, {
      file: gen.transcriptFile,
      sessionId: gen.sessionId,
      model: gen.model,
      turns: gen.turns,
      totalCost: gen.totalCost,
      hubBasename: gen.hubFile.basename,
      createdISO: gen.createdISO,
      summary: gen.summary,
    });
    if (!gen.entryAppended) {
      await appendChatEntry(this.plugin.app, gen.hubFile, {
        anchorId: gen.sessionId,
        title: oneLine(gen.turns.find((t) => t.role === "user")?.text ?? "Chat").slice(0, 80),
        transcriptBasename: gen.transcriptFile.basename,
      });
      gen.entryAppended = true;
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
      await writeTranscript(this.plugin.app, refs.ctx, {
        file: refs.transcript,
        sessionId: refs.sessionId,
        model: refs.model,
        turns: refs.turns,
        totalCost: refs.totalCost,
        hubBasename: refs.hub.basename,
        createdISO: refs.createdISO,
        summary,
      });
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
