import { ClaudeHandlers, ClaudeResult, runClaude } from "../claude/runner";
import type AugmentedPdfPlugin from "../main";

/**
 * AI provider abstraction. Everything in the plugin used to call `runClaude` directly, hard-coupling
 * it to the Claude CLI. A provider lets a second backend (GWDG Chat AI, HTTP) implement the same
 * streaming contract so the chat/summary code is backend-agnostic.
 *
 * The handler + result types are reused from the runner verbatim (same shape both backends emit), and
 * the run handle is `{ kill(); pid? }` — which a ChildProcess already satisfies, so the CLI path is
 * structurally unchanged.
 */

export type AiHandlers = ClaudeHandlers;
export type AiResult = ClaudeResult;

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Cancellable handle for an in-flight run. A ChildProcess is structurally one of these. */
export interface AiRunHandle {
  kill(): void;
  /** Present for the CLI (the OS pid); a sentinel (-1) for HTTP so the "no process" guard passes. */
  pid?: number | null;
}

export interface AiRunOptions {
  /** The latest user message (what the CLI sends as its prompt). */
  prompt: string;
  /** System prompt — CLI appendSystemPrompt; the leading system message for HTTP. */
  systemPrompt?: string;
  /** Full conversation (incl. system) for stateless backends; CLI ignores it (uses session resume). */
  messages?: AiMessage[];
  model?: string;
  effort?: string;
  // CLI-only knobs (ignored by HTTP providers):
  allowedTools?: string;
  permissionMode?: string;
  sessionId?: string;
  resumeId?: string;
}

export interface AiProvider {
  readonly id: "claude" | "gwdg";
  readonly label: string;
  /**
   * What this backend can do — drives feature gating in the UI. `readsFiles` means it can pull a
   * vault file in on its own (the CLI's Read tool); without it, anything the model needs must be
   * inlined into the prompt — which rules out whole-PDF chats, since PDFs can't be inlined.
   */
  readonly capabilities: { skills: boolean; web: boolean; usd: boolean; readsFiles: boolean };
  run(opts: AiRunOptions, handlers: AiHandlers): AiRunHandle;
}

/** Claude CLI backend — a thin wrapper over the existing runClaude, behavior unchanged. */
export class ClaudeCliProvider implements AiProvider {
  readonly id = "claude" as const;
  readonly label = "Claude CLI";
  readonly capabilities = { skills: true, web: true, usd: true, readsFiles: true };

  constructor(private plugin: AugmentedPdfPlugin) {}

  run(opts: AiRunOptions, handlers: AiHandlers): AiRunHandle {
    return runClaude(
      {
        binPath: this.plugin.settings.claudeBinPath,
        prompt: opts.prompt,
        appendSystemPrompt: opts.systemPrompt,
        model: opts.model,
        effort: opts.effort,
        allowedTools: opts.allowedTools,
        permissionMode: opts.permissionMode,
        cwd: this.plugin.vaultCwd(),
        // Skip user-level settings (remember hook stalls on the iCloud vault) and disable MCP
        // (claude.ai connectors connect 30s each at startup) — same hardening the call sites used.
        settingSources: "project,local",
        noMcp: true,
        sessionId: opts.sessionId,
        resumeId: opts.resumeId,
      },
      handlers
    );
  }
}
