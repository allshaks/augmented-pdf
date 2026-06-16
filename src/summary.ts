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
          // Synthesize the WHOLE conversation, not just the last exchange. The summary is regenerated
          // and overwritten on every turn, so it must reflect the full arc up to this point —
          // otherwise a late topic drift erases the substantive core (the failure we're fixing).
          "Below is a Q&A conversation between a user and an assistant about a highlighted passage " +
          "from a document. Write a synthesis of the ENTIRE conversation so far: the core question(s) " +
          "the user is working through and the key insights, answers, and partial or tentative " +
          "conclusions reached across ALL exchanges. Weight by intellectual substance — do NOT " +
          "over-emphasize the final message, and ignore procedural or tool-use chatter (e.g. asking " +
          "which skills are available, running commands). Output ONLY the summary as 2-4 sentences of " +
          "plain prose — no preamble, no markdown headings, no bullet points.\n\n" +
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
