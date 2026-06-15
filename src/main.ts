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

interface AugmentedPdfSettings {
  claudeBinPath: string;
  model: string; // default model for new chats
  defaultColor: string;
}

const DEFAULT_SETTINGS: AugmentedPdfSettings = {
  claudeBinPath: "claude",
  model: "haiku",
  defaultColor: "yellow",
};

export default class AugmentedPdfPlugin extends Plugin {
  settings: AugmentedPdfSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new AugmentedPdfSettingTab(this.app, this));

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    // Render the "New chat about this highlight" button inside hub annotation notes.
    this.registerMarkdownCodeBlockProcessor("augmented-pdf-chat", (_src, el, ctx) => {
      const btn = el.createEl("button", {
        cls: "mod-cta apc-hub-btn",
        text: "💬 New chat about this highlight",
      });
      btn.onclick = () => {
        const f = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (f instanceof TFile) void this.openChatFromHub(f);
      };
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
  private findLitNote(pdfPath: string, pdfName: string): string | undefined {
    const stem = pdfName.replace(/\.pdf$/i, "");
    const i = pdfPath.lastIndexOf("/");
    const dir = i >= 0 ? pdfPath.slice(0, i) : "";
    const same = this.app.vault.getAbstractFileByPath((dir ? dir + "/" : "") + stem + ".md");
    if (same instanceof TFile) return same.basename;
    const folder = dir ? this.app.vault.getAbstractFileByPath(dir) : this.app.vault.getRoot();
    if (folder instanceof TFolder) {
      const mds = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
      if (mds.length === 1) return mds[0].basename;
    }
    return undefined;
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
    if (!passage) passage = await this.extractPassageFromHub(hubFile);
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

  /** Fallback for older hubs without a `passage:` field — read it from the quote callout. */
  private async extractPassageFromHub(file: TFile): Promise<string> {
    const c = await this.app.vault.cachedRead(file);
    const m = c.match(/> \[!quote\][^\n]*\n((?:>.*\n?)+)/);
    if (!m) return "";
    return m[1]
      .split("\n")
      .map((l) => l.replace(/^>\s?/, ""))
      .join("\n")
      .trim();
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
  }
}
