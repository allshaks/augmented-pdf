import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, moment } from "obsidian";
import { runClaude } from "../claude/runner";
import { ChatContext, Turn } from "../types";
import { appendChatEntry, findHub, findOrCreateHub, readPriorSummaries, updateEntrySummary } from "../store/hub";
import { writeTranscript } from "../store/transcript";
import { generateSummary } from "../summary";
import { oneLine } from "../store/paths";
import type AugmentedPdfPlugin from "../main";

export const CHAT_VIEW_TYPE = "augmented-pdf-chat";

const SUMMARY_IDLE_MS = 15000;

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

export class ChatView extends ItemView {
  plugin: AugmentedPdfPlugin;

  private ctx: ChatContext | null = null;
  private sessionId: string | null = null;
  private turnCount = 0;
  private totalCost = 0;
  private turns: Turn[] = [];
  private model: string;
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
  private activeTicker: number | null = null;
  private activeIndicator: HTMLElement | null = null;

  // DOM
  private headerEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelSelect!: HTMLSelectElement;

  constructor(leaf: WorkspaceLeaf, plugin: AugmentedPdfPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.model = plugin.settings.model;
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
    this.concludeThread();
    this.stop();
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
    const newBtn = toolbar.createEl("button", { cls: "apc-new", text: "New chat" });
    newBtn.onclick = () => {
      this.concludeThread();
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
      this.headerEl.createDiv({
        cls: "apc-empty",
        text: "Select text in a PDF and choose “Ask Claude about selection”.",
      });
      return;
    }
    this.headerEl.createDiv({ cls: "apc-src", text: `${this.ctx.pdfName} · p.${this.ctx.page}` });
    this.headerEl.createEl("blockquote", { cls: "apc-quote", text: this.ctx.passage });
    if (this.priorContext) {
      const n = (this.priorContext.match(/^### /gm) ?? []).length;
      this.headerEl.createDiv({
        cls: "apc-prior",
        text: `${n} previous chat${n === 1 ? "" : "s"} on this highlight — context included.`,
      });
    }
  }

  /** Seed a NEW chat thread for a selection. */
  setContext(ctx: ChatContext): void {
    this.concludeThread(); // summarize the outgoing thread before switching
    this.resetThread();
    this.ctx = ctx;
    this.renderHeader();
    window.setTimeout(() => this.inputEl?.focus(), 0);
    void this.loadPriorContext(ctx);
  }

  private resetThread(): void {
    this.stop();
    if (this.summaryTimer !== null) {
      window.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }
    this.sessionId = crypto.randomUUID();
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
    await MarkdownRenderer.render(this.app, md, el, "", this);
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
    if (!this.ctx) {
      new Notice("No PDF selection. Use “Ask Claude about selection” from a PDF.");
      return;
    }
    const q = this.inputEl.value.trim();
    if (!q) return;
    this.inputEl.value = "";
    this.autoGrowInput();

    if (this.summaryTimer !== null) {
      window.clearTimeout(this.summaryTimer);
      this.summaryTimer = null;
    }

    this.addBubble("user", q, true);
    this.turns.push({ role: "user", text: q });
    const claudeBody = this.addBubble("claude", "");
    claudeBody.style.whiteSpace = "pre-wrap"; // readable line breaks while streaming plain text

    // "Thinking… Ns" (live) → "Thought for Ns" once the first token arrives.
    const wrap = claudeBody.parentElement as HTMLElement;
    const indicator = wrap.createDiv({ cls: "apc-thinking" });
    wrap.insertBefore(indicator, claudeBody);
    indicator.hide();
    this.activeIndicator = indicator;
    const t0 = Date.now();
    let firstText = false;
    this.clearThinkingTicker();
    this.activeTicker = window.setInterval(() => {
      if (firstText) return;
      const ms = Date.now() - t0;
      if (ms >= 600) {
        indicator.setText(`Thinking… ${Math.round(ms / 1000)}s`);
        indicator.show();
      }
    }, 250);
    const finalizeThinking = () => {
      if (firstText) return;
      firstText = true;
      this.clearThinkingTicker();
      const ms = Date.now() - t0;
      if (ms >= 1000) {
        indicator.setText(`Thought for ${(ms / 1000).toFixed(1)}s`);
        indicator.removeClass("apc-thinking");
        indicator.addClass("apc-thought");
        indicator.show();
      } else {
        indicator.remove();
      }
      this.activeIndicator = null; // finalized — no longer interruptible
    };

    let acc = "";
    this.setStreaming(true);

    const isFirst = this.turnCount === 0;
    let sys =
      `You are helping the user understand a passage from the PDF "${this.ctx.pdfName}" (page ${this.ctx.page}).\n` +
      `Highlighted passage:\n"""\n${this.ctx.passage}\n"""\n` +
      `Answer concisely and stay grounded in this passage.`;
    if (isFirst && this.priorContext) {
      sys +=
        `\n\nThis passage has been discussed before. Prior chat summaries (for continuity):\n` +
        this.priorContext;
    }

    this.child = runClaude(
      {
        binPath: this.plugin.settings.claudeBinPath,
        prompt: q,
        appendSystemPrompt: sys,
        model: this.model,
        allowedTools: "Read,Grep,Glob",
        permissionMode: "dontAsk",
        cwd: this.plugin.vaultCwd(),
        sessionId: isFirst ? this.sessionId ?? undefined : undefined,
        resumeId: isFirst ? undefined : this.sessionId ?? undefined,
      },
      {
        onText: (t) => {
          finalizeThinking();
          acc += t;
          claudeBody.setText(acc);
          this.scrollToBottom();
        },
        onDone: (r) => {
          if (!firstText) {
            this.clearThinkingTicker();
            indicator.remove();
            this.activeIndicator = null;
          }
          this.turnCount++;
          if (r.costUsd) this.totalCost += r.costUsd;
          // Swap the plain streamed text for rendered markdown now the turn is complete.
          const finalText = acc || (r.isError ? "(error — see console)" : "");
          void this.renderMd(claudeBody, finalText).then(() => this.scrollToBottom());
          const meta = claudeBody.parentElement?.createDiv({ cls: "apc-meta" });
          meta?.setText(`${this.model} · $${(r.costUsd ?? 0).toFixed(4)}  ·  thread total $${this.totalCost.toFixed(4)}`);
          this.turns.push({ role: "claude", text: acc, costUsd: r.costUsd });
          this.child = null;
          this.setStreaming(false);
          this.scrollToBottom();
          void this.persist();
          this.scheduleSummary();
        },
        onError: (e) => {
          if (!firstText) {
            this.clearThinkingTicker();
            indicator.remove();
            this.activeIndicator = null;
          }
          console.error("[augmented-pdf] chat error", e);
          claudeBody.setText((acc ? acc + "\n\n" : "") + "⚠️ " + e.message);
          this.child = null;
          this.setStreaming(false);
        },
      }
    );
  }

  private stop(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
    }
    this.clearThinkingTicker();
    if (this.activeIndicator) {
      this.activeIndicator.remove();
      this.activeIndicator = null;
    }
    if (this.sendBtn) this.setStreaming(false);
  }

  private clearThinkingTicker(): void {
    if (this.activeTicker != null) {
      window.clearInterval(this.activeTicker);
      this.activeTicker = null;
    }
  }

  /** Create/update the transcript and ensure a hub entry exists for this thread. */
  private async persist(): Promise<void> {
    if (!this.ctx || !this.sessionId) return;
    if (!this.turns.some((t) => t.role === "claude")) return;
    try {
      if (!this.createdISO) this.createdISO = moment().format();
      if (!this.hubFile) this.hubFile = await findOrCreateHub(this.plugin.app, this.ctx);

      this.transcriptFile = await writeTranscript(this.plugin.app, this.ctx, {
        file: this.transcriptFile,
        sessionId: this.sessionId,
        model: this.model,
        turns: this.turns,
        totalCost: this.totalCost,
        hubBasename: this.hubFile.basename,
        createdISO: this.createdISO,
        summary: this.threadSummary,
      });

      if (!this.entryAppended) {
        await appendChatEntry(this.plugin.app, this.hubFile, {
          anchorId: this.sessionId,
          title: oneLine(this.turns.find((t) => t.role === "user")?.text ?? "Chat").slice(0, 80),
          transcriptBasename: this.transcriptFile.basename,
        });
        this.entryAppended = true;
      }
      this.statusEl.setText(`Saved · annotation: ${this.hubFile.basename}`);
    } catch (e) {
      console.error("[augmented-pdf] persist failed", e);
      this.statusEl.setText("Save failed (see console)");
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
      // Reflect in the live UI only if still the same thread.
      if (this.sessionId === refs.sessionId) {
        this.threadSummary = summary;
        this.statusEl.setText(`Summarized · annotation: ${refs.hub.basename}`);
      }
    } catch (e) {
      console.error("[augmented-pdf] summarizeThread failed", e);
    }
  }
}
