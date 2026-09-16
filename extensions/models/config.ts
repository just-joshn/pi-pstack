/**
 * Per-role model config: ~/.pi/agent/pstack-models.json
 * Own thin config; no third-party Pi pstack ports.
 *
 * Bare Cursor marketing slugs (no provider/) are refused or mapped; setup
 * writes concrete provider/id when detectable, else inherit-parent.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withBudget } from "./budget.ts";

export type RoleValue = string | string[];

export interface PstackModelsConfig {
  version: 1;
  budget?: string;
  roles: Record<string, RoleValue>;
}

const ROLE_ALIASES: Record<string, string> = {
  general: "feature, refactoring",
  "poteto-agent": "feature, refactoring",
  "comment-sicko": "judgment and prose",
  investigator: "how explorer",
  "swarm workers": "swarm workers",
  "arena runners": "arena runners",
  "arena cross-judge pool": "arena cross-judge pool",
};

/**
 * Known Cursor marketing slug → best-effort Pi provider/id.
 * Unmapped bare slugs are refused (fall back to parent / inherit-parent).
 */
export const MARKETING_SLUG_MAP: Record<string, string> = {
  "grok-4.6-fast-xhigh": "xai/grok-4",
  "grok-4.6": "xai/grok-4",
  "claude-fable-5-1-thinking-max": "anthropic/claude-sonnet-4-5",
  "claude-opus-5-thinking-xhigh": "anthropic/claude-opus-4-5",
  "gpt-5.6-sol-max": "openai/gpt-5",
  "cursor-grok-4.6-medium-fast": "xai/grok-4",
};

/** Legacy skill-doc names retained for docs only — never written as config defaults. */
export const SKILL_DEFAULT_CODE = "grok-4.6-fast-xhigh";
export const SKILL_DEFAULT_JUDGMENT = "claude-fable-5-1-thinking-max";
export const SKILL_DEFAULT_ARENA = [
  "claude-fable-5-1-thinking-max",
  "gpt-5.6-sol-max",
  "grok-4.6-fast-xhigh",
  "claude-opus-5-thinking-xhigh",
] as const;

export function modelsConfigPath(): string {
  return join(homedir(), ".pi", "agent", "pstack-models.json");
}

export function projectModelsConfigPath(cwd: string): string {
  return join(cwd, ".pi", "pstack-models.json");
}

export function loadModelsConfig(cwd?: string): PstackModelsConfig | null {
  const candidates = [
    cwd ? projectModelsConfigPath(cwd) : null,
    modelsConfigPath(),
  ].filter(Boolean) as string[];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as PstackModelsConfig;
      if (raw?.version === 1 && raw.roles && typeof raw.roles === "object") return raw;
    } catch {
      /* ignore malformed config */
      continue;
    }
  }
  return null;
}

export function isInheritAlias(value: string): boolean {
  return value === "inherit-parent" || value === "auto";
}

/** True when selector looks like Pi provider/id. */
export function isProviderId(value: string): boolean {
  return Boolean(value && value.includes("/") && !value.includes(" ") && !value.startsWith("/"));
}

export function isBareMarketingSlug(value: string): boolean {
  if (!value || isInheritAlias(value) || isProviderId(value)) return false;
  return !value.includes("/");
}

export type NormalizeResult =
  | { ok: true; model: string; mappedFrom?: string }
  | { ok: false; error: string };

/**
 * Refuse bare marketing slugs unless mapped; allow provider/id and inherit aliases.
 * When parentModel is provided, unmapped bare slugs fall back to parent (ok) with mappedFrom note
 * only if map hits; otherwise error unless allowFallbackToParent.
 */
export function normalizeModelSelector(
  value: string,
  parentModel?: string,
  opts?: { allowFallbackToParent?: boolean },
): NormalizeResult {
  const v = value.trim();
  if (!v) {
    if (parentModel) return { ok: true, model: parentModel };
    return { ok: false, error: "empty model selector" };
  }
  if (isInheritAlias(v)) {
    if (parentModel) return { ok: true, model: parentModel };
    return { ok: true, model: v };
  }
  if (isProviderId(v)) return { ok: true, model: v };

  const mapped = MARKETING_SLUG_MAP[v];
  if (mapped) return { ok: true, model: mapped, mappedFrom: v };

  const allowFallback = opts?.allowFallbackToParent !== false;
  if (allowFallback && parentModel && isProviderId(parentModel)) {
    return {
      ok: true,
      model: parentModel,
      mappedFrom: v,
    };
  }
  return {
    ok: false,
    error: `Refused bare model slug '${v}'. Pass provider/id (e.g. anthropic/claude-sonnet-4-5), inherit-parent, or auto. Known maps: ${Object.keys(MARKETING_SLUG_MAP).join(", ")}`,
  };
}

