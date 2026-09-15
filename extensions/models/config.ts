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
  "swarm workers": "swarm workers",
  "arena runners": "arena runners",
  "arena cross-judge pool": "arena cross-judge pool",
};

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

export function defaultModelsConfig(): PstackModelsConfig {
  return {
    version: 1,
    budget: "unlimited (max)",
    roles: {
      "feature, refactoring": "inherit-parent",
      "bug-fix": "inherit-parent",
      "perf-issue": "inherit-parent",
      hillclimb: "inherit-parent",
      "judgment and prose": "inherit-parent",
      "hardest tasks": "inherit-parent",
      "how explorer": "inherit-parent",
      "how explainer": "inherit-parent",
      "why investigators": "inherit-parent",
      "why synthesizer": "inherit-parent",
      "reflect tooling": "inherit-parent",
      "reflect judgment, divergent, synthesizer": "inherit-parent",
      "arena runners": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"],
      "arena cross-judge pool": ["inherit-parent"],
      "swarm workers": "inherit-parent",
      "architect runners": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"],
      "interrogate reviewers": ["inherit-parent", "inherit-parent", "inherit-parent", "inherit-parent"],
    },
  };
}
