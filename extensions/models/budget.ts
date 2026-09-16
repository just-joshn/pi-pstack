/**
 * Reasoning-budget mapping for pstack roles.
 *
 * The config records the budget label chosen by /setup-pstack ("unlimited — keep
 * max", "large — xhigh reasoning", and so on). Pi takes a thinking level as a
 * `:<level>` suffix on the --model value, so a resolved role selector carries the
 * budget into the child. An explicit effort token in the config wins over the
 * budget because the user wrote it for that role, and an unrecognized budget
 * leaves the selector untouched rather than guessing a level.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const LEVELS = new Set<string>(THINKING_LEVELS);

const BUDGET_TARGETS: Record<string, ThinkingLevel> = {
  unlimited: "max",
  large: "xhigh",
  medium: "high",
  small: "medium",
};

export function effortForBudget(budget: unknown): ThinkingLevel | null {
  if (typeof budget !== "string") return null;
  const word = budget.trim().toLowerCase().split(/[\s(]/)[0] ?? "";
  return BUDGET_TARGETS[word] ?? null;
}

function explicitEffort(selector: string): { base: string; level: ThinkingLevel } | null {
  const colon = selector.lastIndexOf(":");
  if (colon > 0 && LEVELS.has(selector.slice(colon + 1))) {
    return { base: selector.slice(0, colon), level: selector.slice(colon + 1) as ThinkingLevel };
  }
  const dash = selector.lastIndexOf("-");
  if (dash > 0 && LEVELS.has(selector.slice(dash + 1))) {
    return { base: selector.slice(0, dash), level: selector.slice(dash + 1) as ThinkingLevel };
  }
  return null;
}

export function withBudget(selector: string, budget: unknown): string {
  const base = String(selector ?? "").trim();
  if (!base) return base;
  const explicit = explicitEffort(base);
  if (explicit) return `${explicit.base}:${explicit.level}`;
  const target = effortForBudget(budget);
  return target ? `${base}:${target}` : base;
}
