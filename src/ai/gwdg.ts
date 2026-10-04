import * as https from "https";
import { AiMessage, AiProvider, AiHandlers, AiRunHandle, AiRunOptions } from "./provider";
import type AugmentedPdfPlugin from "../main";

const DEFAULT_BASE = "https://chat-ai.academiccloud.de/v1";
const DEFAULT_MODEL = "meta-llama-3.1-8b-instruct";

/**
 * GWDG Chat AI backend (OpenAI-compatible HTTP). Uses Node's `https` (the plugin is desktop-only and
 * already uses child_process) rather than browser `fetch`, so it streams SSE and isn't blocked by
 * CORS. Multi-turn is stateless: the full messages[] is sent each call. Chat completions only — no
 * tools/skills/web (capabilities reflect that); the glossary's PDF reading is deferred to Phase 2
 * (the /documents Docling endpoint).
 */
export class GwdgHttpProvider implements AiProvider {
  readonly id = "gwdg" as const;
  readonly label = "GWDG Chat AI";
  readonly capabilities = { skills: false, web: false, usd: false, readsFiles: false };

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

    const body = JSON.stringify({
      model: this.plugin.settings.gwdgModel || DEFAULT_MODEL,
      messages,
      stream: true,
    });

    let aborted = false;
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${key}`,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.setEncoding("utf8");
        if (status >= 400) {
          let errBody = "";
          res.on("data", (c: string) => (errBody += c));
          res.on("end", () => {
            if (!aborted) handlers.onError?.(new Error(`GWDG API ${status}: ${(errBody || res.statusMessage || "").slice(0, 300)}`));
          });
          return;
        }
        let buf = "";
        let acc = "";
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
              const delta = o?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) {
                acc += delta;
                handlers.onText?.(delta);
              }
            } catch {
              /* ignore keep-alives / partial frames */
            }
          }
        });
        res.on("end", () => {
          if (!aborted) handlers.onDone?.({ isError: false, result: acc, costUsd: 0 });
        });
        res.on("error", (e) => {
          if (!aborted) handlers.onError?.(e);
        });
      }
    );
    req.on("error", (e) => {
      if (!aborted) handlers.onError?.(e);
    });
    req.write(body);
    req.end();

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

  /** GET /models → sorted model ids, for the settings autocomplete. */
  async fetchModels(): Promise<string[]> {
    const key = this.key();
    if (!key) throw new Error("Set your GWDG API key first.");
    const url = new URL(this.base() + "/models");
    return new Promise<string[]>((resolve, reject) => {
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
              const ids = Array.isArray(o?.data)
                ? o.data.map((m: { id?: unknown }) => m.id).filter((x: unknown): x is string => typeof x === "string")
                : [];
              resolve(ids.sort());
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
