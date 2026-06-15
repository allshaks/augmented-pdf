#!/usr/bin/env node
/*
 * Spike S2 (standalone): drive the `claude` CLI in streaming mode and prove the parser.
 * This is the same logic the plugin's ClaudeRunner uses, runnable from a terminal so we
 * can verify streaming, session resume, cost, and auth WITHOUT Obsidian.
 *
 * Usage:
 *   node scripts/spike-claude.mjs "your prompt"
 *   node scripts/spike-claude.mjs "follow up" --resume <session-id>
 *   node scripts/spike-claude.mjs "first turn" --session-id <uuid>
 *   CLAUDE_BIN=/Users/you/.local/bin/claude node scripts/spike-claude.mjs "hi" --model haiku
 *
 * Findings this harness confirms (Phase 0):
 *   - stream text  = stream_event -> event.delta.type==="text_delta" -> event.delta.text
 *   - final line   = type==="result" with session_id / total_cost_usd / is_error / result
 *   - parser must dispatch on event CONTENT, not line position (hook + rate_limit events appear)
 *   - spawn with stdio[0]="ignore" to avoid the 3s stdin wait
 */
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const prompt = positional[0] ?? "In one sentence, what is the attention mechanism in transformers?";
const model = flag("--model", "haiku");
const resumeId = flag("--resume");
const sessionId = flag("--session-id");
const bin = process.env.CLAUDE_BIN || "claude";

const cargs = [
  "-p", prompt,
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model", model,
];
if (sessionId) cargs.push("--session-id", sessionId);
if (resumeId) cargs.push("--resume", resumeId);

const shown = cargs.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");
process.stderr.write(`\n[spike] ${bin} ${shown}\n[spike] --- streaming ---\n`);

const child = spawn(bin, cargs, { stdio: ["ignore", "pipe", "pipe"] });

let buf = "";
let stderr = "";
let text = "";
const seenTypes = new Set();
let resultLine = null;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => (stderr += c));
child.on("error", (e) => {
  process.stderr.write(`\n[spike] SPAWN ERROR: ${e.message}\n`);
  process.stderr.write(`[spike] (is the binary on PATH? try CLAUDE_BIN=/abs/path/to/claude)\n`);
  process.exit(1);
});
child.on("close", (code) => {
  if (buf.trim()) handle(buf.trim());
  process.stderr.write(`\n\n[spike] --- summary ---\n`);
  process.stderr.write(`[spike] event types seen : ${[...seenTypes].join(", ")}\n`);
  process.stderr.write(`[spike] streamed chars   : ${text.length}\n`);
  if (resultLine) {
    process.stderr.write(`[spike] is_error         : ${resultLine.is_error}\n`);
    process.stderr.write(`[spike] session_id       : ${resultLine.session_id}\n`);
    process.stderr.write(`[spike] total_cost_usd   : ${resultLine.total_cost_usd}\n`);
  }
  if (stderr.trim()) process.stderr.write(`[spike] stderr           : ${stderr.trim().slice(0, 300)}\n`);
  process.stderr.write(`[spike] exit code        : ${code}\n`);
  process.exit(code ?? 0);
});

function handle(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return; // ignore non-JSON noise
  }
  if (e && e.type) seenTypes.add(e.type);
  if (
    e.type === "stream_event" &&
    e.event?.type === "content_block_delta" &&
    e.event.delta?.type === "text_delta"
  ) {
    const t = e.event.delta.text;
    text += t;
    process.stdout.write(t); // live streaming to stdout
  } else if (e.type === "result") {
    resultLine = e;
  }
}
