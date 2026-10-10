import type AugmentedPdfPlugin from "../main";
import { EFFORT_LEVELS, MODEL_CHOICES } from "../types";
import { readCodexConfigModel, readCodexModels } from "./codex";
import { gwdgReasoningOptions } from "./gwdg";

/**
 * The one answer to "which models and effort levels does provider X offer, and what are its
 * defaults?" — read by BOTH the settings tab and the chat panel. Each used to hard-code Anthropic's
 * list, so switching provider changed nothing visible. Each provider keeps its own default model and
 * effort, so switching back and forth never loses a choice.
 */

export type ProviderId = "claude" | "codex" | "gwdg";

export interface ModelChoice {
  value: string;
  label: string;
  /** Rendered as an <optgroup> heading; consecutive choices with the same group share it. */
  group?: string;
}

const CODEX_FALLBACK_LEVELS = ["low", "medium", "high"];

export function modelChoices(plugin: AugmentedPdfPlugin, p: ProviderId): ModelChoice[] {
  const s = plugin.settings;
  if (p === "claude") return MODEL_CHOICES.map((m) => ({ value: m, label: m }));

  if (p === "codex") {
    const cfg = readCodexConfigModel();
    const models = readCodexModels();
    const out: ModelChoice[] = [{ value: "", label: `Codex default${cfg ? ` (${cfg})` : ""}` }];
    if (s.codexModel && !models.some((m) => m.slug === s.codexModel)) {
      out.push({ value: s.codexModel, label: `${s.codexModel}  (saved; not in Codex's list)` });
    }
    for (const m of models) out.push({ value: m.slug, label: m.name === m.slug ? m.slug : `${m.name}  (${m.slug})` });
    return out;
  }

  // GWDG: the cached /models list, grouped by where each model runs.
  const list = s.gwdgModels ?? [];
  const out: ModelChoice[] = [];
  if (s.gwdgModel && !list.some((m) => m.id === s.gwdgModel)) {
    out.push({
      value: s.gwdgModel,
      label: list.length ? `${s.gwdgModel}  (saved; not in fetched list)` : `${s.gwdgModel}  (fetch the list to see all models)`,
    });
  }
  const groups: [string, (m: (typeof list)[number]) => boolean][] = [
    ["Hosted by GWDG — data stays at GWDG", (m) => m.kind === "chat" && !m.external],
    ["External — proxied to OpenAI / Anthropic (leaves GWDG)", (m) => m.kind === "chat" && m.external],
    ["Embedding models — can't chat", (m) => m.kind === "embedding"],
  ];
  for (const [group, keep] of groups) for (const m of list.filter(keep)) out.push({ value: m.id, label: m.id, group });
  return out;
}

/** Effort levels for this provider+model, "default" first. Empty = the provider has no effort control. */
export function effortChoices(plugin: AugmentedPdfPlugin, p: ProviderId, model: string): string[] {
  if (p === "claude") return [...EFFORT_LEVELS];
  if (p === "codex") {
    const slug = model || readCodexConfigModel();
    const levels = readCodexModels().find((m) => m.slug === slug)?.levels ?? [];
    return ["default", ...(levels.length ? levels : CODEX_FALLBACK_LEVELS)];
  }
  // GWDG: the model's own reasoning options (GWDG's table, e.g. none/on for Qwen 3.5, none/low/
  // medium/high for DeepSeek V4); models without a reasoning mode get no control.
  const opts = gwdgReasoningOptions(model || plugin.settings.gwdgModel);
  return opts ? ["default", ...opts] : [];
}

/** What the effort control is called for a provider — GWDG's options (none/on…) read as reasoning. */
export function effortLabel(p: ProviderId): string {
  return p === "gwdg" ? "Reasoning" : "Effort";
}

export function defaultModel(plugin: AugmentedPdfPlugin, p: ProviderId): string {
  const s = plugin.settings;
  return p === "claude" ? s.model : p === "codex" ? s.codexModel : s.gwdgModel;
}

export function defaultEffort(plugin: AugmentedPdfPlugin, p: ProviderId): string {
  const s = plugin.settings;
  return p === "claude" ? s.effort : p === "codex" ? s.codexEffort || "default" : s.gwdgEffort || "default";
}

export function setDefaultModel(plugin: AugmentedPdfPlugin, p: ProviderId, v: string): void {
  if (p === "claude") plugin.settings.model = v;
  else if (p === "codex") plugin.settings.codexModel = v;
  else plugin.settings.gwdgModel = v;
}

export function setDefaultEffort(plugin: AugmentedPdfPlugin, p: ProviderId, v: string): void {
  if (p === "claude") plugin.settings.effort = v;
  else if (p === "codex") plugin.settings.codexEffort = v;
  else plugin.settings.gwdgEffort = v;
}

/** The concrete model name to show/record for a non-Claude chat ("" for Codex = its config default). */
export function concreteModel(plugin: AugmentedPdfPlugin, p: ProviderId, model: string): string {
  if (p === "codex") return model || readCodexConfigModel() || "codex-default";
  if (p === "gwdg") return model || plugin.settings.gwdgModel;
  return model;
}

/** A value valid for this provider: `wanted` if offered, else the provider default, else the first choice. */
export function validModel(plugin: AugmentedPdfPlugin, p: ProviderId, wanted: string): string {
  const choices = modelChoices(plugin, p);
  if (choices.some((c) => c.value === wanted)) return wanted;
  const def = defaultModel(plugin, p);
  if (choices.some((c) => c.value === def)) return def;
  return choices[0]?.value ?? "";
}

/** Fill a <select> with choices, emitting <optgroup>s for grouped runs. */
export function fillSelect(sel: HTMLSelectElement, choices: ModelChoice[], value: string): void {
  sel.empty();
  let group: string | undefined;
  let og: HTMLElement | null = null;
  for (const c of choices) {
    let parent: HTMLElement = sel;
    if (c.group) {
      if (c.group !== group) {
        og = sel.createEl("optgroup");
        (og as HTMLOptGroupElement).label = c.group;
        group = c.group;
      }
      parent = og!;
    } else {
      group = undefined;
    }
    parent.createEl("option", { value: c.value, text: c.label });
  }
  sel.value = value;
}
