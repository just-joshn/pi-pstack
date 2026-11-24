import { aliases } from "./model-aliases.mjs";
import { isRecord } from "./validation.mjs";

export const roles = [
  "feature, refactoring",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "judgment and prose",
  "arena runners",
  "arena cross-judge pool",
  "swarm workers",
  "interrogate reviewers",
] as const;
export type Role = (typeof roles)[number];
export const isRole = (value: string): value is Role => roles.some((role) => role === value);
export const panelRoles: ReadonlySet<Role> = new Set([
  "arena runners",
  "arena cross-judge pool",
  "interrogate reviewers",
]);
export const judgeRole = "arena cross-judge pool" satisfies Role;

export const budgets = ["large", "medium", "small"] as const;
export type Budget = (typeof budgets)[number];
const isBudget = (value: unknown): value is Budget => budgets.some((budget) => budget === value);

const levels = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof levels)[number];

export interface RoleConfig {
  defaults: 3;
  budget: Budget;
  roles: Record<Role, string[]>;
}

const baseEffort = (role: Role): Effort =>
  panelRoles.has(role) || role === "swarm workers" ? "high" : "xhigh";
export function effort(role: Role, budget: Budget, model = ""): Effort {
  const target = panelRoles.has(role) && /gemini/i.test(model) ? "xhigh" : baseEffort(role);
  return levels[Math.max(0, levels.indexOf(target) - budgets.indexOf(budget))];
}

function assertSelections(
  selections: Record<string, unknown>,
): asserts selections is Record<Role, string[]> {
  if (Object.keys(selections).length !== roles.length) throw Error("Invalid model configuration");
  for (const r of roles) {
    const values = selections[r];
    if (
      !Array.isArray(values) ||
      (!panelRoles.has(r) && values.length !== 1) ||
      (r !== judgeRole && values.length === 0) ||
      values.length > 8 ||
      values.some((v) => typeof v !== "string" || !v.trim())
    )
      throw Error(`Invalid selection for ${r}`);
    if (r === judgeRole && values.some((v) => aliases.includes(v)))
      throw Error("Judge pool requires explicit models");
  }
}

export function parseModelConfig(config: unknown): RoleConfig {
  if (
    !isRecord(config) ||
    config.defaults !== 3 ||
    !isBudget(config.budget) ||
    !isRecord(config.roles)
  )
    throw Error("Invalid model configuration");
  assertSelections(config.roles);
  return { defaults: config.defaults, budget: config.budget, roles: config.roles };
}
export function defaultConfig(): RoleConfig {
  return parseModelConfig({
    defaults: 3,
    budget: "large",
    roles: Object.fromEntries(roles.map((r) => [r, r === judgeRole ? [] : ["inherit-parent"]])),
  });
}
export function applyConfigPatch(config: RoleConfig, patch: unknown): RoleConfig {
  if (!isRecord(patch) || ("roles" in patch && !isRecord(patch.roles)))
    throw Error("Invalid model configuration patch");
  return parseModelConfig({ ...config, ...patch, roles: { ...config.roles, ...patch.roles } });
}
export function validateConfig(input: unknown, available: readonly string[]): RoleConfig {
  const config = parseModelConfig(input);
  const allowed = new Set([...aliases, ...available]);
  for (const r of roles) {
    if (config.roles[r].some((v) => !allowed.has(v))) throw Error(`Unavailable model for ${r}`);
  }
  return config;
}
export function modelFor(value: string, parent: string) {
  if (!aliases.includes(value)) return value;
  if (!parent) throw Error("No parent model selected");
  return parent;
}
export function vendor(model: string) {
  const [provider, ...rest] = model.toLowerCase().split("/");
  const id = rest.join("/");
  if (/(^|[/.-])claude|anthropic/.test(id)) return "anthropic";
  if (/(^|[/.-])gemini|google/.test(id)) return "google";
  if (/(^|[/.-])(gpt|o[1-9]|codex)([/.-]|$)|openai/.test(id)) return "openai";
  if (/(^|[/.-])grok|xai/.test(id)) return "xai";
  return provider;
}
export function crossJudge(config: RoleConfig, parent: string, candidates: string[] = []) {
  const excluded = new Set([parent, ...candidates].map(vendor));
  return config.roles[judgeRole].find((m) => !excluded.has(vendor(m)));
}
export function selectPanel(config: RoleConfig, role: Role, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 8)
    throw Error("Worker count must be 1 to 8");
  const choices = config.roles[role];
  if (!choices.length) throw Error(`No models configured for ${role}`);
  return Array.from({ length: count }, (_, i) => choices[i % choices.length]);
}
