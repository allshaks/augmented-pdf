import {
  App,
  FileSystemAdapter,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import { execFile } from "child_process";
import { CHAT_VIEW_TYPE, ChatView } from "./chat/view";
import { ChatContext } from "./types";
import { getSelectedText, getSelectionInfo, isPdfPlusEnabled } from "./pdfplus";
import { findHub, findNearbyHubs } from "./store/hub";
import { parseTranscriptTurns } from "./store/transcript";
import { appendUnderHeading, extractQuotePassage, oneLine, slugify } from "./store/paths";
import { NearbyChoice, NearbyHighlightModal } from "./modals/nearby";
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
  defaultColor: string;
  smartPaste: boolean;
  smartCategories: SmartCategory[];
}

const DEFAULT_SMART_CATEGORIES: SmartCategory[] = [
  { label: "Goal", color: "blue" },
  { label: "Method", color: "green" },
  { label: "Result", color: "yellow" },
  { label: "Background", color: "purple" },
  { label: "Question", color: "pink" },
];

const DEFAULT_SETTINGS: AugmentedPdfSettings = {
  claudeBinPath: "claude",
  model: "haiku",
  defaultColor: "yellow",
  smartPaste: false,
  smartCategories: DEFAULT_SMART_CATEGORIES.map((c) => ({ ...c })),
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

export default class AugmentedPdfPlugin extends Plugin {
  settings: AugmentedPdfSettings = DEFAULT_SETTINGS;

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

    // Smart paste: one bindable command per color category (registered from settings at load).
    for (const cat of this.settings.smartCategories) {
      this.addCommand({
        id: `smart-paste-${slugify(cat.label)}`,
        name: `Smart paste: ${cat.label}`,
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
    }

    console.log("[augmented-pdf] loaded (Phase 1: chat view)");
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
    const text = getSelectedText(this.app);
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
      color: this.settings.defaultColor,
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
    const link = `[[${file.name}#page=${info.page}&selection=${info.selId}&color=${color}|${file.basename}, p.${info.page} (spike)]]`;
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
    if (!Array.isArray(this.settings.smartCategories) || this.settings.smartCategories.length === 0) {
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

    new Setting(containerEl).setName("Highlight color").addText((t) =>
      t.setValue(this.plugin.settings.defaultColor).onChange(async (v) => {
        this.plugin.settings.defaultColor = v.trim() || "yellow";
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
    for (const cat of this.plugin.settings.smartCategories) {
      new Setting(containerEl)
        .setName(cat.label)
        .setDesc(`Highlight color (CSS color or a PDF++ palette name). Filed under “## ${cat.label}”.`)
        .addText((t) =>
          t.setValue(cat.color).onChange(async (v) => {
            cat.color = v.trim() || cat.color;
            await this.plugin.saveSettings();
          })
        );
    }
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Color edits apply immediately. Renaming/adding categories needs a reload (the per-category commands are registered at startup).",
    });
  }
}