/** Resolve a role to a model selector, carrying the configured reasoning budget. */
export function resolveRoleModel(
  role: string,
  parentModel: string,
  index = 0,
  cwd?: string,
): string | undefined {
  const cfg = loadModelsConfig(cwd);
  if (!cfg) return undefined;
  const key = ROLE_ALIASES[role] ?? role;
  const value = cfg.roles[key] ?? cfg.roles[role];
  if (value == null) return undefined;
  const pick = Array.isArray(value) ? value[Math.min(index, value.length - 1)] : value;
  if (!pick || isInheritAlias(pick)) return withBudget(parentModel, cfg.budget);
  const norm = normalizeModelSelector(pick, parentModel, { allowFallbackToParent: true });
  return norm.ok ? withBudget(norm.model, cfg.budget) : withBudget(parentModel, cfg.budget);
}

/**
 * Detect a preferred provider/id from the environment or Pi agent files.
 * Returns undefined when nothing concrete is available.
 */
export function detectPreferredModel(): string | undefined {
  const env = process.env.PI_MODEL || process.env.PSTACK_DEFAULT_MODEL;
  if (env && isProviderId(env)) return env;
  if (env && isBareMarketingSlug(env)) {
    const mapped = MARKETING_SLUG_MAP[env];
    if (mapped) return mapped;
  }
  const candidates = [
    join(homedir(), ".pi", "agent", "settings.json"),
    join(homedir(), ".pi", "settings.json"),
  ];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      for (const key of ["defaultModel", "model", "lastModel"]) {
        const v = raw[key];
        if (typeof v === "string" && isProviderId(v)) return v;
        if (typeof v === "string" && MARKETING_SLUG_MAP[v]) return MARKETING_SLUG_MAP[v];
      }
    } catch {
      /* ignore malformed settings */
      continue;
    }
  }
  return undefined;
}

/**
 * Sanitize a role value for writing: map/refuse bare slugs; prefer provider/id.
 */
export function sanitizeRoleValueForWrite(
  value: RoleValue,
  preferred?: string,
): RoleValue {
  const one = (v: string): string => {
    if (isInheritAlias(v)) return v;
    if (isProviderId(v)) return v;
    const mapped = MARKETING_SLUG_MAP[v];
    if (mapped) return mapped;
    if (preferred && isProviderId(preferred)) return preferred;
    return "inherit-parent";
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}

/**
 * Build defaults: prefer detected provider/id for code roles; never write bare
 * Cursor marketing slugs. Unresolved judgment/panel roles use inherit-parent
 * (or mapped provider/id when we have a known map and no detection).
 */
export function defaultModelsConfig(preferred?: string): PstackModelsConfig {
  const code =
    preferred && isProviderId(preferred)
      ? preferred
      : preferred
        ? sanitizeRoleValueForWrite(preferred) as string
        : "inherit-parent";
  const judgmentMapped = MARKETING_SLUG_MAP[SKILL_DEFAULT_JUDGMENT];
  const judgment =
    preferred && isProviderId(preferred) ? preferred : judgmentMapped ?? "inherit-parent";
  const arena = SKILL_DEFAULT_ARENA.map((s) => {
    if (preferred && isProviderId(preferred)) return preferred;
    return MARKETING_SLUG_MAP[s] ?? "inherit-parent";
  });
  return {
    version: 1,
    budget: "unlimited (max)",
    roles: {
      "feature, refactoring": code,
      "bug-fix": code,
      "perf-issue": code,
      hillclimb: code,
      "judgment and prose": judgment,
      "hardest tasks": judgment,
      "how explorer": code,
      "how explainer": judgment,
      "why investigators": code,
      "why synthesizer": judgment,
      "reflect tooling": code,
      "reflect judgment, divergent, synthesizer": judgment,
      "arena runners": arena,
      "arena cross-judge pool": [judgment],
      "swarm workers": code,
      "architect runners": arena,
      "interrogate reviewers": arena,
    },
  };
}
