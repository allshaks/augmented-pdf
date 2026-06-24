import { spawn, ChildProcess } from "child_process";
import { stripControlChars } from "../format";

/**
 * ClaudeRunner — drives the `claude` CLI in streaming (stream-json) mode.
 *
 * The event handling here mirrors what we VERIFIED empirically in Phase 0
 * (see scripts/spike-claude.mjs and PLAN.md §3.3 / §7):
 *   - streamed text  : type==="stream_event" -> event.type==="content_block_delta"
 *                      -> event.delta.type==="text_delta" -> event.delta.text
 *   - final envelope : type==="result" with session_id / total_cost_usd / is_error / result
 *   - dispatch on event CONTENT, never line position (hook + rate_limit events appear).
 *   - spawn with stdio[0]="ignore" to avoid the CLI's 3s stdin wait.
 *
 * Session model (verified): force the thread UUID with `--session-id` on turn 1,
 * then `--resume <same uuid>` on every follow-up — the id stays stable and history
 * accumulates correctly.
 */

export interface RunClaudeOptions {
  binPath: string;
  prompt: string;
  cwd: string;
  /** Turn 1: force a deterministic session id (a per-thread UUID). */
  sessionId?: string;
  /** Follow-up turns: resume the (same) thread UUID. */
  resumeId?: string;
  appendSystemPrompt?: string;
  model?: string;
  /** Reasoning effort: "low" | "medium" | "high" | "xhigh" | "max". Omit for the CLI default. */
  effort?: string;
  /** e.g. "Read,Grep,Glob" — read-only by default in our design. */
  allowedTools?: string;
  /** e.g. "dontAsk" — non-interactive. */
  permissionMode?: string;
  /**
   * Which settings sources to load, e.g. "project,local". We pass "project,local" to SKIP user-level
   * settings — specifically the remember plugin's SessionStart hook, which runs on every call and
   * touches the iCloud-backed vault, intermittently stalling startup for minutes. Auth (OAuth/
   * keychain) and the vault's own .claude/skills are unaffected. Omit to load all sources.
   */
  settingSources?: string;
  /**
   * When true, disable ALL MCP: emits `--strict-mcp-config --mcp-config {"mcpServers":{}}`. This stops
   * the CLI from connecting to the account's claude.ai connectors (Gmail/Drive/etc.) at startup —
   * those connect with a 30s timeout each *before* any output, so a slow/unreachable connector stalls
   * the whole call (the root cause of the intermittent "no response" hangs). The plugin needs no MCP.
   */
  noMcp?: boolean;
}

export interface ClaudeResult {
  sessionId?: string;
  isError: boolean;
  result?: string;
  costUsd?: number;
  /** Result envelope subtype, e.g. "success" | "error_during_execution" | "error_max_turns". */
  subtype?: string;
  /** The full result envelope — for logging/diagnosing an error result. */
  raw?: unknown;
}

export interface ClaudeHandlers {
  /** Called for each streamed text chunk (token-ish granularity). */
  onText?: (text: string) => void;
  /**
   * Called at the start of each assistant content block (a `content_block_start` stream event).
   * `kind` is the Anthropic block type — "thinking", "tool_use", "text", etc. For "tool_use",
   * `name` is the tool (e.g. "Read"). Lets the UI show mid-stream "Thinking…/Running…" indicators
   * and separate consecutive text blocks (verified shapes — see scripts/spike + PLAN §7).
   */
  onBlock?: (kind: string, name?: string) => void;
  /** Raw event tap — useful for surfacing tool-use status or debugging. */
  onEvent?: (type: string | undefined, raw: unknown) => void;
  /** Final result envelope. */
  onDone?: (result: ClaudeResult) => void;
  onError?: (err: Error) => void;
}

/** Build the argv for a claude invocation (exported for testing/inspection). */
export function buildArgs(opts: RunClaudeOptions): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.settingSources) args.push("--setting-sources", opts.settingSources);
  if (opts.noMcp) args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
  // spawn() throws synchronously if ANY arg has a NUL byte — and PDF-extracted passages (in the
  // prompt / system prompt) sometimes do. Strip control chars from every arg defensively.
  return args.map(stripControlChars);
}

export function runClaude(opts: RunClaudeOptions, handlers: ClaudeHandlers): ChildProcess {
  const child = spawn(opts.binPath, buildArgs(opts), {
    cwd: opts.cwd,
    // stdio[0]="ignore" avoids the CLI's 3s wait for piped stdin.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let buf = "";
  let stderr = "";
  // Guarantee exactly one terminal callback. Without this, a process that exits 0 (or is killed)
  // *without* emitting a `result` line fires neither onDone nor onError, leaving the UI stuck on
  // "Thinking…" forever. `settled` flips on the first terminal event (result or error).
  let settled = false;
  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    handlers.onError?.(err);
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line && dispatch(line, handlers)) settled = true;
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => {
    stderr += c;
  });

  child.on("error", (e) => fail(e));

  child.on("close", (code) => {
    if (buf.trim() && dispatch(buf.trim(), handlers)) settled = true; // flush trailing line
    if (settled) return; // onDone already delivered
    const tail = stderr ? `: ${stderr.slice(0, 500)}` : "";
    if (code !== 0 && code !== null) fail(new Error(`claude exited with code ${code}${tail}`));
    else fail(new Error(`claude exited without a result (code ${code ?? "killed"})${tail}`));
  });

  return child;
}

/** Returns true iff this line was the terminal `result` event (so the caller can mark it settled). */
function dispatch(line: string, handlers: ClaudeHandlers): boolean {
  let evt: any;
  try {
    evt = JSON.parse(line);
  } catch {
    return false; // ignore non-JSON noise
  }
  handlers.onEvent?.(evt?.type, evt);

  if (evt?.type === "stream_event") {
    const ev = evt.event;
    if (ev?.type === "content_block_start") {
      const cb = ev.content_block ?? {};
      handlers.onBlock?.(cb.type as string, cb.name as string | undefined);
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      handlers.onText?.(ev.delta.text as string);
    }
    return false;
  } else if (evt?.type === "result") {
    handlers.onDone?.({
      sessionId: evt.session_id,
      isError: !!evt.is_error,
      result: evt.result,
      costUsd: evt.total_cost_usd,
      subtype: evt.subtype,
      raw: evt,
    });
    return true;
  }
  return false;
}
