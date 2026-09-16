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
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
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

/** Marketing slug strength tiers, weakest to strongest. */
export const MARKETING_TIERS = Object.freeze(["fast", "medium", "high", "max"] as const);
export type MarketingTier = (typeof MARKETING_TIERS)[number];

/**
 * Best-effort tier -> real Pi provider/id. The slug's brand is dropped because we
 * only have a few concrete ids; the tier, not the brand, fixes capability order.
 */
export const TIER_PROVIDER_MAP: Readonly<Record<MarketingTier, string>> = Object.freeze({
  fast: "xai/grok-4",
  medium: "openai/gpt-5",
  high: "anthropic/claude-sonnet-4-5",
  max: "anthropic/claude-opus-4-5",
});

/** Best-effort tier for each known Cursor marketing slug. */
export const MARKETING_SLUG_TIERS: Readonly<Record<string, MarketingTier>> = Object.freeze({
  "grok-4.6-fast-xhigh": "fast",
  "grok-4.6": "fast",
  "claude-fable-5-1-thinking-max": "max",
  "claude-opus-5-thinking-xhigh": "high",
  "gpt-5.6-sol-max": "medium",
  "cursor-grok-4.6-medium-fast": "medium",
});

/**
 * Known Cursor marketing slug -> provider/id, derived from the tier table so a
 * single tier edit cannot silently invert one pair. Unmapped bare slugs are refused.
 */
export const MARKETING_SLUG_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MARKETING_SLUG_TIERS).map(([slug, tier]) => [slug, TIER_PROVIDER_MAP[tier]]),
  ),
);

/** Weakest-to-strongest rank of a marketing tier. */
export function marketingTierRank(tier: MarketingTier): number {
  return MARKETING_TIERS.indexOf(tier);
}

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
  return join(cwd, CONFIG_DIR_NAME, "pstack-models.json");
}

/**
 * Project-local config is honored only for a trusted project. Returns the cwd
 * whose project config may be read, or undefined to fall back to the global
 * config alone.
 */
export function projectConfigCwd(ctx: {
  readonly cwd: string;
  readonly isProjectTrusted?: () => boolean;
}): string | undefined {
  return ctx.isProjectTrusted?.() === true ? ctx.cwd : undefined;
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
  trustedConfigCwd?: string,
): string | undefined {
  const cfg = loadModelsConfig(trustedConfigCwd);
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
