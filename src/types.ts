/** What kind of document a chat is about. */
export type SourceKind = "pdf" | "md";

interface ChatContextBase {
  /** File the chat is about, e.g. "Attention Is All You Need.pdf" / "epsilon-machine.md". */
  fileName: string;
  /** Vault-relative path to that file — the authoritative identity (basenames collide). */
  filePath: string;
  kind: SourceKind;
  /** Basename of the sibling Zotero/literature note ({stem}.md), if found, for cross-linking. */
  litNote?: string;
  /** Vault paths of extra files pulled in as context (@-mentions). Inlined into the prompt. */
  attachments?: string[];
}

/**
 * A chat anchored to ONE PDF highlight. The (page, selId) pair keys its hub note, so every chat
 * about the same highlight accumulates on the same annotation.
 */
export interface SelectionContext extends ChatContextBase {
  scope: "selection";
  kind: "pdf";
  page: number;
  selId: string; // "beginIndex,beginOffset,endIndex,endOffset"
  color: string;
  passage: string;
}

/**
 * A chat about a whole file (PDF or markdown) — no anchor, so there is exactly one hub per file
 * and every whole-file chat about it accumulates there.
 */
export interface FileContext extends ChatContextBase {
  scope: "file";
  /**
   * Text the user happened to have selected when starting. Quoted into the prompt as context only;
   * it deliberately does NOT anchor the chat, because markdown text gets edited and moved — a
   * content-keyed anchor would orphan its hub on the next edit.
   */
  passage?: string;
}

export type ChatContext = SelectionContext | FileContext;

export interface Turn {
  role: "user" | "claude";
  text: string;
  costUsd?: number;
}

/**
 * Reasoning-effort choices for the chat. "default" means omit --effort (use the CLI's own default);
 * the rest map directly to `claude --effort <level>`.
 */
export const EFFORT_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Model tiers offered in the pickers. These are ALIASES, not pinned versions — the CLI resolves each
 * to the current latest model for that tier ("opus" -> claude-opus-5 today), so the plugin follows
 * model releases with no code change. Because the alias floats, the concrete model that actually
 * answered is recorded per chat as `model-id` in the transcript.
 *
 * One list, used by every picker: it used to be spelled out separately in the chat toolbar, the
 * default-model setting and the glossary setting, which is how "fable" ended up missing from all
 * three.
 */
export const MODEL_CHOICES = ["haiku", "sonnet", "opus", "fable"] as const;
