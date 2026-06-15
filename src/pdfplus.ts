import { App } from "obsidian";

/**
 * Defensive, typed-ish wrapper over the PDF++ plugin.
 *
 * PDF++ exposes a best-effort developer surface (NOT a stable public API):
 *   - app.plugins.plugins["pdf-plus"]            -> the plugin instance
 *   - .lib                                        -> library helpers
 *   - .lib.getPageAndTextRangeFromSelection()     -> { page, selection:{begin/endIndex/Offset} }
 *   - workspace event "pdf-menu"                  -> (menu, { pageNumber, selection, annot? })
 *
 * Everything here is wrapped in try/catch + feature-detection so version drift
 * degrades gracefully rather than crashing the plugin.
 */

export const PDF_PLUS_ID = "pdf-plus";

export interface PdfSelectionInfo {
  page: number;
  /** PDF++'s exact selection key: "beginIndex,beginOffset,endIndex,endOffset". */
  selId: string;
  begin: { index: number; offset: number };
  end: { index: number; offset: number };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function pluginsApi(app: App): any {
  return (app as any).plugins;
}

export function getPdfPlus(app: App): any | null {
  return pluginsApi(app)?.plugins?.[PDF_PLUS_ID] ?? null;
}

export function isPdfPlusEnabled(app: App): boolean {
  const enabled: Set<string> | undefined = pluginsApi(app)?.enabledPlugins;
  return Boolean(enabled?.has?.(PDF_PLUS_ID)) || Boolean(getPdfPlus(app));
}

/**
 * Resolve the current PDF text selection into PDF++'s page + 4-number selection key.
 * Returns null if PDF++ is unavailable, nothing is selected, or the internal API moved.
 */
export function getSelectionInfo(app: App): PdfSelectionInfo | null {
  const pp = getPdfPlus(app);
  try {
    // PDF++ 0.40.x exposes this on lib.copyLink (NOT lib directly); with no arg it
    // defaults to activeWindow.getSelection() and returns indices already adjusted
    // by textDivFirstIdx, i.e. matching the link's selection= format.
    const r = pp?.lib?.copyLink?.getPageAndTextRangeFromSelection?.();
    const s = r?.selection;
    if (r?.page && s && typeof s.beginIndex === "number") {
      return {
        page: r.page,
        selId: `${s.beginIndex},${s.beginOffset},${s.endIndex},${s.endOffset}`,
        begin: { index: s.beginIndex, offset: s.beginOffset },
        end: { index: s.endIndex, offset: s.endOffset },
      };
    }
  } catch (e) {
    console.warn("[augmented-pdf] getSelectionInfo failed (PDF++ internal API may have changed)", e);
  }
  return null;
}

/** The literal selected text, best-effort: PDF++ helper first, then the DOM. */
export function getSelectedText(app: App): string {
  const pp = getPdfPlus(app);
  try {
    const fromLib = pp?.lib?.getSelectedText?.();
    if (typeof fromLib === "string" && fromLib.length) return fromLib;
  } catch {
    /* fall through */
  }
  return window.getSelection()?.toString() ?? "";
}
