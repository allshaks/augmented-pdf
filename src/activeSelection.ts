import { App, MarkdownView } from "obsidian";
import { getSelectedText } from "./pdfplus";
import { stripControlChars } from "./format";

/**
 * Text currently selected in the open PDF or note, or "".
 *
 * Deliberately avoids `workspace.activeEditor` and `getActiveViewOfType`: both follow the ACTIVE
 * leaf, and clicking any button in the chat sidebar makes the sidebar active — so they go null
 * exactly when the user reaches for their selection (activeEditor is documented as "null if the
 * active view has no editor"). That was a real bug: the chat opened on the right note with the
 * passage silently dropped.
 *
 * `getActiveFile()` IS safe — it documents a fallback to the most recently active file. So we take
 * the file from there, then ask the leaf SHOWING that file for its own selection, which doesn't
 * depend on focus: CodeMirror keeps its selection when focus moves away. Reading view has no editor
 * selection, so it falls back to the DOM selection, scoped to that view's own pane so text selected
 * in the chat panel can't leak in as "the passage".
 */
export function currentSelectionText(app: App): string {
  const file = app.workspace.getActiveFile();
  if (!file) return "";
  // PDF++ owns PDF selections (it reads the DOM selection itself).
  if (file.extension === "pdf") return stripControlChars(getSelectedText(app)).trim();

  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.file?.path !== file.path) continue;
    const fromEditor = view.editor?.getSelection();
    if (fromEditor?.trim()) return stripControlChars(fromEditor).trim();
    const dom = window.getSelection();
    if (dom && !dom.isCollapsed && dom.anchorNode && view.containerEl.contains(dom.anchorNode)) {
      return stripControlChars(dom.toString()).trim();
    }
  }
  return "";
}
