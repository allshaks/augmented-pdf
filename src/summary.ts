import { runClaude } from "./claude/runner";
import { Turn } from "./types";
import type AugmentedPdfPlugin from "./main";

/**
 * Generate a 2-3 sentence summary of a chat — deferred/async (the chosen design).
 *
 * Crucially this is a FRESH, isolated `claude -p` call that takes the conversation text as its
 * prompt; it does NOT resume the chat's session, so it never pollutes the live thread. Always
 * uses haiku (summaries don't need a frontier model; keeps it fast + cheap).
 */
export function generateSummary(plugin: AugmentedPdfPlugin, turns: Turn[]): Promise<string | null> {
  const convo = turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n\n");
  return summarizeConversation(plugin, convo);
}

/** Summarize raw conversation text (used by the chat view and the reconcile pass). */
export function summarizeConversation(plugin: AugmentedPdfPlugin, convo: string): Promise<string | null> {
  return new Promise((resolve) => {
    let acc = "";
    runClaude(
      {
        binPath: plugin.settings.claudeBinPath,
        prompt:
          "Summarize the key conclusions of the following conversation in 2-3 sentences. " +
          "Output ONLY the summary as plain prose — no preamble, no markdown headings.\n\n" +
          convo,
        model: "haiku",
        permissionMode: "dontAsk",
        cwd: plugin.vaultCwd(),
      },
      {
        onText: (t) => {
          acc += t;
        },
        onDone: (r) => resolve(r.isError ? null : (r.result ?? acc).trim() || null),
        onError: () => resolve(null),
      }
    );
  });
}
