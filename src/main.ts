import {
  App,
  ColorComponent,
  FileSystemAdapter,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TextComponent,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import { execFile } from "child_process";
import { createHash } from "crypto";
import { CHAT_VIEW_TYPE, ChatView } from "./chat/view";
import { ChatContext, EFFORT_LEVELS, MODEL_CHOICES, SelectionContext, SourceKind } from "./types";
import { getSelectedText, getSelectionInfo, isPdfPlusEnabled } from "./pdfplus";
import { currentSelectionText } from "./activeSelection";
import { findHub, findNearbyHubs } from "./store/hub";
import { parseTranscriptTurns } from "./store/transcript";
import {
  appendUnderHeading,
  extractQuotePassage,
  mdChatFolder,
  oneLine,
  slugify,
  stemOf,
  transcriptsFolder,
} from "./store/paths";
import { stripControlChars } from "./format";
import { NearbyChoice, NearbyHighlightModal } from "./modals/nearby";
import { AllChatsModal, ChatPickerEntry } from "./modals/allChats";
import { readGlossary } from "./store/glossary";
import { glossaryBlockedReason, startGlossaryBuild } from "./glossaryGen";
import { GlossaryLookupModal } from "./modals/glossaryLookup";
import { AiProvider, ClaudeCliProvider } from "./ai/provider";
import { GwdgHttpProvider, GwdgModelInfo, classifyGwdgModel } from "./ai/gwdg";
import { CodexCliProvider, defaultCodexBin } from "./ai/codex";
import {
  defaultEffort,
  defaultModel,
  effortChoices,
  fillSelect,
  modelChoices,
  setDefaultEffort,
  setDefaultModel,
  validModel,
} from "./ai/catalog";
import { countReconcileWork, reconcileAnnotations } from "./reconcile";

/**
 * Augmented PDF — Phase 1 (Ask MVP) on top of the verified Phase 0 spikes.
 *
 *   - "Ask AI about selection" opens a sidebar ChatView seeded with the passage.
 *   - Streaming, multi-turn (session resume), per-chat model dropdown, inline cost.
 *   - "Save to note" writes a transcript .md carrying the PDF++ selection link.
 *   - "Write selection link (spike)" + "Preflight" kept as diagnostics.
 */

interface SmartCategory {
  label: string;
  color: string;
}

interface AugmentedPdfSettings {
  claudeBinPath: string;
  model: string; // default model for new chats
  effort: string; // default reasoning effort: "default" (CLI default) | low | medium | high | xhigh | max
  defaultColor: string;
  smartPaste: boolean;
  smartCategories: SmartCategory[];
  /**
   * When true, chat runs the CLI with `--permission-mode bypassPermissions` so vault skills
   * (e.g. /capture-idea, /ingest-raw) can write files and run shell commands. When false (default),
   * the chat is read-only (`Read,Grep,Glob` + `dontAsk`). Off by default for safety — see the
   * warning in the settings tab.
   */
  allowSkills: boolean;
  /**
   * When true, chat pre-approves the WebSearch/WebFetch tools so the model can search the web and
   * read URLs (read-only — no file writes or shell). When false (default), the chat has no internet
   * access. Off by default because web access is also a data-exfiltration channel: a malicious
   * passage could try to make the model encode conversation text into a fetched URL. Flip per-chat
   * with the "Web" toggle in the chat panel, or set the default here.
   */
  allowWeb: boolean;
  /** Model used to build per-PDF glossaries (Claude reads the PDF): "sonnet" (default) | "haiku". */
  glossaryModel: string;
  /**
   * Active AI backend: "claude" (Claude CLI, default; full features) | "codex" (OpenAI's Codex CLI,
   * ChatGPT-account auth; chat + summaries) | "gwdg" (GWDG Chat AI over HTTP; chat + summaries).
   */
  aiProvider: "claude" | "gwdg" | "codex";
  /** Path to the codex binary; "" = auto-detect (it ships inside the ChatGPT app, not on PATH). */
  codexBinPath: string;
  /** Codex model slug; "" = whatever ~/.codex/config.toml sets as the default. */
  codexModel: string;
  /** Default reasoning effort for Codex chats ("default" = Codex's configured effort). */
  codexEffort: string;
  /** GWDG Chat AI API key (Bearer). Stored locally; user-provided. */
  gwdgApiKey: string;
  /** OpenAI-compatible base URL for GWDG. */
  gwdgBaseUrl: string;
  /** GWDG model id used for chat/summaries. */
  gwdgModel: string;
  /** Last /models result, classified (hosted vs external, chat vs embedding) — backs the picker. */
  gwdgModels: GwdgModelInfo[];
  /** When gwdgModels was fetched (epoch ms; 0 = never). */
  gwdgModelsFetchedAt: number;
  /** Default reasoning choice for GWDG chats — one of the model's options, or "default". */
  gwdgEffort: string;
  /** Convert whole PDFs with GWDG's Docling (tables/structure kept) instead of local text extraction. */
  gwdgDocling: boolean;
  /**
   * Vault folder collecting chats about markdown notes, as "<root>/<note's path>/<stem>/". PDFs keep
   * their sibling "(annotations)"/"(chats)" folders; notes are gathered under one root instead so the
   * user's own note tree stays free of generated sibling folders.
   */
  mdChatsRoot: string;
  /**
   * When true, adding a note selection to a chat drops a "💬 chat" link back to that chat next to the
   * passage in the source note (written once the chat is first saved). Markdown sources only.
   */
  linkSelectionToChat: boolean;
}

const DEFAULT_SMART_CATEGORIES: SmartCategory[] = [
  { label: "Background knowledge", color: "#faf285" },
  { label: "Definition", color: "#69d929" },
  { label: "Example", color: "#c4fa71" },
  { label: "Results", color: "#ffd100" },
  { label: "Methods and modeling", color: "#e3d9ff" },
  { label: "Limitations and challenges", color: "#cccccc" },
  { label: "Note or question", color: "#99c2f1" },
  { label: "Goal", color: "#ffbf9e" },
];

const DEFAULT_SETTINGS: AugmentedPdfSettings = {
  claudeBinPath: "claude",
  model: "haiku",
  effort: "default",
  defaultColor: "yellow",
  smartPaste: false,
  smartCategories: DEFAULT_SMART_CATEGORIES.map((c) => ({ ...c })),
  allowSkills: false,
  allowWeb: false,
  glossaryModel: "sonnet",
  aiProvider: "claude",
  codexBinPath: "",
  codexModel: "",
  codexEffort: "default",
  gwdgApiKey: "",
  gwdgBaseUrl: "https://chat-ai.academiccloud.de/v1",
  gwdgModel: "meta-llama-3.1-8b-instruct",
  gwdgModels: [],
  gwdgModelsFetchedAt: 0,
  gwdgEffort: "default",
  gwdgDocling: true,
  mdChatsRoot: "chats",
  linkSelectionToChat: true,
};

/**
 * Convert a CSS color (name or hex) to PDF++'s "r,g,b" link param, so the highlight renders in
 * that exact color regardless of the user's PDF++ palette. PDF++ treats a comma-triplet as an rgb
 * color but any other string as a palette NAME (which only renders if defined in their palette,
 * else falls back to yellow). If the value isn't a valid CSS color, pass it through as a name.
 */
function cssColorToRgbParam(color: string): string {
  try {
    const el = document.createElement("span");
    el.style.color = "";
    el.style.color = color;
    if (el.style.color === "") return color; // browser rejected it → treat as a PDF++ palette name
    el.style.display = "none";
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color; // e.g. "rgb(91, 155, 213)"
    el.remove();
    const m = computed.match(/\d+/g);
    return m && m.length >= 3 ? `${m[0]},${m[1]},${m[2]}` : color;
  } catch {
    return color;
  }
}

/**
 * Resolve a CSS color (name or hex) to "#rrggbb" for the visual color picker, or null if it isn't a
 * real CSS color (e.g. a PDF++ palette name) — in which case the swatch keeps its current value and
 * the free-form text field remains the source of truth.
 */
function cssColorToHex(color: string): string | null {
  try {
    const el = document.createElement("span");
    el.style.color = "";
    el.style.color = color;
    if (el.style.color === "") return null;
    el.style.display = "none";
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color; // "rgb(r, g, b)" / "rgba(r, g, b, a)"
    el.remove();
    const m = computed.match(/\d+/g);
    if (!m || m.length < 3) return null;
    const h = (n: string) => Number(n).toString(16).padStart(2, "0");
    return `#${h(m[0])}${h(m[1])}${h(m[2])}`;
  } catch {
    return null;
  }
}

export default class AugmentedPdfPlugin extends Plugin {
  settings: AugmentedPdfSettings = DEFAULT_SETTINGS;

  /** Live `claude` child processes across all chats (incl. detached/background replies), tracked so
   *  we can kill them on plugin unload — otherwise a reply in flight at disable/reload is orphaned. */
  readonly liveChildren = new Set<{ kill(): void }>();

  /** Full ids of the per-category smart-paste commands currently registered, so we can remove the
   *  stale ones when categories are added/removed/renamed in settings (re-registration). */
  private smartPasteCommandIds: string[] = [];

  /** The in-flight glossary build, so it can be cancelled and concurrent builds prevented. */
  private activeGlossaryBuild: { cancel: () => void; pdf: string } | null = null;

  onunload(): void {
    for (const c of this.liveChildren) {
      try {
        c.kill();
      } catch {
        /* ignore */
      }
    }
    this.liveChildren.clear();
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AugmentedPdfSettingTab(this.app, this));

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    // Render an action button inside hub notes ("New chat") and transcripts ("Continue chat").
    this.registerMarkdownCodeBlockProcessor("augmented-pdf-chat", (_src, el, ctx) => {
      const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
      if (!(f instanceof TFile)) return;
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      const type = fm?.["augmented-pdf"];
      if (type === "transcript") {
        const btn = el.createEl("button", { cls: "mod-cta apc-hub-btn", text: "↻ Continue this chat in the sidebar" });
        btn.onclick = () => void this.openChatFromTranscript(f);
      } else {
        const actions = el.createDiv({ cls: "apc-hub-actions" });
        const what =
          fm?.scope !== "file" ? "this highlight" : fm?.kind === "md" ? "this note" : "this document";
        const newBtn = actions.createEl("button", {
          cls: "mod-cta apc-hub-btn",
          text: `💬 New chat about ${what}`,
        });
        newBtn.onclick = () => void this.openChatFromHub(f);
        // Existing chats for THIS anchor are otherwise stranded on the hub — surface a picker that
        // opens one straight in the sidebar. Gated on chat-count so it only shows when there are chats.
        const count = Number(fm?.["chat-count"] ?? 0);
        if (count > 0) {
          const openBtn = actions.createEl("button", {
            cls: "apc-hub-btn apc-hub-open",
            text: `📂 Open a saved chat (${count})  ▾`,
          });
          openBtn.onclick = (evt) => void this.showHubChatPicker(f, evt);
        }
      }
    });

    // Keep annotation/chat folders in sync when a PDF or a note is renamed or moved.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onSourceRenamed(file, oldPath)));

    this.app.workspace.onLayoutReady(() => {
      this.wire();
      window.setTimeout(() => void this.reconcileNudge(), 4000);
    });

    this.addCommand({
      // Id kept from when this was selection-only, so existing hotkey bindings survive.
      id: "ask-claude-open-chat",
      name: "Ask AI about this file or selection (open chat)",
      // Default Cmd/Ctrl+Esc — rebindable in Settings → Hotkeys.
      hotkeys: [{ modifiers: ["Mod"], key: "Escape" }],
      callback: () => void this.newChatForActiveFile(),
    });
    this.addCommand({
      // Invoked by hotkey, focus is still in the note/PDF, so the selection is always readable here.
      id: "add-selection-to-chat",
      name: "Add the current selection to the open chat (as a quote)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "Escape" }],
      callback: () => void this.addSelectionToChat(),
    });
    this.addCommand({
      id: "ask-claude-general-chat",
      name: "Ask AI (general chat / run a vault skill)",
      callback: () => void this.openGeneralChat(),
    });
    this.addCommand({
      id: "new-chat-on-annotation",
      name: "Ask AI: new chat on this annotation (run from a hub note)",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        const isHub =
          !!f && f.extension === "md" && this.isHubNote(f);
        if (isHub) {
          if (!checking) void this.openChatFromHub(f!);
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "continue-chat-from-transcript",
      name: "Continue this chat in the sidebar (run from a transcript)",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        const isTranscript =
          !!f &&
          f.extension === "md" &&
          this.app.metadataCache.getFileCache(f)?.frontmatter?.["augmented-pdf"] === "transcript";
        if (isTranscript) {
          if (!checking) void this.openChatFromTranscript(f!);
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "reconcile-annotations",
      name: "Reconcile annotations (re-link chats & finish pending summaries)",
      callback: () => void reconcileAnnotations(this, { generateSummaries: true }),
    });
    this.addCommand({
      id: "toggle-highlight-clickthrough",
      name: "Toggle highlight click-through (select text under highlights)",
      callback: () => {
        const on = document.body.classList.toggle("augmented-pdf-clickthrough");
        new Notice(
          on
            ? "Highlight click-through ON — you can select text under highlights (double-click to open is disabled)."
            : "Highlight click-through OFF.",
          6000
        );
      },
    });
    this.addCommand({
      id: "spike-write-selection-link",
      name: "Write selection link (test PDF++ highlight)",
      callback: () => void this.spikeWriteSelectionLink(),
    });
    this.addCommand({
      id: "preflight",
      name: "Preflight (PDF++ + claude auth)",
      callback: () => void this.preflight(),
    });

    this.addCommand({
      id: "glossary-lookup",
      name: "Glossary: look up a term",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        if (f && f.extension === "pdf") {
          if (!checking) void this.openGlossaryLookup(f);
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "glossary-build",
      name: "Glossary: build / refresh for this PDF",
      checkCallback: (checking: boolean) => {
        const f = this.app.workspace.getActiveFile();
        if (f && f.extension === "pdf") {
          if (!checking) void this.runGlossaryBuild(f);
          return true;
        }
        return false;
      },
    });
    this.addCommand({
      id: "glossary-cancel-build",
      name: "Glossary: cancel running build",
      checkCallback: (checking: boolean) => {
        if (this.activeGlossaryBuild) {
          if (!checking) this.activeGlossaryBuild.cancel();
          return true;
        }
        return false;
      },
    });

    // Smart paste: one bindable command per color category. Re-registerable so settings edits
    // (add / remove / rename) take effect without a reload.
    this.registerSmartPasteCommands();

    console.log("[augmented-pdf] loaded (Phase 1: chat view)");
  }

  /**
   * (Re)register the per-category "Smart paste: <label>" commands from the current settings. Called at
   * load and after the settings tab edits categories, so add/remove/rename take effect immediately.
   * Removes previously-registered commands first so renamed/deleted categories don't leave stale ones.
   */
  registerSmartPasteCommands(): void {
    const commands = (this.app as unknown as { commands?: { removeCommand?: (id: string) => void } }).commands;
    for (const fullId of this.smartPasteCommandIds) {
      try {
        commands?.removeCommand?.(fullId);
      } catch {
        /* removeCommand is semi-private; if unavailable, stale commands clear on next reload */
      }
    }
    this.smartPasteCommandIds = [];
    const seen = new Set<string>();
    for (const cat of this.settings.smartCategories) {
      const label = cat.label?.trim();
      if (!label) continue; // a blank label gets no command
      const id = `smart-paste-${slugify(label)}`;
      if (seen.has(id)) continue; // duplicate label → a single command (ids must stay unique)
      seen.add(id);
      this.addCommand({
        id,
        name: `Smart paste: ${label}`,
        checkCallback: (checking: boolean) => {
          const f = this.app.workspace.getActiveFile();
          const ok = !!f && f.extension === "pdf";
          if (ok) {
            if (!checking) void this.smartPaste(cat);
            return true;
          }
          return false;
        },
      });
      this.smartPasteCommandIds.push(`${this.manifest.id}:${id}`);
    }
  }

  /** Wire the PDF++ context menu once everything is loaded. */
  private wire(): void {
    if (!isPdfPlusEnabled(this.app)) {
      new Notice("Augmented PDF: PDF++ not found. Install & enable it.", 8000);
      return;
    }
    this.registerEvent(
      // "pdf-menu" is a PDF++ event (not in Obsidian's typed API).
      (this.app.workspace as any).on("pdf-menu", (menu: Menu) => {
        menu.addItem((item) =>
          item
            .setTitle("Ask AI about selection")
            .setIcon("bot")
            .onClick(() => void this.newChatForActiveFile())
        );
        menu.addItem((item) =>
          item
            .setTitle("Write selection link (spike)")
            .setIcon("link")
            .onClick(() => void this.spikeWriteSelectionLink())
        );
      })
    );
    console.log("[augmented-pdf] pdf-menu hook active");
  }

  vaultCwd(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : process.cwd();
  }

  /**
   * Docling Markdown for a vault PDF, converted by GWDG and cached on disk so a paper is converted once
   * (until it changes). The cache lives in the plugin folder under .obsidian, which vault repos ignore.
   */
  async doclingMarkdown(path: string): Promise<string> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new Error("PDF not found: " + path);
    const dir = `${this.manifest.dir}/docling-cache`;
    const file = `${dir}/${createHash("sha1").update(`${path}|${f.stat.mtime}|${f.stat.size}`).digest("hex")}.md`;
    const ad = this.app.vault.adapter;
    if (await ad.exists(file)) return ad.read(file);
    const md = await new GwdgHttpProvider(this).convertPdf(new Uint8Array(await this.app.vault.readBinary(f)), f.name);
    try {
      if (!(await ad.exists(dir))) await ad.mkdir(dir);
      await ad.write(file, md);
    } catch (e) {
      console.warn("[augmented-pdf] couldn't cache Docling output", e); // still usable this time
    }
    return md;
  }

  /** Rebuild open chat panels' provider-dependent controls (model/effort lists, toggles) after a switch. */
  refreshChatViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      if (leaf.view instanceof ChatView) leaf.view.onProviderChanged();
    }
  }

  /** The active AI backend — Claude CLI (default) or GWDG Chat AI. */
  getProvider(): AiProvider {
    if (this.settings.aiProvider === "gwdg") return new GwdgHttpProvider(this);
    if (this.settings.aiProvider === "codex") return new CodexCliProvider(this);
    return new ClaudeCliProvider(this);
  }

  private async activateChatView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  /**
   * Start a chat about whatever is open. A PDF text selection anchors the chat to that highlight
   * (the original behavior); with no selection — or in a markdown note — the chat is about the whole
   * file. Nothing open at all falls back to a context-free chat.
   */
  async newChatForActiveFile(preselected?: string): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      await this.openGeneralChat();
      return;
    }
    if (file.extension === "pdf") {
      await this.openChatForPdf(file, preselected);
      return;
    }
    if (file.extension === "md") {
      await this.openChatForNote(file, preselected);
      return;
    }
    new Notice(`Chats work on PDFs and notes — "${file.name}" is neither.`);
  }

  /** PDF: anchor to the selected highlight if there is one, else chat about the whole document. */
  private async openChatForPdf(file: TFile, preselected?: string): Promise<void> {
    const info = getSelectionInfo(this.app);
    // PDF text extraction can yield NUL/control bytes; strip them so they never reach the prompt
    // (which would crash spawn) or the saved notes.
    const text = (preselected ?? stripControlChars(getSelectedText(this.app))).trim();

    if (!info || !text) {
      // Anchoring needs `info` (the live page+selection key), which a click into the sidebar can
      // collapse. The TEXT may still have survived as a mousedown snapshot — keep it as the chat's
      // focus rather than dropping it, even though this chat is scoped to the whole document.
      await this.startChat({
        scope: "file",
        kind: "pdf",
        fileName: file.name,
        filePath: file.path,
        passage: text || undefined,
        litNote: this.findLitNote(file.path, file.name),
      });
      return;
    }

    const ctx: SelectionContext = {
      scope: "selection",
      kind: "pdf",
      fileName: file.name,
      filePath: file.path,
      page: info.page,
      selId: info.selId,
      color: cssColorToRgbParam(this.settings.defaultColor),
      passage: text,
      litNote: this.findLitNote(file.path, file.name),
    };

    // If this selection overlaps an existing highlight (but isn't identical), offer to fold the
    // chat into that highlight's accumulating annotation rather than create a near-duplicate.
    if (!findHub(this.app, ctx, this.settings.mdChatsRoot)) {
      const nearby = findNearbyHubs(this.app, ctx, this.settings.mdChatsRoot);
      if (nearby.length) {
        const choice = await new Promise<NearbyChoice>((resolve) =>
          new NearbyHighlightModal(this.app, nearby[0], resolve).open()
        );
        if (choice === "existing") {
          const n = nearby[0];
          ctx.selId = n.selId;
          ctx.page = n.page;
          if (n.passage) ctx.passage = n.passage;
          if (n.color) ctx.color = n.color;
        }
      }
    }
    await this.startChat(ctx);
  }

  /** Markdown: chat about the whole note (any selection rides along as context, not as an anchor). */
  private async openChatForNote(file: TFile, preselected?: string): Promise<void> {
    // Our own generated notes aren't chat subjects — "New chat" from one means what its button means.
    const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.["augmented-pdf"];
    if (type === "hub") {
      await this.openChatFromHub(file);
      return;
    }
    if (type === "transcript") {
      await this.openChatFromTranscript(file);
      return;
    }
    const passage = (preselected ?? this.currentSelectionText()).trim();
    await this.startChat({
      scope: "file",
      kind: "md",
      fileName: file.name,
      filePath: file.path,
      passage: passage || undefined,
    });
  }

  /** Text selected in the open PDF or note, or "". See activeSelection.ts for why it works this way. */
  currentSelectionText(): string {
    return currentSelectionText(this.app);
  }

  /** Send whatever is selected in the open note/PDF into the chat as a quote. */
  async addSelectionToChat(preselected?: string): Promise<void> {
    const text = (preselected ?? this.currentSelectionText()).trim();
    if (!text) {
      new Notice("Select some text in a note or PDF first, then add it to the chat.");
      return;
    }
    const view = await this.activateChatView();
    if (!view) {
      new Notice("Couldn't open the chat panel.");
      return;
    }

    // A quote on its own is useless: without a context the chat is a GENERAL one, so the model gets
    // the passage and nothing of the document it came from — all it can say is "tell me the context".
    // So make sure the chat is scoped to the file the selection came from.
    if (!view.hasContext()) {
      if (view.isPristine()) {
        // Nothing said yet → just start the chat on this file, with the selection as its focus.
        await this.newChatForActiveFile(text);
        return;
      }
      // A general chat already underway: re-scoping would discard it (general chats are never saved
      // to a note), so keep the thread and attach the source file as context instead.
      const f = this.app.workspace.getActiveFile();
      if (f && (f.extension === "md" || f.extension === "pdf")) view.attachFile(f.path);
    }
    view.insertQuote(text);
    // Link the source note back to this chat, next to the passage. (New-chat-from-selection is
    // handled in setContext; this covers adding a selection to an already-running chat.)
    const src = this.app.workspace.getActiveFile();
    if (src?.extension === "md") view.queueBacklink(src.path, text);
  }

  private async startChat(ctx: ChatContext): Promise<void> {
    const view = await this.activateChatView();
    if (!view) {
      new Notice("Couldn't open the chat panel.");
      return;
    }
    view.setContext(ctx);
  }

  /** Open a context-free chat (no PDF passage) — for vault-wide skills and general Q&A. */
  private async openGeneralChat(): Promise<void> {
    const view = await this.activateChatView();
    if (!view) {
      new Notice("Couldn't open the chat panel.");
      return;
    }
    view.startGeneralChat();
  }

  /** Open the glossary lookup modal for a PDF (the modal offers to build if none exists yet). */
  async openGlossaryLookup(pdf: TFile): Promise<void> {
    new GlossaryLookupModal(this.app, this, pdf).open();
  }

  /** Build (or refresh) a PDF's glossary in the background, with a live, cancellable progress notice. */
  async runGlossaryBuild(pdf: TFile): Promise<void> {
    const blocked = glossaryBlockedReason(this.settings);
    if (blocked) {
      new Notice(blocked, 15000);
      return;
    }
    if (this.activeGlossaryBuild) {
      new Notice("A glossary build is already running — cancel it first or wait for it to finish.");
      return;
    }
    const existed = !!(await readGlossary(this.app, pdf.path, pdf.name));
    const verb = existed ? "Refreshing" : "Building";
    const started = Date.now();
    let last: { phase: string; terms: number; costUsd: number } = { phase: "starting", terms: 0, costUsd: 0 };
    const elapsed = () => {
      const s = Math.floor((Date.now() - started) / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    const line = () =>
      `${verb} glossary “${pdf.basename}” · ${last.phase}` +
      `${last.terms ? ` · ~${last.terms} terms` : ""}${last.costUsd ? ` · ~$${last.costUsd.toFixed(2)}` : ""} · ${elapsed()} elapsed`;
    // A persistent notice AND a status-bar item, both ticking every second — so the build's liveness is
    // visible even during the multi-minute read/think phase that streams no text.
    const notice = new Notice(line(), 0);
    const statusEl = this.addStatusBarItem();
    const paint = () => {
      notice.setMessage(line());
      statusEl.setText(`⏳ Glossary ${elapsed()}`);
    };
    paint();
    const tick = window.setInterval(paint, 1000);
    this.registerInterval(tick);
    const build = startGlossaryBuild(this, pdf.path, pdf.name, (u) => {
      last = u;
      paint();
    });
    this.activeGlossaryBuild = { cancel: build.cancel, pdf: pdf.path };
    try {
      const res = await build.promise;
      window.clearInterval(tick);
      notice.hide();
      statusEl.remove();
      const resumeHint = res.count ? ` Saved ${res.count} terms — run “Glossary: build / refresh” to resume.` : "";
      if (res.error === "cancelled") {
        new Notice(`Glossary build cancelled.${resumeHint}`, 8000);
      } else if (res.error) {
        // Persistent (timeout 0) so the cause can't flash by unseen; also logged for the console.
        new Notice(`⚠️ Glossary build error: ${res.error}.${resumeHint}`, 0);
        console.error("[augmented-pdf] glossary build error:", res.error);
      } else {
        const cost = res.costUsd ? ` (~$${res.costUsd.toFixed(2)})` : "";
        new Notice(`✓ Glossary ${existed ? "refreshed" : "built"}: ${res.count} term${res.count === 1 ? "" : "s"}${cost}.`, 12000);
      }
    } catch (e) {
      window.clearInterval(tick);
      notice.hide();
      statusEl.remove();
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`⚠️ Glossary build crashed: ${msg} (see console).`, 0); // persistent
      console.error("[augmented-pdf] glossary build crashed", e);
    } finally {
      this.activeGlossaryBuild = null;
    }
  }

  /** Rename/move the sibling (annotations)/(chats) folders when a PDF is renamed or moved. */
  private async onSourceRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile)) return;
    if (file.extension === "md") return this.onNoteRenamed(file, oldPath);
    if (file.extension !== "pdf") return;
    const oldStem = oldPath.replace(/^.*\//, "").replace(/\.pdf$/i, "");
    const oldDir = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
    const newStem = file.basename;
    const newDir = file.parent && file.parent.path !== "/" ? file.parent.path : "";
    if (oldStem === newStem && oldDir === newDir) return;

    for (const suffix of ["(annotations)", "(chats)"]) {
      const oldFolderPath = (oldDir ? oldDir + "/" : "") + `${oldStem} ${suffix}`;
      const folder = this.app.vault.getAbstractFileByPath(oldFolderPath);
      if (folder instanceof TFolder) {
        const newFolderPath = (newDir ? newDir + "/" : "") + `${newStem} ${suffix}`;
        try {
          await this.app.fileManager.renameFile(folder, newFolderPath);
        } catch (e) {
          console.error("[augmented-pdf] folder rename failed", oldFolderPath, "->", newFolderPath, e);
          new Notice(`Augmented PDF: couldn't rename "${suffix}" folder for the renamed PDF (see console).`, 8000);
        }
      }
    }

    // The glossary is a FILE (not a folder), so it needs its own rename + frontmatter backlink fix —
    // adding "(glossary)" to the folder loop above would silently no-op (that loop checks TFolder).
    const oldGloss = (oldDir ? oldDir + "/" : "") + `${oldStem} (glossary).md`;
    const gf = this.app.vault.getAbstractFileByPath(oldGloss);
    if (gf instanceof TFile) {
      const newGloss = (newDir ? newDir + "/" : "") + `${newStem} (glossary).md`;
      try {
        await this.app.fileManager.renameFile(gf, newGloss);
        await this.app.vault.process(gf, (c) => c.replace(/^pdf: .*$/m, `pdf: "[[${file.name}]]"`));
      } catch (e) {
        console.error("[augmented-pdf] glossary rename failed", oldGloss, "->", newGloss, e);
        new Notice("Augmented PDF: couldn't rename the glossary note for the renamed PDF (see console).", 8000);
      }
    }
  }

  /**
   * Keep a note's chat folder in step when the note is renamed or moved. The folder path mirrors the
   * note's path, so without this the chats (and their accumulated summaries) would be orphaned: the
   * next chat would silently start a second folder under the new path.
   */
  private async onNoteRenamed(file: TFile, oldPath: string): Promise<void> {
    const root = this.settings.mdChatsRoot;
    const oldFolderPath = mdChatFolder(oldPath, root);
    const newFolderPath = mdChatFolder(file.path, root);
    if (oldFolderPath === newFolderPath) return;
    // Renaming one of our OWN notes (a hub/transcript living under the root) must not cascade.
    if (oldPath.startsWith(root.replace(/^\/+|\/+$/g, "") + "/")) return;
    const folder = this.app.vault.getAbstractFileByPath(oldFolderPath);
    if (!(folder instanceof TFolder)) return;
    try {
      await this.ensureParentFolder(newFolderPath);
      await this.app.fileManager.renameFile(folder, newFolderPath);
      // The stored path is authoritative for finding a note's chats, so it has to follow the note.
      // (Obsidian rewrites the `source:` wikilink itself, but never a plain string field.)
      for (const child of folder.children) {
        if (child instanceof TFile && child.extension === "md") {
          await this.app.vault.process(child, (c) =>
            c.replace(/^source-path: .*$/m, `source-path: ${JSON.stringify(file.path)}`)
          );
        }
      }
    } catch (e) {
      console.error("[augmented-pdf] note chat-folder rename failed", oldFolderPath, "->", newFolderPath, e);
      new Notice("Augmented PDF: couldn't move the chats folder for the renamed note (see console).", 8000);
    }
  }

  /** Create everything above `path` so a rename into a fresh subtree doesn't fail. */
  private async ensureParentFolder(path: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (!parent) return;
    let cur = "";
    for (const seg of parent.split("/").filter(Boolean)) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (this.app.vault.getAbstractFileByPath(cur)) continue;
      try {
        await this.app.vault.createFolder(cur);
      } catch {
        /* exists or race — fine */
      }
    }
  }

  /** No-API startup nudge: tell the user if there's reconcile work, don't do it automatically. */
  private async reconcileNudge(): Promise<void> {
    try {
      const { missing, pending } = await countReconcileWork(this);
      if (missing + pending > 0) {
        new Notice(
          `Augmented PDF: ${missing} unlinked chat${missing === 1 ? "" : "s"}, ` +
            `${pending} pending summar${pending === 1 ? "y" : "ies"}. ` +
            `Run "Reconcile annotations" to fix.`,
          10000
        );
      }
    } catch (e) {
      console.warn("[augmented-pdf] reconcile nudge failed", e);
    }
  }

  /**
   * Find the sibling literature note to cross-link (e.g. the Zotero note {citekey}.md next to
   * {citekey}.pdf). Primary: same-stem sibling. Fallback: the only markdown note directly in the
   * PDF's folder (our annotation/chat notes live in subfolders, so they don't count).
   */
  private findLitNoteFile(pdfPath: string, pdfName: string): TFile | null {
    const stem = pdfName.replace(/\.pdf$/i, "");
    const i = pdfPath.lastIndexOf("/");
    const dir = i >= 0 ? pdfPath.slice(0, i) : "";
    const same = this.app.vault.getAbstractFileByPath((dir ? dir + "/" : "") + stem + ".md");
    if (same instanceof TFile) return same;
    const folder = dir ? this.app.vault.getAbstractFileByPath(dir) : this.app.vault.getRoot();
    if (folder instanceof TFolder) {
      const mds = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
      if (mds.length === 1) return mds[0];
    }
    return null;
  }

  private findLitNote(pdfPath: string, pdfName: string): string | undefined {
    return this.findLitNoteFile(pdfPath, pdfName)?.basename;
  }

  /** Like findLitNoteFile but creates `<pdf-stem>.md` next to the PDF if none exists. */
  private async resolveLitNoteFile(pdf: TFile): Promise<TFile> {
    const existing = this.findLitNoteFile(pdf.path, pdf.name);
    if (existing) return existing;
    const dir = pdf.parent && pdf.parent.path !== "/" ? pdf.parent.path : "";
    const path = (dir ? dir + "/" : "") + pdf.basename + ".md";
    return this.app.vault.create(path, `# ${pdf.basename}\n`);
  }

  /** Smart paste: file a colored highlight link under the matching `## <label>` in the lit note. */
  async smartPaste(cat: SmartCategory): Promise<void> {
    if (!this.settings.smartPaste) {
      new Notice("Smart paste is off — enable it in Augmented PDF settings.");
      return;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "pdf") {
      new Notice("Open a PDF and select some text first.");
      return;
    }
    const info = getSelectionInfo(this.app);
    if (!info) {
      new Notice("No PDF selection detected (select text, then try again).");
      return;
    }
    const excerpt = oneLine(getSelectedText(this.app));
    const alias = (excerpt || `p.${info.page}`).replace(/[[\]|]/g, " ").slice(0, 120);
    const link = `[[${file.name}#page=${info.page}&selection=${info.selId}&color=${cssColorToRgbParam(cat.color)}|${alias}]]`;
    try {
      const lit = await this.resolveLitNoteFile(file);
      await this.app.vault.process(lit, (c) => appendUnderHeading(c, cat.label, `- ${link}`));
      new Notice(`Smart paste → ${cat.label} · ${lit.basename}`);
    } catch (e) {
      console.error("[augmented-pdf] smart paste failed", e);
      new Notice(`Smart paste failed: ${(e as Error).message}`);
    }
  }

  private isHubNote(file: TFile): boolean {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.["augmented-pdf"] === "hub";
  }

  /**
   * Rebuild a ChatContext from a hub/transcript's frontmatter.
   *
   * Tolerates legacy notes, which predate `scope`/`source`/`kind` and are always PDF selections: an
   * absent `scope` means "selection", and `pdf:` stands in for `source:`. `source-path` is preferred
   * over the wikilink because note basenames are not unique in this vault.
   */
  private ctxFromFrontmatter(
    fm: Record<string, unknown>,
    notePath: string,
    passage: string
  ): ChatContext | null {
    const linkPath = (v: unknown) =>
      String(v ?? "")
        .replace(/^\[\[|\]\]$/g, "")
        .split("|")[0]
        .trim();
    const srcPath = typeof fm["source-path"] === "string" ? fm["source-path"] : "";
    const srcLink = linkPath(fm.source) || linkPath(fm.pdf);

    let file: TFile | null = null;
    if (srcPath) {
      const f = this.app.vault.getAbstractFileByPath(srcPath);
      if (f instanceof TFile) file = f;
    }
    if (!file && srcLink) {
      const f = this.app.metadataCache.getFirstLinkpathDest(srcLink, notePath);
      if (f instanceof TFile) file = f;
    }
    const filePath = file?.path || srcPath || srcLink;
    const fileName = file?.name || filePath.split("/").pop() || "";
    if (!filePath || !fileName) return null;

    const kind: SourceKind =
      fm.kind === "md" || fm.kind === "pdf" ? fm.kind : /\.pdf$/i.test(fileName) ? "pdf" : "md";
    const litNote = kind === "pdf" ? this.findLitNote(filePath, fileName) : undefined;
    const attachments = Array.isArray(fm.context) ? fm.context.map(String) : undefined;

    if (fm.scope !== "file") {
      const page = Number(fm.page);
      const selId = String(fm.selection ?? "");
      if (kind !== "pdf" || !page || !selId) return null;
      return {
        scope: "selection",
        kind: "pdf",
        fileName,
        filePath,
        page,
        selId,
        color: String(fm.color ?? this.settings.defaultColor),
        passage,
        litNote,
        attachments,
      };
    }
    return { scope: "file", kind, fileName, filePath, passage: passage || undefined, litNote, attachments };
  }

  /** Start a fresh chat on an existing hub's anchor, straight from the hub note. */
  async openChatFromHub(hubFile: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(hubFile)?.frontmatter;
    if (!fm || fm["augmented-pdf"] !== "hub") {
      new Notice("This isn't an Augmented PDF annotation note.");
      return;
    }
    // A selection hub's passage IS its anchor, so it must be recovered; a file hub has no quote.
    let passage = typeof fm.passage === "string" ? fm.passage : "";
    if (!passage && fm.scope !== "file") passage = extractQuotePassage(await this.app.vault.cachedRead(hubFile));
    const ctx = this.ctxFromFrontmatter(fm, hubFile.path, passage);
    if (!ctx) {
      new Notice("Annotation note is missing the metadata needed to reopen it (source/page/selection).");
      return;
    }
    await this.startChat(ctx);
  }

  /** All saved chats stored alongside this context's file (newest first) — the in-panel picker. */
  async listFileChats(ctx: ChatContext): Promise<{ file: TFile; label: string; created: number }[]> {
    return this.listChatsIn(transcriptsFolder(ctx, this.settings.mdChatsRoot));
  }

  /** Transcript entries in one folder, newest first. */
  private async listChatsIn(
    folderPath: string,
    keep?: (fm: Record<string, unknown>) => boolean
  ): Promise<{ file: TFile; label: string; created: number }[]> {
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!(folder instanceof TFolder)) return [];
    const out: { file: TFile; label: string; created: number }[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      if (!fm || fm["augmented-pdf"] !== "transcript") continue;
      if (keep && !keep(fm)) continue;
      const createdMs = fm.created ? Date.parse(String(fm.created)) : child.stat.ctime;
      // Label = the opening question; fall back to the summary, then the filename.
      let label = "";
      try {
        const m = (await this.app.vault.cachedRead(child)).match(/^##\s+You\s*\n([^\n]+)/m);
        label = m ? oneLine(m[1]) : "";
      } catch {
        /* ignore read errors */
      }
      if (!label) label = fm.summary ? oneLine(String(fm.summary)) : child.basename;
      out.push({ file: child, label: label.slice(0, 80), created: isNaN(createdMs) ? 0 : createdMs });
    }
    out.sort((a, b) => b.created - a.created);
    return out;
  }

  /** Saved chats for ONE hub's anchor, newest first — powers the hub's "Open a chat" picker. */
  async listHubChats(hubFile: TFile): Promise<{ file: TFile; label: string; created: number }[]> {
    const hfm = this.app.metadataCache.getFileCache(hubFile)?.frontmatter;
    if (!hfm || hfm["augmented-pdf"] !== "hub") return [];
    const ctx = this.ctxFromFrontmatter(hfm, hubFile.path, String(hfm.passage ?? ""));
    if (!ctx) return [];
    return this.listChatsIn(transcriptsFolder(ctx, this.settings.mdChatsRoot), (fm) => {
      // A PDF's "(chats)" folder holds every chat on that paper, so the transcript's anchor has to
      // match this hub's — same scope, and for a selection hub the same page + selection. (Legacy
      // transcripts have no `scope`; like legacy hubs they're selections.)
      const scope = fm.scope === "file" ? "file" : "selection";
      if (scope !== ctx.scope) return false;
      if (ctx.scope !== "selection") return true;
      return Number(fm.page) === ctx.page && String(fm.selection ?? "") === ctx.selId;
    });
  }

  /** Popup menu of a hub's saved chats; selecting one opens it in the sidebar. */
  async showHubChatPicker(hubFile: TFile, evt: MouseEvent): Promise<void> {
    const entries = await this.listHubChats(hubFile);
    if (!entries.length) {
      new Notice("No saved chats here yet.");
      return;
    }
    const menu = new Menu();
    for (const e of entries) {
      menu.addItem((item) => {
        item.setTitle(e.label);
        item.setIcon("message-square");
        item.onClick(() => void this.openChatFromTranscript(e.file));
      });
    }
    menu.showAtMouseEvent(evt);
  }

  /**
   * Every saved chat transcript across the whole vault (newest first) — powers the global picker
   * reachable from the empty/default panel. Frontmatter (`augmented-pdf: transcript`) is read from
   * the metadata cache; only matched files are read (for the opening-question label).
   */
  async listAllChats(): Promise<ChatPickerEntry[]> {
    const out: ChatPickerEntry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm || fm["augmented-pdf"] !== "transcript") continue;
      const createdMs = fm.created ? Date.parse(String(fm.created)) : file.stat.ctime;
      const srcRaw = String(fm.source ?? fm.pdf ?? "")
        .replace(/^\[\[|\]\]$/g, "")
        .split("|")[0]
        .trim();
      const paper = srcRaw ? stemOf(srcRaw.split("/").pop() || srcRaw) : "";
      // Label = the opening question; fall back to the summary, then the filename (mirrors listFileChats).
      let label = "";
      try {
        const m = (await this.app.vault.cachedRead(file)).match(/^##\s+You\s*\n([^\n]+)/m);
        label = m ? oneLine(m[1]) : "";
      } catch {
        /* ignore read errors */
      }
      if (!label) label = fm.summary ? oneLine(String(fm.summary)) : file.basename;
      out.push({ file, paper, label: label.slice(0, 100), created: isNaN(createdMs) ? 0 : createdMs });
    }
    out.sort((a, b) => b.created - a.created);
    return out;
  }

  /** Open the vault-wide chat picker (works from any panel state, including the empty/default one). */
  async openChatPicker(): Promise<void> {
    const entries = await this.listAllChats();
    if (!entries.length) {
      new Notice("No saved chats yet — start one from a PDF selection.");
      return;
    }
    new AllChatsModal(this.app, entries, (e) => void this.openChatFromTranscript(e.file)).open();
  }

  /** Load an existing chat from its transcript note into the sidebar (resumes its session). */
  async openChatFromTranscript(file: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm["augmented-pdf"] !== "transcript") {
      new Notice("This isn't an Augmented PDF chat transcript.");
      return;
    }
    const link = (v: unknown) => String(v ?? "").replace(/^\[\[|\]\]$/g, "").trim();
    const content = await this.app.vault.cachedRead(file);
    const sessionId = String(fm["session-id"] ?? "");
    if (!sessionId) {
      new Notice("Transcript is missing its session id.");
      return;
    }
    const ctx = this.ctxFromFrontmatter(fm, file.path, extractQuotePassage(content));
    if (!ctx) {
      new Notice("Transcript is missing the metadata needed to reopen it (source/page/selection).");
      return;
    }
    if (!ctx.litNote && fm["lit-note"]) ctx.litNote = link(fm["lit-note"]);
    const hubName = link(fm.hub);
    const hub = hubName ? this.app.metadataCache.getFirstLinkpathDest(hubName, file.path) : null;
    const view = await this.activateChatView();
    if (!view) {
      new Notice("Couldn't open the chat panel.");
      return;
    }
    view.loadThread({
      ctx,
      sessionId,
      turns: parseTranscriptTurns(content),
      totalCost: Number(fm.cost_usd ?? 0),
      model: typeof fm.model === "string" ? fm.model : this.settings.model,
      resolvedModel: typeof fm["model-id"] === "string" ? fm["model-id"] : null,
      // Absent on every chat before Codex existed — those were all Claude chats.
      provider: typeof fm.provider === "string" ? fm.provider : "claude",
      providerSession: typeof fm["provider-session"] === "string" ? fm["provider-session"] : null,
      hubFile: hub instanceof TFile ? hub : null,
      transcriptFile: file,
      createdISO: String(fm.created ?? "") || new Date().toISOString(),
      summary: fm.summary ? String(fm.summary) : null,
    });
  }

  /** S3 diagnostic: write a note with a PDF++ selection link to confirm a highlight renders. */
  private async spikeWriteSelectionLink(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "pdf") {
      new Notice("Open a PDF and select text first.");
      return;
    }
    const info = getSelectionInfo(this.app);
    if (!info) {
      new Notice("No PDF selection detected via PDF++.");
      return;
    }
    const color = this.settings.defaultColor;
    const link = `[[${file.name}#page=${info.page}&selection=${info.selId}&color=${cssColorToRgbParam(color)}|${file.basename}, p.${info.page} (spike)]]`;
    const notePath = `AugmentedPDF-spike-${Date.now()}.md`;
    const body = `Spike S3 — confirms a PDF++ selection link renders a highlight.\n\n**Source:** ${link}\n`;
    try {
      await this.app.vault.create(notePath, body);
      new Notice(`Wrote ${notePath}. Check the PDF for a ${color} highlight.`, 8000);
    } catch (e) {
      new Notice(`Failed: ${(e as Error).message}`);
    }
  }

  private async preflight(): Promise<void> {
    execFile(this.settings.claudeBinPath, ["auth", "status"], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        new Notice(`claude not runnable: ${err.message}. Set an absolute binary path in settings.`, 10000);
        return;
      }
      let parsed: any = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        /* non-JSON */
      }
      new Notice(
        `Preflight — PDF++: ${isPdfPlusEnabled(this.app) ? "✓" : "✗"} · ` +
          `claude: ${parsed?.loggedIn ? `✓ (${parsed.subscriptionType ?? parsed.authMethod})` : "✗ not logged in"}`,
        8000
      );
    });
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Seed defaults only when the field is missing/corrupt — an intentionally-emptied list is respected.
    if (!Array.isArray(this.settings.smartCategories)) {
      this.settings.smartCategories = DEFAULT_SMART_CATEGORIES.map((c) => ({ ...c }));
    }
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class AugmentedPdfSettingTab extends PluginSettingTab {
  plugin: AugmentedPdfPlugin;
  constructor(app: App, plugin: AugmentedPdfPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  /**
   * Provider first, then everything that depends on it: that provider's connection settings, then
   * its default model and reasoning effort — listed from the shared catalog (ai/catalog.ts), so they
   * always match the selected provider. Switching provider re-renders this and refreshes any open
   * chat panel, so the panel's model/effort dropdowns follow immediately.
   */
  private renderProviderSection(containerEl: HTMLElement): void {
    const s = this.plugin.settings;
    const p = s.aiProvider;
    containerEl.createEl("h3", { text: "AI provider" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc(
        "Claude CLI (default) — full features: chat, glossary, vault skills, web. Codex CLI (OpenAI) — chat " +
          "& summaries with your ChatGPT account, read-only. GWDG Chat AI (HTTP) — chat & summaries via your " +
          "GWDG academic account. Skills, web and glossary builds always use the Claude CLI; with GWDG selected " +
          "glossary builds are switched off, since they'd send the PDF to Anthropic. The model and effort " +
          "below follow this choice, and an open chat panel updates immediately."
      )
      .addDropdown((d) =>
        d
          .addOption("claude", "Claude CLI")
          .addOption("codex", "Codex CLI (OpenAI)")
          .addOption("gwdg", "GWDG Chat AI")
          .setValue(p)
          .onChange(async (v) => {
            s.aiProvider = v === "gwdg" || v === "codex" ? v : "claude";
            await this.plugin.saveSettings();
            this.plugin.refreshChatViews();
            this.display();
          })
      );

    // ---- connection settings for the selected provider --------------------------------
    // The Claude CLI path is shown unless GWDG is selected: under Codex it's still what builds
    // glossaries; under GWDG nothing uses Claude (glossary builds are refused there).
    if (p !== "gwdg") {
      new Setting(containerEl)
        .setName("Claude CLI path")
        .setDesc(
          (p === "codex" ? "Used for glossary builds (chats use Codex). " : "") +
            "Absolute path recommended (GUI apps don't inherit your shell PATH). Find it with `which claude`."
        )
        .addText((t) =>
          t
            .setPlaceholder("claude")
            .setValue(s.claudeBinPath)
            .onChange(async (v) => {
              s.claudeBinPath = v.trim() || "claude";
              await this.plugin.saveSettings();
            })
        );
    }
    if (p === "codex") {
      const detected = defaultCodexBin();
      new Setting(containerEl)
        .setName("Codex CLI path")
        .setDesc(
          `Leave empty to auto-detect (found: ${detected}). Codex ships inside the ChatGPT desktop app — ` +
            "sign in to Codex there (your ChatGPT account, no API key). Chats run in Codex's read-only " +
            "sandbox: it can read your notes and PDFs, never write."
        )
        .addText((t) =>
          t
            .setPlaceholder(detected)
            .setValue(s.codexBinPath)
            .onChange(async (v) => {
              s.codexBinPath = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }
    if (p === "gwdg") {
      new Setting(containerEl)
        .setName("GWDG API key")
        .setDesc(
          "Request one on the KISSKI LLM Service page (kisski.gwdg.de → “Book”). Stored locally in this " +
            "vault's plugin data — never share it."
        )
        .addText((t) => {
          t.setPlaceholder("paste your key")
            .setValue(s.gwdgApiKey)
            .onChange(async (v) => {
              s.gwdgApiKey = v.trim();
              await this.plugin.saveSettings();
            });
          t.inputEl.type = "password";
          t.inputEl.style.width = "22em";
        });
      new Setting(containerEl)
        .setName("GWDG base URL")
        .setDesc("OpenAI-compatible endpoint base.")
        .addText((t) =>
          t
            .setPlaceholder("https://chat-ai.academiccloud.de/v1")
            .setValue(s.gwdgBaseUrl)
            .onChange(async (v) => {
              s.gwdgBaseUrl = v.trim() || "https://chat-ai.academiccloud.de/v1";
              await this.plugin.saveSettings();
            })
        );
      new Setting(containerEl)
        .setName("Convert whole PDFs with Docling")
        .setDesc(
          "GWDG can't open files itself, so for a whole-PDF chat the paper's content is sent along. On: " +
            "GWDG's Docling service converts it to Markdown first — keeps tables and structure, can read " +
            "scanned pages; the PDF goes to GWDG (cached per file). Off: plain text is extracted locally. " +
            "Either way, if Docling fails the local extraction is used."
        )
        .addToggle((t) =>
          t.setValue(s.gwdgDocling).onChange(async (v) => {
            s.gwdgDocling = v;
            await this.plugin.saveSettings();
          })
        );
    }

    // ---- default model (this provider's list) -------------------------------------------
    const model = validModel(this.plugin, p, defaultModel(this.plugin, p));
    let desc = "Default for new chats — changeable per chat in the panel.";
    if (p === "claude") desc += " These are aliases that always track the latest model of each tier.";
    if (p === "codex") desc += " Models your ChatGPT account offers (Codex's own list); “Codex default” follows ~/.codex/config.toml.";
    if (p === "gwdg") {
      desc += s.gwdgModelsFetchedAt
        ? ` List fetched ${new Date(s.gwdgModelsFetchedAt).toLocaleDateString()}.`
        : " No list fetched yet — set your API key, then “Fetch models”.";
      const info = s.gwdgModels.find((m) => m.id === model) ?? (model ? classifyGwdgModel({ id: model }) : null);
      if (info?.kind === "embedding") desc += " ⚠ This is an EMBEDDING model and can't chat.";
      else if (info?.external)
        desc += " ⚠ EXTERNAL model: chats are proxied to OpenAI/Anthropic (they leave GWDG), and GWDG may not enable it for API keys.";
    }
    const modelSetting = new Setting(containerEl)
      .setName("Default model")
      .setDesc(desc)
      .addDropdown((d) => {
        fillSelect(d.selectEl, modelChoices(this.plugin, p), model);
        d.onChange(async (v) => {
          setDefaultModel(this.plugin, p, v);
          await this.plugin.saveSettings();
          this.display(); // effort levels (Codex) and the GWDG warning depend on the model
        });
      });
    if (p === "gwdg") {
      modelSetting.addButton((b) =>
        b.setButtonText(s.gwdgModels.length ? "Refresh list" : "Fetch models").onClick(async () => {
          b.setDisabled(true).setButtonText("Fetching…");
          try {
            const list = await new GwdgHttpProvider(this.plugin).fetchModels();
            s.gwdgModels = list;
            s.gwdgModelsFetchedAt = Date.now();
            await this.plugin.saveSettings();
            const ext = list.filter((m) => m.external).length;
            const emb = list.filter((m) => m.kind === "embedding").length;
            new Notice(`GWDG: ${list.length} models — ${list.length - ext - emb} hosted chat, ${ext} external, ${emb} embedding.`);
            this.plugin.refreshChatViews();
            this.display();
          } catch (e) {
            new Notice("Couldn't fetch models: " + (e instanceof Error ? e.message : String(e)), 8000);
            b.setDisabled(false).setButtonText(s.gwdgModels.length ? "Refresh list" : "Fetch models");
          }
        })
      );
    }

    // ---- default reasoning effort (this provider + model's levels) ---------------------
    const efforts = effortChoices(this.plugin, p, model);
    const effortSetting = new Setting(containerEl).setName(p === "gwdg" ? "Default reasoning" : "Default reasoning effort");
    if (!efforts.length) {
      effortSetting.setDesc("This model has no reasoning mode to adjust.");
    } else {
      const cur = efforts.includes(defaultEffort(this.plugin, p)) ? defaultEffort(this.plugin, p) : "default";
      effortSetting
        .setDesc(
          p === "codex"
            ? "The levels this model supports. “Default” uses Codex's configured effort."
            : p === "gwdg"
              ? "The reasoning options this model offers (from GWDG's own model table) — e.g. none/on for " +
                "Qwen 3.5, none…high for DeepSeek V4. “Default” leaves the model's own setting."
              : "Default for new chats — changeable per chat in the panel. “Default” uses the CLI's own default."
        )
        .addDropdown((d) => {
          for (const lvl of efforts) d.addOption(lvl, lvl);
          d.setValue(cur).onChange(async (v) => {
            setDefaultEffort(this.plugin, p, v);
            await this.plugin.saveSettings();
          });
        });
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderProviderSection(containerEl);

    new Setting(containerEl).setName("Highlight color").addText((t) =>
      t.setValue(this.plugin.settings.defaultColor).onChange(async (v) => {
        this.plugin.settings.defaultColor = v.trim() || "yellow";
        await this.plugin.saveSettings();
      })
    );

    containerEl.createEl("h3", { text: "Vault skills" });
    new Setting(containerEl)
      .setName("Allow skills & file writes (default)")
      .setDesc(
        "Default for new chats. Lets chats run your vault's Claude Code skills (e.g. /capture-idea, " +
          "/ingest-raw, /query-vault) — they can create/edit files and run shell commands in the vault. " +
          "Runs the CLI with bypassPermissions (no per-action approval). Off keeps chats read-only " +
          "(Read/Grep/Glob). You can also flip it per-chat with the “Skills” toggle in the chat panel. " +
          "⚠️ Only enable for vaults you trust: any text in the prompt — highlighted PDF text, anything " +
          "you paste, or a file a skill reads — could try to misuse the write/shell access. Leave it off " +
          "unless you need writes."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowSkills).onChange(async (v) => {
          this.plugin.settings.allowSkills = v;
          await this.plugin.saveSettings();
          // Keep any open chat panel's session toggle in sync with the new persisted default.
          for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
            if (leaf.view instanceof ChatView) leaf.view.applySkillDefault(v);
          }
        })
      );

    containerEl.createEl("h3", { text: "Web access" });
    new Setting(containerEl)
      .setName("Allow web search & fetch (default)")
      .setDesc(
        "Default for new chats. Lets the model search the web and read URLs (read-only — it can't " +
          "write files or run commands). Claude CLI uses its WebSearch/WebFetch tools; GWDG uses its own " +
          "server-side search, which sends search queries to an external provider such as Google and " +
          "isn't available for GWDG's external (OpenAI/Anthropic) models. Not available with Codex yet. " +
          "Flip it per-chat with the “Web” toggle in the chat panel. ⚠️ Web access is also an exfiltration " +
          "channel: text in the prompt (e.g. a highlighted PDF passage) could try to make the model " +
          "put conversation content into a fetched URL. Leave it off unless you want online lookups."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.allowWeb).onChange(async (v) => {
          this.plugin.settings.allowWeb = v;
          await this.plugin.saveSettings();
          // Keep any open chat panel's session toggle in sync with the new persisted default.
          for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
            if (leaf.view instanceof ChatView) leaf.view.applyWebDefault(v);
          }
        })
      );

    containerEl.createEl("h3", { text: "Chats about notes" });
    new Setting(containerEl)
      .setName("Note chats folder")
      .setDesc(
        "Vault folder collecting chats about markdown notes, one folder per note, mirroring the note's " +
          "path (e.g. “chats/wiki/concepts/epsilon-machine”). The path is mirrored rather than flattened " +
          "because note names aren't unique — two notes sharing a name would otherwise share a folder and " +
          "merge their summaries. PDFs are unaffected: their chats stay beside the PDF. Changing this does " +
          "NOT move existing chats."
      )
      .addText((t) =>
        t
          .setPlaceholder("chats")
          .setValue(this.plugin.settings.mdChatsRoot)
          .onChange(async (v) => {
            // Empty would scatter chat folders across the vault root; fall back to the default.
            this.plugin.settings.mdChatsRoot = v.trim().replace(/^\/+|\/+$/g, "") || "chats";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Link passages back to their chat")
      .setDesc(
        "When you add a selection from a note to a chat, drop a “💬 chat” link next to that passage " +
          "in the note, pointing to the conversation (added once the chat is first saved). The link is " +
          "placed at the end of the passage’s line, so it never alters the passage itself. Notes only — " +
          "PDFs can’t be edited."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.linkSelectionToChat).onChange(async (v) => {
          this.plugin.settings.linkSelectionToChat = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Glossary" });
    new Setting(containerEl)
      .setName("Glossary model")
      .setDesc(
        "Model used to build a paper's glossary — Claude reads the PDF and extracts terms with definitions. " +
          "Sonnet is the tested default: better definitions on dense papers (≈ $0.45–0.90 and several minutes " +
          "per paper). Haiku is cheaper and faster but occasionally shallower; the higher tiers cost more and " +
          "are untested for whole-paper extraction. Builds run in the background; look terms up with the " +
          "“Glossary: look up a term” command (bind a hotkey)."
      )
      .addDropdown((d) =>
        d
          .addOptions(Object.fromEntries(MODEL_CHOICES.map((m) => [m, m])))
          .setValue(this.plugin.settings.glossaryModel || "sonnet")
          .onChange(async (v) => {
            this.plugin.settings.glossaryModel = v;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Smart paste" });
    new Setting(containerEl)
      .setName("Enable smart paste")
      .setDesc(
        "Per-color commands that file a colored highlight link under a matching heading in the paper's literature note. Bind a hotkey to each in Settings → Hotkeys (search “Smart paste”)."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.smartPaste).onChange(async (v) => {
          this.plugin.settings.smartPaste = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Categories")
      .setDesc(
        "Each row is a “Smart paste: <label>” command (bind a hotkey in Settings → Hotkeys) that files the " +
          "highlight link under a “## <label>” heading. Pick a color with the swatch, or type a hex / CSS " +
          "color name (or a PDF++ palette name) in the field. Add/remove apply live — no reload needed."
      );

    this.plugin.settings.smartCategories.forEach((cat, i) => {
      let picker: ColorComponent | undefined;
      let colorText: TextComponent | undefined;
      const row = new Setting(containerEl);
      row.settingEl.addClass("apc-cat-row");
      // Editable label. Re-register commands on blur (not per keystroke) so the command name tracks it.
      row.addText((t) => {
        t.setPlaceholder("Label (e.g. Definitions)")
          .setValue(cat.label)
          .onChange(async (v) => {
            cat.label = v;
            await this.plugin.saveSettings();
          });
        t.inputEl.addClass("apc-cat-label");
        t.inputEl.addEventListener("blur", () => this.plugin.registerSmartPasteCommands());
      });
      // Visual RGB swatch — writes a hex value and mirrors it into the text field.
      row.addColorPicker((cp) => {
        picker = cp;
        const hex = cssColorToHex(cat.color);
        if (hex) cp.setValue(hex);
        cp.onChange(async (v) => {
          cat.color = v;
          colorText?.setValue(v);
          await this.plugin.saveSettings();
        });
      });
      // Free-form color: hex / CSS name / PDF++ palette name — kept in sync with the swatch.
      row.addText((t) => {
        colorText = t;
        t.setPlaceholder("#rrggbb / name / palette")
          .setValue(cat.color)
          .onChange(async (v) => {
            cat.color = v.trim() || cat.color;
            const hex = cssColorToHex(cat.color);
            if (hex) picker?.setValue(hex);
            await this.plugin.saveSettings();
          });
        t.inputEl.addClass("apc-cat-color");
      });
      // Remove this category (commands re-register, list re-renders).
      row.addExtraButton((b) =>
        b
          .setIcon("trash-2")
          .setTooltip("Remove this category")
          .onClick(async () => {
            this.plugin.settings.smartCategories.splice(i, 1);
            await this.plugin.saveSettings();
            this.plugin.registerSmartPasteCommands();
            this.display();
          })
      );
    });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText("+ Add category")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.smartCategories.push({ label: "New category", color: "#ffd100" });
          await this.plugin.saveSettings();
          this.plugin.registerSmartPasteCommands();
          this.display();
        })
    );
  }
}
