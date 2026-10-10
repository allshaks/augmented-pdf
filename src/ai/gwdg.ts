import * as https from "https";
import { AiMessage, AiProvider, AiHandlers, AiRunHandle, AiRunOptions } from "./provider";
import type AugmentedPdfPlugin from "../main";

const DEFAULT_BASE = "https://chat-ai.academiccloud.de/v1";
const DEFAULT_MODEL = "meta-llama-3.1-8b-instruct";

/*
 * GWDG Chat AI backend (OpenAI-compatible HTTP over Node `https` — streams SSE, no CORS).
 *
 * The API's richer options are under-documented, so reasoning, web search and Docling below follow
 * what GWDG's own open-source Chat AI does (github.com/gwdg/chat-ai, front/src/apis/
 * chatCompletions.jsx and back/service.mjs at commit ac6896a, 2026-10-08) — that is what the API
 * actually receives from their UI.
 */

/** One entry of GWDG's /models list, classified for the settings picker. */
export interface GwdgModelInfo {
  id: string;
  /**
   * Proxied to an external vendor (OpenAI/Anthropic) rather than run at GWDG — so a chat with it
   * leaves GWDG, and per GWDG's docs external models "are not generally available for API usage".
   */
  external: boolean;
  /** Embedding models are listed by /models too, but can't serve chat completions. */
  kind: "chat" | "embedding";
}

/**
 * Classify a raw /models entry. External = Anthropic or OpenAI — EXCEPT `openai-gpt-oss-*`, which is
 * an open-weight model GWDG hosts itself (their backend makes exactly this exception). Reads
 * `owned_by` when present but matches on the id too, since a proxy may label everything its own.
 * ("gemma" is Google's open model, hosted at GWDG — not "gemini".)
 */
export function classifyGwdgModel(raw: { id?: unknown; owned_by?: unknown }): GwdgModelInfo | null {
  if (typeof raw?.id !== "string" || !raw.id) return null;
  const id = raw.id;
  const lid = id.toLowerCase();
  const hay = `${lid} ${typeof raw.owned_by === "string" ? raw.owned_by.toLowerCase() : ""}`;
  const external =
    !/gpt-oss/.test(lid) &&
    (/\b(openai|anthropic|claude|gpt|chatgpt|gemini)\b|(^|[^a-z])o[1-9](-|$|[^a-z])|gpt-?\d/.test(hay));
  const kind = /(^|[-_/ ])e5([-_ ]|$)|embed/.test(lid) ? "embedding" : "chat";
  return { id, external, kind };
}

/**
 * Per-model reasoning settings — GWDG's own table (front/src/config/models/*.json @ ac6896a):
 * the options the model offers, in order. New models GWDG adds later won't be here; for those the
 * reasoning control is simply hidden and the model's default applies.
 */
const GWDG_REASONING: Record<string, string[]> = {
  "deepseek-v4-flash-0731": ["none", "low", "medium", "high"],
  "gemma-4-31b-it": ["none", "on"],
  "glm-4.7": ["none", "on"],
  "glm-5.3-flash": ["low", "high", "max"],
  "mistral-medium-3.5-128b": ["none", "high"],
  "openai-gpt-oss-120b": ["low", "medium", "high"],
  "qwen3.5-122b-a10b": ["none", "on"],
  "qwen3.5-397b-a17b": ["none", "on"],
  "qwen3.6-35b-a3b": ["none", "on"],
  "qwen3.8-27b": ["none", "low", "medium", "xhigh"],
  // external (proxied) models
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-6": ["low", "medium", "high", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
  "openai-gpt6-astra": ["none", "low", "medium", "high"],
  "openai-gpt6-luna": ["none", "low", "medium", "high"],
  "openai-gpt6-sol": ["none", "low", "medium", "high"],
  "openai-gpt5.6-luna": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.6-sol": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.6-terra": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.5": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.4": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.4-mini": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.4-nano": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.2": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5.1": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5-mini": ["none", "low", "medium", "high", "xhigh"],
  "openai-gpt5-nano": ["none", "low", "medium", "high", "xhigh"],
  "openai-o3": ["low", "medium", "high"],
  "openai-o3-mini": ["low", "medium", "high"],
  "openai-o4-mini": ["low", "medium", "high"],
};

/** The reasoning options a GWDG model offers, or null if it has no reasoning control (or is unknown). */
export function gwdgReasoningOptions(model: string): string[] | null {
  return GWDG_REASONING[model] ?? null;
}

