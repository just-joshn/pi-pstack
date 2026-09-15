/**
 * Per-role model config: ~/.pi/agent/pstack-models.json
 * Own thin config; no third-party Pi pstack ports.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Skill-documented defaults used when no parent slug is detectable. */
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
      /* ignore */
    }
  }
  return null;
}

/** Resolve a role to a model selector. Panel roles can use index. */
export function resolveRoleModel(
  role: string,
  parentModel: string,
  index = 0,
): string | undefined {
  const cfg = loadModelsConfig();
  if (!cfg) return undefined;
  const key = ROLE_ALIASES[role] ?? role;
  const value = cfg.roles[key] ?? cfg.roles[role];
  if (value == null) return undefined;
  const pick = Array.isArray(value) ? value[Math.min(index, value.length - 1)] : value;
  if (!pick || pick === "inherit-parent" || pick === "auto") return parentModel;
  return pick;
}

/**
 * Detect a preferred provider/id from the environment or Pi agent files.
 * Returns undefined when nothing concrete is available.
 */
export function detectPreferredModel(): string | undefined {
  const env = process.env.PI_MODEL || process.env.PSTACK_DEFAULT_MODEL;
  if (env && env.includes("/") && !env.includes(" ")) return env;
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
        if (typeof v === "string" && v.includes("/")) return v;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Build defaults: prefer concrete skill slugs (or a detected parent slug for
 * code roles) instead of inherit-parent so /setup-pstack is closer to upstream
 * baked-in model defaults.
 */
export function defaultModelsConfig(preferred?: string): PstackModelsConfig {
  const code = preferred && preferred.includes("/") ? preferred : SKILL_DEFAULT_CODE;
  const judgment = SKILL_DEFAULT_JUDGMENT;
  const arena = [...SKILL_DEFAULT_ARENA];
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
