import { isRecord } from "./validation.ts";

export const aliases = ["auto", "inherit-parent"];

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
  return levels[Math.max(0, levels.indexOf(target) - budgets.indexOf(budget))] ?? target;
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
    if (r === judgeRole && values.some((v) => typeof v === "string" && aliases.includes(v)))
      throw Error("Judge pool requires explicit models");
  }
}

export function parseModelConfig(config: unknown): RoleConfig {
  if (
    !isRecord(config) ||
    config["defaults"] !== 3 ||
    !isBudget(config["budget"]) ||
    !isRecord(config["roles"])
  )
    throw Error("Invalid model configuration");
  assertSelections(config["roles"]);
  return { defaults: config["defaults"], budget: config["budget"], roles: config["roles"] };
}
/** Upstream setup-pstack's step 5 defaults, as Pi model IDs without a provider. */
const panel = ["claude-fable-5-2", "claude-opus-5-5", "gemini-4-neon"];
export const upstreamDefaults: Record<Role, string[]> = {
  "feature, refactoring": ["claude-opus-5-5"],
  "bug-fix": ["claude-opus-5-5"],
  "perf-issue": ["claude-opus-5-5"],
  hillclimb: ["claude-opus-5-5"],
  "judgment and prose": ["claude-opus-5-5"],
  "arena runners": panel,
  "arena cross-judge pool": ["claude-opus-5-5", "gemini-4-neon"],
  "swarm workers": ["claude-opus-5-5"],
  "interrogate reviewers": panel,
};

const modelId = (model: string) => model.slice(model.indexOf("/") + 1).toLowerCase();
/** Arena's families: claude-fable-*, claude-*, gemini-*, otherwise the text before the first hyphen. */
export function family(model: string) {
  const id = modelId(model);
  return (
    ["claude-fable", "claude", "gemini"].find((f) => id.startsWith(f + "-")) ?? id.split("-")[0]
  );
}
const sharedPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
};

/**
 * The available model with this ID, else the closest one of its family: the longest shared ID
 * prefix (claude-opus-* before claude-sonnet-* for claude-opus-5-5), then the highest version.
 */
export function resolveDefault(id: string, available: readonly string[]) {
  const exact = available.toSorted().find((m) => modelId(m) === id);
  if (exact) return exact;
  return available
    .filter((m) => family(m) === family(id))
    .toSorted(
      (a, b) =>
        sharedPrefix(modelId(b), id) - sharedPrefix(modelId(a), id) ||
        modelId(b).localeCompare(modelId(a), undefined, { numeric: true }),
    )[0];
}

/**
 * The upstream defaults resolved against the models workers can use. An unresolved seat runs on
 * the parent model, so a panel keeps its size; the judge pool takes no alias and drops it.
 */
export function defaultConfig(available: readonly string[] = []): RoleConfig {
  const resolve = (r: Role) =>
    upstreamDefaults[r].flatMap((id) => {
      const model = resolveDefault(id, available);
      if (r === judgeRole) return model ? [model] : [];
      return [model ?? "inherit-parent"];
    });
  return parseModelConfig({
    defaults: 3,
    budget: "large",
    roles: Object.fromEntries(roles.map((r) => [r, resolve(r)])),
  });
}
export function applyConfigPatch(config: RoleConfig, patch: unknown): RoleConfig {
  const selections = isRecord(patch) && "roles" in patch ? patch["roles"] : {};
  if (!isRecord(patch) || !isRecord(selections)) throw Error("Invalid model configuration patch");
  return parseModelConfig({ ...config, ...patch, roles: { ...config.roles, ...selections } });
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
/** Upstream arena's judge: the first available pool entry from a vendor other than the parent's. */
export function crossJudge(config: RoleConfig, parent: string, available: ReadonlySet<string>) {
  return config.roles[judgeRole].find((m) => available.has(m) && vendor(m) !== vendor(parent));
}
export function selectPanel(config: RoleConfig, role: Role, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 8)
    throw Error("Worker count must be 1 to 8");
  const choices = config.roles[role];
  if (!choices.length) throw Error(`No models configured for ${role}`);
  const rounds = Array.from({ length: Math.ceil(count / choices.length) }, () => choices);
  return rounds.flat().slice(0, count);
}