/**
 * Request fields for a reasoning choice, mirroring GWDG's Chat AI: external and Mistral models take
 * `reasoning_effort`; hosted models take it through the chat template — `enable_thinking` on/off,
 * plus a level when the model has levels. "default" (or an unknown choice) sends nothing, leaving
 * the model's own default.
 */
export function gwdgReasoningParams(model: string, choice: string | undefined): Record<string, unknown> {
  const opts = gwdgReasoningOptions(model);
  if (!opts || !choice || choice === "default") return {};
  const idx = opts.indexOf(choice);
  if (idx < 0) return {};
  const m = model.toLowerCase();
  const external = m.startsWith("claude") || (m.startsWith("openai") && !m.startsWith("openai-gpt-oss"));
  if (external || m.includes("mistral")) return { reasoning_effort: choice };
  if (idx === 0) {
    return { chat_template_kwargs: choice === "none" ? { enable_thinking: false } : { reasoning_effort: choice } };
  }
  if (choice === "on") return { chat_template_kwargs: { enable_thinking: true } };
  return { chat_template_kwargs: { enable_thinking: true, reasoning_effort: choice } };
}

/**
 * Headers + body for one chat call. Web search mirrors GWDG's backend: route through the tool
 * gateway (`inference-service: saia-openai-gateway`), run tools server-side, and offer the web-search
 * and URL-fetch tools. Never for external models (GWDG doesn't run tools for them). Like Chat AI, a
 * web-enabled call also carries today's date so "latest/current" searches are anchored.
 */
export function buildGwdgRequest(o: {
  model: string;
  messages: AiMessage[];
  effort?: string;
  web?: boolean;
  now?: Date;
}): { headers: Record<string, string>; body: Record<string, unknown>; web: boolean } {
  const info = classifyGwdgModel({ id: o.model });
  const web = !!o.web && !info?.external;
  let messages = o.messages;
  if (web) {
    const stamp = `Current date: ${(o.now ?? new Date()).toLocaleString()}`;
    messages =
      messages[0]?.role === "system"
        ? [{ ...messages[0], content: `${stamp}\n\n${messages[0].content}` }, ...messages.slice(1)]
        : [{ role: "system", content: stamp }, ...messages];
  }
  const body: Record<string, unknown> = { model: o.model, messages, stream: true, ...gwdgReasoningParams(o.model, o.effort) };
  const headers: Record<string, string> = {};
  if (web) {
    headers["inference-service"] = "saia-openai-gateway";
    body.runToolsOnServer = true;
    body.tools = [{ type: "web_search_preview" }, { type: "fetch_url" }];
  }
  return { headers, body, web };
}

/**
 * Hides <think>…</think> spans from streamed content — some hosted reasoning models emit their
 * thinking inline instead of in `reasoning_content`, which would otherwise land in the reply (and
 * the saved transcript) verbatim. Handles tags split across stream chunks.
 */
export class ThinkTagFilter {
  private inThink = false;
  private pending = "";

  push(chunk: string): { text: string; thinking: boolean } {
    let s = this.pending + chunk;
    this.pending = "";
    let text = "";
    let thinking = false;
    while (s.length) {
      if (this.inThink) {
        const end = s.indexOf("</think>");
        thinking = true;
        if (end < 0) {
          this.pending = partialSuffix(s, "</think>");
          break;
        }
        s = s.slice(end + "</think>".length);
        this.inThink = false;
      } else {
        const start = s.indexOf("<think>");
        if (start < 0) {
          const keep = partialSuffix(s, "<think>");
          text += s.slice(0, s.length - keep.length);
          this.pending = keep;
          break;
        }
        text += s.slice(0, start);
        s = s.slice(start + "<think>".length);
        this.inThink = true;
        thinking = true;
      }
    }
    return { text, thinking };
  }

  /** Whatever was held back as a possible tag start, once the stream ends. */
  flush(): string {
    const p = this.inThink ? "" : this.pending;
    this.pending = "";
    return p;
  }
}

function partialSuffix(s: string, tag: string): string {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) return s.slice(-k);
  return "";
}

/** Markdown out of a Docling response — docling-serve's shape or the documented `markdown` field. */
export function parseDoclingResponse(o: unknown): string | null {
  const r = o as { markdown?: unknown; md_content?: unknown; document?: { md_content?: unknown }; documents?: { md_content?: unknown }[] };
  const md = r?.markdown ?? r?.document?.md_content ?? r?.md_content ?? r?.documents?.[0]?.md_content;
  if (typeof md !== "string" || !md.trim()) return null;
  return md.replace(/<!--\s*image\s*-->/g, "[figure]").trim();
}

