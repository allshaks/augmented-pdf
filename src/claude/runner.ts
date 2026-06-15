import { spawn, ChildProcess } from "child_process";

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
  /** e.g. "Read,Grep,Glob" — read-only by default in our design. */
  allowedTools?: string;
  /** e.g. "dontAsk" — non-interactive. */
  permissionMode?: string;
}

export interface ClaudeResult {
  sessionId?: string;
  isError: boolean;
  result?: string;
  costUsd?: number;
}

export interface ClaudeHandlers {
  /** Called for each streamed text chunk (token-ish granularity). */
  onText?: (text: string) => void;
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
  if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  return args;
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

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) dispatch(line, handlers);
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => {
    stderr += c;
  });

  child.on("error", (e) => handlers.onError?.(e));

  child.on("close", (code) => {
    if (buf.trim()) dispatch(buf.trim(), handlers); // flush trailing line
    if (code !== 0 && code !== null) {
      handlers.onError?.(
        new Error(`claude exited with code ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`)
      );
    }
  });

  return child;
}

function dispatch(line: string, handlers: ClaudeHandlers): void {
  let evt: any;
  try {
    evt = JSON.parse(line);
  } catch {
    return; // ignore non-JSON noise
  }
  handlers.onEvent?.(evt?.type, evt);

  if (
    evt?.type === "stream_event" &&
    evt.event?.type === "content_block_delta" &&
    evt.event.delta?.type === "text_delta"
  ) {
    handlers.onText?.(evt.event.delta.text as string);
  } else if (evt?.type === "result") {
    handlers.onDone?.({
      sessionId: evt.session_id,
      isError: !!evt.is_error,
      result: evt.result,
      costUsd: evt.total_cost_usd,
    });
  }
}
