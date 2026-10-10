import { Turn } from "./types";
import { toObsidianMath } from "./format";
import type AugmentedPdfPlugin from "./main";

/**
 * Generate a 2-3 sentence summary of a chat — deferred/async (the chosen design).
 *
 * Routes through the active AI provider (Claude CLI or GWDG) as a FRESH, isolated call that takes the
 * conversation text as its prompt; it does NOT resume the chat's session, so it never pollutes the
 * live thread. On the CLI it uses haiku (summaries don't need a frontier model); on GWDG it uses the
 * configured model.
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
    const prompt =
      // Synthesize the WHOLE conversation, not just the last exchange. The summary is regenerated
      // and overwritten on every turn, so it must reflect the full arc up to this point —
      // otherwise a late topic drift erases the substantive core (the failure we're fixing).
      // Voice: first-person plural ("we"), anchored by a positive one-shot example (a neutral
      // domain, so it teaches the voice/shape without biasing the content of real summaries).
      "Below is a Q&A conversation about a highlighted passage from a document. Write a synthesis " +
      "of the ENTIRE conversation so far: the core question(s) explored and the key insights and " +
      "partial or tentative conclusions reached across ALL exchanges. Weight by intellectual " +
      "substance — do not over-emphasize the final message, and ignore procedural or tool-use " +
      "chatter.\n\n" +
      "Write in the first person plural (\"we\"), in a natural, reflective voice — as if recounting " +
      "what we worked out together. Output ONLY the summary as 2-4 sentences of plain prose: no " +
      "preamble, no headings, no bullet points.\n\n" +
      "Here is an example of the voice and shape to aim for (a different topic — match the style, " +
      "not the content):\n" +
      "\"We worked through why the author treats the boundary as fixed, and whether that assumption " +
      "survives once feedback is added. We landed on a tentative view that it holds in the short " +
      "run but breaks over longer horizons, leaving open how best to model the transition.\"\n\n" +
      "Now summarize this conversation in that voice:\n\n" +
      convo;

    const provider = plugin.getProvider();
    provider.run(
      {
        prompt,
        messages: [{ role: "user", content: prompt }],
        // CLI: haiku is plenty for summaries. GWDG: undefined → its configured model.
        model: provider.id === "claude" ? "haiku" : undefined,
        // Codex: same model as chat but low reasoning effort — a summary doesn't need a long think.
        effort: provider.id === "codex" ? "low" : undefined,
        permissionMode: "dontAsk", // CLI-only; ignored by GWDG
      },
      {
        onText: (t) => {
          acc += t;
        },
        onDone: (r) => resolve(r.isError ? null : toObsidianMath((r.result ?? acc).trim()) || null),
        onError: () => resolve(null),
      }
    );
  });
}