/** multipart/form-data body (plain fields + one file), for Docling uploads. */
export function buildMultipart(
  fields: Record<string, string>,
  fileField: string,
  filename: string,
  data: Uint8Array
): { body: Buffer; contentType: string } {
  const boundary = `----apc${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const safeName = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${safeName}"\r\nContent-Type: application/pdf\r\n\r\n`
    )
  );
  parts.push(Buffer.from(data));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** A Docling route that doesn't exist / doesn't accept this request shape — try the next one. */
class DoclingRouteError extends Error {}

export class GwdgHttpProvider implements AiProvider {
  readonly id = "gwdg" as const;
  readonly label = "GWDG Chat AI";
  // Web search is server-side (GWDG's tool gateway) and only for GWDG-hosted models — buildGwdgRequest
  // drops it for external ones, and the chat panel disables the toggle for them.
  readonly capabilities = { skills: false, web: true, usd: false, readsFiles: false };

  constructor(private plugin: AugmentedPdfPlugin) {}

  private base(): string {
    return (this.plugin.settings.gwdgBaseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  }
  private key(): string {
    return (this.plugin.settings.gwdgApiKey || "").trim();
  }

  run(opts: AiRunOptions, handlers: AiHandlers): AiRunHandle {
    const messages: AiMessage[] =
      opts.messages && opts.messages.length
        ? opts.messages
        : [
            ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt } as AiMessage] : []),
            { role: "user", content: opts.prompt },
          ];

    const key = this.key();
    if (!key) {
      // Defer so the handle is returned before the callback fires.
      window.setTimeout(
        () => handlers.onError?.(new Error("No GWDG API key set (Settings → Augmented PDF → AI provider).")),
        0
      );
      return { kill: () => {}, pid: -1 };
    }

    let url: URL;
    try {
      url = new URL(this.base() + "/chat/completions");
    } catch {
      window.setTimeout(() => handlers.onError?.(new Error("Invalid GWDG base URL: " + this.base())), 0);
      return { kill: () => {}, pid: -1 };
    }

    // The chat panel passes the GWDG model picked for this chat; summaries pass none → the default.
    const model = opts.model || this.plugin.settings.gwdgModel || DEFAULT_MODEL;
    const reqSpec = buildGwdgRequest({ model, messages, effort: opts.effort, web: opts.web });
    const body = JSON.stringify(reqSpec.body);

    let aborted = false;
    let req!: ReturnType<typeof https.request>;
    // Connection-establishment failures — typical of a flaky network. Safe to retry exactly once:
    // they happen before any response, so nothing was streamed to the user yet.
    const RETRYABLE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;

    // Until the first token: an honest "waiting" indicator (prefill of a long PDF, or server-side web
    // search, can take a while). Real reasoning switches it to "Thinking…".
    handlers.onBlock?.("tool_use", reqSpec.web ? "WaitingWeb" : "Waiting");

    const attempt = (n: number): void => {
      let gotResponse = false;
      req = https.request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            Authorization: `Bearer ${key}`,
            ...reqSpec.headers,
          },
        },
        (res) => {
          gotResponse = true;
          const status = res.statusCode ?? 0;
          res.setEncoding("utf8");
          if (status >= 400) {
            let errBody = "";
            res.on("data", (c: string) => (errBody += c));
            res.on("end", () => {
              const info = classifyGwdgModel({ id: model });
              // GWDG lists external models in /models but notes they're "not generally available
              // for API usage" — so a refusal here usually means "pick a GWDG-hosted model", not "retry".
              const hint =
                info?.external && (status === 401 || status === 403 || status === 404)
                  ? ` — "${model}" is an external (OpenAI/Anthropic) model, which GWDG often doesn't enable for API keys; pick a GWDG-hosted model in settings.`
                  : info?.kind === "embedding"
                    ? ` — "${model}" is an embedding model and can't chat; pick a chat model in settings.`
                    : "";
              if (!aborted) handlers.onError?.(new Error(`GWDG API ${status}: ${(errBody || res.statusMessage || "").slice(0, 300)}${hint}`));
            });
            return;
          }
          let buf = "";
          let acc = "";
          let phase: "wait" | "think" | "text" = "wait";
          const filter = new ThinkTagFilter();
          const emitText = (t: string) => {
            if (!t) return;
            if (phase !== "text") {
              handlers.onBlock?.("text");
              phase = "text";
            }
            acc += t;
            handlers.onText?.(t);
          };
          const startThinking = () => {
            if (phase === "wait") {
              handlers.onBlock?.("thinking");
              phase = "think";
            }
          };
          res.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith("data:")) continue; // skip SSE comments/blank lines
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const o = JSON.parse(data);
                const d = o?.choices?.[0]?.delta ?? {};
                const reasoning = d.reasoning_content ?? d.reasoning;
                if (typeof reasoning === "string" && reasoning) startThinking();
                if (typeof d.content === "string" && d.content) {
                  const f = filter.push(d.content);
                  if (f.thinking) startThinking();
                  emitText(f.text);
                }
              } catch {
                /* ignore keep-alives / partial frames */
              }
            }
          });
          res.on("end", () => {
            emitText(filter.flush());
            if (!aborted) handlers.onDone?.({ isError: false, result: acc, costUsd: 0 });
          });
          res.on("error", (e) => {
            if (!aborted) handlers.onError?.(e);
          });
        }
      );
      req.on("error", (e: NodeJS.ErrnoException) => {
        if (aborted) return;
        if (n === 0 && !gotResponse && RETRYABLE.test(`${e.code ?? ""} ${e.message}`)) {
          window.setTimeout(() => {
            if (!aborted) attempt(1);
          }, 1500);
          return;
        }
        handlers.onError?.(e);
      });
      req.write(body);
      req.end();
    };
    attempt(0);

    return {
      pid: -1, // sentinel so the chat's "no process" guard treats this as live
      kill: () => {
        aborted = true;
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      },
    };
  }

  /**
   * Convert a PDF to Markdown with GWDG's Docling service (keeps tables and structure). Tries the
   * route GWDG's own Chat AI uses (docling-serve's /convert/file with images off, so the reply stays
   * small), then the documented /documents/convert. The PDF goes to GWDG — the provider already chosen.
   */
  async convertPdf(data: Uint8Array, filename: string): Promise<string> {
    try {
      return await this.doclingPost("/documents/convert/file", "files", data, filename, {
        to_formats: "md",
        extract_tables_as_images: "false",
        image_export_mode: "placeholder",
        include_images: "false",
      });
    } catch (e) {
      if (!(e instanceof DoclingRouteError)) throw e;
    }
    return this.doclingPost("/documents/convert", "document", data, filename, {});
  }

  private doclingPost(
    route: string,
    fileField: string,
    data: Uint8Array,
    filename: string,
    fields: Record<string, string>
  ): Promise<string> {
    const key = this.key();
    if (!key) return Promise.reject(new Error("Set your GWDG API key first."));
    const url = new URL(this.base() + route);
    const { body, contentType } = buildMultipart(fields, fileField, filename, data);
    return new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          method: "POST",
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          headers: { "Content-Type": contentType, "Content-Length": body.length, Authorization: `Bearer ${key}` },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status === 404 || status === 405 || status === 422) {
              reject(new DoclingRouteError(`Docling ${route} ${status}: ${text.slice(0, 200)}`));
              return;
            }
            if (status >= 400) {
              reject(new Error(`GWDG Docling ${status}: ${text.slice(0, 200)}`));
              return;
            }
            try {
              const md = parseDoclingResponse(JSON.parse(text));
              if (md) resolve(md);
              else reject(new Error("GWDG Docling returned no Markdown"));
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        }
      );
      // Large papers can take a while to convert; give up after 5 minutes rather than hang.
      req.setTimeout(300_000, () => req.destroy(new Error("GWDG Docling timed out after 5 minutes")));
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  async fetchModels(): Promise<GwdgModelInfo[]> {
    const key = this.key();
    if (!key) throw new Error("Set your GWDG API key first.");
    const url = new URL(this.base() + "/models");
    return new Promise<GwdgModelInfo[]>((resolve, reject) => {
      const req = https.request(
        {
          method: "GET",
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname,
          headers: { Authorization: `Bearer ${key}` },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => {
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(`GWDG /models ${res.statusCode}: ${body.slice(0, 200)}`));
              return;
            }
            try {
              const o = JSON.parse(body);
              const models = (Array.isArray(o?.data) ? o.data : [])
                .map((m: { id?: unknown; owned_by?: unknown }) => classifyGwdgModel(m))
                .filter((m: GwdgModelInfo | null): m is GwdgModelInfo => m !== null)
                .sort((a: GwdgModelInfo, b: GwdgModelInfo) => a.id.localeCompare(b.id));
              resolve(models);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }
}
