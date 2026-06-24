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
import { CHAT_VIEW_TYPE, ChatView } from "./chat/view";
import { ChatContext, EFFORT_LEVELS } from "./types";
import { getSelectedText, getSelectionInfo, isPdfPlusEnabled } from "./pdfplus";
import { findHub, findNearbyHubs } from "./store/hub";
import { parseTranscriptTurns } from "./store/transcript";
import { appendUnderHeading, chatsFolder, extractQuotePassage, oneLine, slugify, stemOf } from "./store/paths";
import { stripControlChars } from "./format";
import { NearbyChoice, NearbyHighlightModal } from "./modals/nearby";
import { AllChatsModal, ChatPickerEntry } from "./modals/allChats";
import { countReconcileWork, reconcileAnnotations } from "./reconcile";

/**
 * Augmented PDF — Phase 1 (Ask MVP) on top of the verified Phase 0 spikes.
 *
 *   - "Ask Claude about selection" opens a sidebar ChatView seeded with the passage.
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
      const type = this.app.metadataCache.getFileCache(f)?.frontmatter?.["augmented-pdf"];
      if (type === "transcript") {
        const btn = el.createEl("button", { cls: "mod-cta apc-hub-btn", text: "↻ Continue this chat in the sidebar" });
        btn.onclick = () => void this.openChatFromTranscript(f);
      } else {
        const btn = el.createEl("button", { cls: "mod-cta apc-hub-btn", text: "💬 New chat about this highlight" });
        btn.onclick = () => void this.openChatFromHub(f);
      }
    });

    // Keep annotation/chat folders in sync when a PDF is renamed or moved.
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onPdfRenamed(file, oldPath)));

    this.app.workspace.onLayoutReady(() => {
      this.wire();
      window.setTimeout(() => void this.reconcileNudge(), 4000);
    });

    this.addCommand({
      id: "ask-claude-open-chat",
      name: "Ask Claude about selection (open chat)",
      // Default Cmd/Ctrl+Esc — rebindable in Settings → Hotkeys.
      hotkeys: [{ modifiers: ["Mod"], key: "Escape" }],
      callback: () => void this.openChatForSelection(),
    });
    this.addCommand({
      id: "ask-claude-general-chat",
      name: "Ask Claude (general chat / run a vault skill)",
      callback: () => void this.openGeneralChat(),
    });
    this.addCommand({
      id: "new-chat-on-annotation",
      name: "Ask Claude: new chat on this annotation (run from a hub note)",
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
            .setTitle("Ask Claude about selection")
            .setIcon("bot")
            .onClick(() => void this.openChatForSelection())
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

  private async openChatForSelection(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    const info = getSelectionInfo(this.app);
    // PDF text extraction can yield NUL/control bytes; strip them so they never reach the prompt
    // (which would crash spawn) or the saved notes.
    const text = stripControlChars(getSelectedText(this.app));
    if (!file || file.extension !== "pdf") {
      new Notice("Open a PDF and select some text first.");
      return;
    }
    if (!info) {
      new Notice("No PDF selection detected (select text, then try again).");
      return;
    }
    const ctx: ChatContext = {
      pdfName: file.name,
      pdfPath: file.path,
      page: info.page,
      selId: info.selId,
      color: cssColorToRgbParam(this.settings.defaultColor),
      passage: text,
      litNote: this.findLitNote(file.path, file.name),
    };

    // If this selection overlaps an existing highlight (but isn't identical), offer to fold the
    // chat into that highlight's accumulating annotation rather than create a near-duplicate.
    if (!findHub(this.app, ctx)) {
      const nearby = findNearbyHubs(this.app, ctx);
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

  /** Rename/move the sibling (annotations)/(chats) folders when a PDF is renamed or moved. */
  private async onPdfRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!(file instanceof TFile) || file.extension !== "pdf") return;
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

  /** Re-open a chat for an existing highlight straight from its hub note (no PDF re-selection). */
  async openChatFromHub(hubFile: TFile): Promise<void> {
    const fm = this.app.metadataCache.getFileCache(hubFile)?.frontmatter;
    if (!fm || fm["augmented-pdf"] !== "hub") {
      new Notice("This isn't an Augmented PDF annotation note.");
      return;
    }
    const pdfName = String(fm.pdf ?? "").replace(/^\[\[|\]\]$/g, "").trim();
    const page = Number(fm.page);
    const selId = String(fm.selection ?? "");
    const color = String(fm.color ?? this.settings.defaultColor);
    let passage = typeof fm.passage === "string" ? fm.passage : "";
    if (!passage) passage = extractQuotePassage(await this.app.vault.cachedRead(hubFile));
    if (!pdfName || !selId || !page) {
      new Notice("Annotation note is missing pdf/page/selection metadata.");
      return;
    }
    const pdf = this.app.metadataCache.getFirstLinkpathDest(pdfName, hubFile.path);
    const pdfPath = pdf?.path ?? pdfName;
    const ctx: ChatContext = {
      pdfName,
      pdfPath,
      page,
      selId,
      color,
      passage,
      litNote: this.findLitNote(pdfPath, pdfName),
    };
    const view = await this.activateChatView();
    if (!view) {
      new Notice("Couldn't open the chat panel.");
      return;
    }
    view.setContext(ctx);
  }

  /** All saved chat transcripts for a paper (newest first) — powers the in-panel chat picker. */
  async listPaperChats(
    pdfPath: string,
    pdfName: string
  ): Promise<{ file: TFile; label: string; created: number }[]> {
    const folder = this.app.vault.getAbstractFileByPath(chatsFolder(pdfPath, pdfName));
    if (!(folder instanceof TFolder)) return [];
    const out: { file: TFile; label: string; created: number }[] = [];
    for (const child of folder.children) {
      if (!(child instanceof TFile) || child.extension !== "md") continue;
      const fm = this.app.metadataCache.getFileCache(child)?.frontmatter;
      if (!fm || fm["augmented-pdf"] !== "transcript") continue;
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
      const pdfRaw = String(fm.pdf ?? "").replace(/^\[\[|\]\]$/g, "").trim();
      const paper = pdfRaw ? stemOf(pdfRaw) : "";
      // Label = the opening question; fall back to the summary, then the filename (mirrors listPaperChats).
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
    const pdfName = link(fm.pdf);
    const page = Number(fm.page);
    const selId = String(fm.selection ?? "");
    const sessionId = String(fm["session-id"] ?? "");
    if (!pdfName || !selId || !page || !sessionId) {
      new Notice("Transcript is missing pdf/page/selection/session metadata.");
      return;
    }
    const pdf = this.app.metadataCache.getFirstLinkpathDest(pdfName, file.path);
    const pdfPath = pdf?.path ?? pdfName;
    const hubName = link(fm.hub);
    const hub = hubName ? this.app.metadataCache.getFirstLinkpathDest(hubName, file.path) : null;
    const ctx: ChatContext = {
      pdfName,
      pdfPath,
      page,
      selId,
      color: String(fm.color ?? this.settings.defaultColor),
      passage: extractQuotePassage(content),
      litNote: this.findLitNote(pdfPath, pdfName) ?? (fm["lit-note"] ? link(fm["lit-note"]) : undefined),
    };
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
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Claude binary path")
      .setDesc("Absolute path recommended (GUI apps don't inherit your shell PATH). Find it with `which claude`.")
      .addText((t) =>
        t
          .setPlaceholder("claude")
          .setValue(this.plugin.settings.claudeBinPath)
          .onChange(async (v) => {
            this.plugin.settings.claudeBinPath = v.trim() || "claude";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default model")
      .setDesc("Default for new chats (changeable per chat in the panel).")
      .addDropdown((d) =>
        d
          .addOptions({ haiku: "haiku", sonnet: "sonnet", opus: "opus" })
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default reasoning effort")
      .setDesc("Default for new chats (changeable per chat in the panel). “Default” uses the CLI's own default.")
      .addDropdown((d) => {
        for (const lvl of EFFORT_LEVELS) d.addOption(lvl, lvl);
        d.setValue(this.plugin.settings.effort).onChange(async (v) => {
          this.plugin.settings.effort = v;
          await this.plugin.saveSettings();
        });
      });

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
        "Default for new chats. Lets the model use WebSearch and WebFetch to look things up online " +
          "and read URLs (read-only — it can't write files or run commands). You can also flip it " +
          "per-chat with the “Web” toggle in the chat panel. ⚠️ Web access is also an exfiltration " +
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
