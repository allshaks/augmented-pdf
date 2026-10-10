import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { AiHandlers, AiProvider, AiRunHandle, AiRunOptions } from "./provider";
import { stripControlChars } from "../format";
import type AugmentedPdfPlugin from "../main";

/**
 * Codex CLI backend (OpenAI) — the OpenAI counterpart of the Claude CLI, authenticated with the
 * user's ChatGPT account rather than an API key.
 *
 * Verified against codex-cli 0.162 (`codex exec --json`), which differs from the Claude CLI in ways
 * that shape this file:
 *   - Events are JSONL: thread.started{thread_id} → turn.started → item.started/completed
 *     (command_execution, agent_message, …) → turn.completed{usage} | turn.failed{error}.
 *   - The reply arrives WHOLE in one item.completed(agent_message) — there are no token deltas, so
 *     a Codex chat shows its answer all at once after the thinking indicator.
 *   - Codex MINTS the session id (thread.started); resuming is `exec … resume <id> -`. The plugin
 *     keeps its own thread identity and stores Codex's id beside it (see view.ts providerThreadId).
 *   - No --append-system-prompt: the system prompt goes in as `-c developer_instructions="…"`.
 *   - Read-only is `--sandbox read-only`, which still lets it read files (it shells out to cat /
 *     pdftotext), so note and whole-PDF chats work; writes are blocked.
 */

/** Codex ships inside the ChatGPT desktop app and isn't on PATH there. */
const BUNDLED_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

export function defaultCodexBin(): string {
  return existsSync(BUNDLED_BIN) ? BUNDLED_BIN : "codex";
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export interface CodexModelInfo {
  slug: string;
  name: string;
  levels: string[];
}

/**
 * Models offered to this account, from Codex's own cache (~/.codex/models_cache.json — a model list,
 * not credentials). Only `visibility: "list"` entries, i.e. the ones Codex itself shows in its picker.
 */
export function readCodexModels(): CodexModelInfo[] {
  try {
    const d = JSON.parse(readFileSync(path.join(codexHome(), "models_cache.json"), "utf8"));
    const list: unknown[] = Array.isArray(d?.models) ? d.models : [];
    return list
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .filter((m) => m.visibility === "list" && typeof m.slug === "string")
      .map((m) => ({
        slug: m.slug as string,
        name: typeof m.display_name === "string" ? m.display_name : (m.slug as string),
        levels: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
          .map((l: unknown) => (typeof l === "string" ? l : (l as { effort?: unknown })?.effort))
          .filter((l: unknown): l is string => typeof l === "string"),
      }));
  } catch {
    return [];
  }
}

/** The default model from ~/.codex/config.toml (top-level `model = "…"`), if set. */
export function readCodexConfigModel(): string | undefined {
  try {
    const toml = readFileSync(path.join(codexHome(), "config.toml"), "utf8");
    const top = toml.split(/^\s*\[/m)[0]; // keys before the first [section]
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  } catch {
    return undefined;
  }
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

/**
 * Map the plugin's effort level onto what the model supports, clamping DOWN when it lacks the level
 * (asking for an unsupported level would error). Unknown model → pass the level through.
 */
export function codexEffort(level: string | undefined, supported: string[]): string | undefined {
  if (!level || level === "default") return undefined;
  if (!supported.length || supported.includes(level)) return level;
  const want = EFFORT_ORDER.indexOf(level);
  for (let i = want; i >= 0; i--) if (supported.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  return undefined;
}

/** argv for one turn. The prompt itself goes on stdin ("-"), immune to leading dashes and arg limits. */
export function buildCodexArgs(o: {
  cwd: string;
  model?: string;
  effort?: string;
  systemPrompt?: string;
  resumeId?: string;
  ephemeral?: boolean;
}): string[] {
  const a = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", o.cwd];
  if (o.ephemeral) a.push("--ephemeral"); // one-shot (summaries): don't add to the user's Codex history
  if (o.model) a.push("-m", o.model);
  if (o.effort) a.push("-c", `model_reasoning_effort=${JSON.stringify(o.effort)}`);
  // JSON string syntax is a valid TOML basic string, so quotes/newlines/backslashes survive intact.
  if (o.systemPrompt) a.push("-c", `developer_instructions=${JSON.stringify(o.systemPrompt)}`);
  if (o.resumeId) a.push("resume", o.resumeId, "-");
  else a.push("-");
  return a.map(stripControlChars);
}

/**
 * Codex appends citation directives to its replies, e.g.
 *   :codex-file-citation{path="/abs/vault/papers/x.pdf" purpose="source"}
 * which Obsidian would show as raw markup — with an absolute filesystem path baked into the saved
 * transcript. Rewrite each as a vault wikilink when the file is inside the vault; otherwise keep just
 * the file name. Exported for testing.
 */
export function cleanCodexText(text: string, vaultRoot: string): string {
  const root = vaultRoot.replace(/\/+$/, "") + "/";
  return text.replace(/\s*:codex-file-citation\{([^}]*)\}/g, (_m, attrs: string) => {
    const file = /path="([^"]+)"/.exec(attrs)?.[1];
    if (!file) return "";
    if (file.startsWith(root)) {
      const rel = file.slice(root.length).replace(/\.md$/i, "");
      return ` *(source: [[${rel}]])*`;
    }
    return ` *(source: ${file.split("/").pop()})*`;
  });
}

/** Friendlier activity label for a shell command Codex runs (it reads files by shelling out). */
function commandTool(command: unknown): string {
  const c = typeof command === "string" ? command : "";
  if (/\b(rg|grep|find|fd)\b/.test(c)) return "Grep";
  if (/\b(cat|sed|head|tail|less|nl|wc|awk|pdftotext|pdfinfo)\b/.test(c)) return "Read";
  return "Bash";
}

/**
 * Translate Codex JSONL into the plugin's provider handlers (the same contract the Claude runner
 * emits), so the chat view needs no Codex-specific rendering. Pure apart from the handler calls.
 */
export function createCodexDispatcher(h: AiHandlers, vaultRoot = ""): {
  line: (l: string) => boolean; // true once a terminal event (turn.completed/failed) was delivered
  state: { threadId: string | null; texts: string[]; error: string | null };
} {
  const state = { threadId: null as string | null, texts: [] as string[], error: null as string | null };
  const line = (l: string): boolean => {
    let e: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      e = JSON.parse(l);
    } catch {
      return false;
    }
    h.onEvent?.(e?.type, e);
    const it = e?.item ?? {};
    switch (e?.type) {
      case "thread.started":
        if (typeof e.thread_id === "string") state.threadId = e.thread_id;
        return false;
      case "turn.started":
        h.onBlock?.("thinking"); // Codex streams no reasoning — keep a live "Thinking… Ns" up
        return false;
      case "item.started":
        if (it.type === "command_execution") h.onBlock?.("tool_use", commandTool(it.command));
        else if (it.type === "web_search") h.onBlock?.("tool_use", "WebSearch");
        else if (it.type === "file_change") h.onBlock?.("tool_use", "Edit");
        else if (it.type === "mcp_tool_call") h.onBlock?.("tool_use", String(it.tool ?? "tool"));
        else if (it.type === "reasoning") h.onBlock?.("thinking");
        return false;
      case "item.completed":
        if (it.type === "agent_message" && typeof it.text === "string") {
          const text = vaultRoot ? cleanCodexText(it.text, vaultRoot) : it.text;
          h.onBlock?.("text");
          h.onText?.(text);
          state.texts.push(text);
        } else if (it.type === "error") {
          state.error = String(it.message ?? "Codex reported an error");
        } else if (["command_execution", "web_search", "file_change", "mcp_tool_call"].includes(it.type)) {
          h.onBlock?.("thinking"); // tool done; it's thinking again until its next item
        }
        return false;
      case "error":
        state.error = String(e.message ?? e.error?.message ?? "Codex error");
        return false;
      case "turn.completed":
        h.onDone?.({
          isError: false,
          result: state.texts.join("\n\n"),
          sessionId: state.threadId ?? undefined,
          subtype: "success",
          raw: e,
        });
        return true;
      case "turn.failed":
        h.onDone?.({
          isError: true,
          result: String(e.error?.message ?? state.error ?? "Codex turn failed"),
          sessionId: state.threadId ?? undefined,
          subtype: "turn_failed",
          raw: e,
        });
        return true;
    }
    return false;
  };
  return { line, state };
}

export class CodexCliProvider implements AiProvider {
  readonly id = "codex" as const;
  readonly label = "Codex CLI";
  // Read-only sandbox: can read notes/PDFs, nothing else. Skills (writes/shell) and web are
  // Claude-only for now; ChatGPT-plan usage has no USD cost to show.
  readonly capabilities = { skills: false, web: false, usd: false, readsFiles: true };

  constructor(private plugin: AugmentedPdfPlugin) {}

  /** The concrete model a turn will use: the plugin setting, else Codex's own configured default. */
  model(): string | undefined {
    return this.plugin.settings.codexModel || readCodexConfigModel();
  }

  run(opts: AiRunOptions, handlers: AiHandlers): AiRunHandle {
    // The chat panel passes the Codex model picked for this chat ("" = Codex's configured default);
    // summaries pass none and get the default-model setting.
    const model = (opts.model ?? this.plugin.settings.codexModel) || undefined;
    const levels = readCodexModels().find((m) => m.slug === (model ?? readCodexConfigModel()))?.levels ?? [];
    const args = buildCodexArgs({
      cwd: this.plugin.vaultCwd(),
      model,
      effort: codexEffort(opts.effort, levels),
      systemPrompt: opts.systemPrompt,
      resumeId: opts.resumeId,
      ephemeral: !opts.sessionId && !opts.resumeId,
    });
    const child = spawn(this.plugin.settings.codexBinPath || defaultCodexBin(), args, {
      cwd: this.plugin.vaultCwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let settled = false;
    let stderr = "";
    let buf = "";
    const d = createCodexDispatcher(
      {
        ...handlers,
        onDone: (r) => {
          settled = true;
          handlers.onDone?.(r);
        },
      },
      this.plugin.vaultCwd()
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (l) d.line(l);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      handlers.onError?.(e);
    });
    child.on("close", (code) => {
      if (buf.trim()) d.line(buf.trim());
      if (settled) return;
      settled = true;
      // No terminal event: report Codex's own error if it sent one, else the exit + stderr tail.
      const tail = stderr.replace(/^Reading additional input from stdin\.\.\.\s*/m, "").trim().slice(0, 500);
      if (d.state.error) {
        handlers.onDone?.({ isError: true, result: d.state.error, sessionId: d.state.threadId ?? undefined, subtype: "error" });
      } else {
        handlers.onError?.(new Error(`codex exited without a result (code ${code ?? "killed"})${tail ? ": " + tail : ""}`));
      }
    });
    child.stdin?.end(opts.prompt); // the prompt, via stdin ("-")
    return child;
  }
}
