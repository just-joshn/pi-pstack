/**
 * Multidimensional pstack task policy (mandate sections 7 and 8).
 *
 * Permissions are not one readonly boolean. Eight independent axes decide what a
 * child may touch, and two of them disagree on purpose: an investigator runs with
 * a read-only filesystem while integrations stay inherited, because upstream why
 * and reflect run in Cursor agent mode precisely so MCP tools remain available
 * while the project stays untouched.
 *
 * This module is pure. It reads no environment and writes no file; enforcement
 * lives in policy-guard.ts.
 */
import { THINKING_LEVELS, type ThinkingLevel } from "../models/budget.ts";

/** Pi builtins that cannot mutate the tree (no bash / write / edit). */
export const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export type FilesystemPolicy = "read-only" | "workspace-write";
export type ShellPolicy = "none" | "restricted" | "full";
export type GitPolicy = "read" | "branch-write" | "push" | "merge";
export type NetworkPolicy = "none" | "allowed";
export type IntegrationsPolicy = "none" | "inherit" | string[];
export type EnvironmentPolicy = "local" | "hosted";
export type IsolationPolicy = "session" | "process" | "worktree" | "container" | "vm" | "remote";

export interface PstackTaskPolicy {
  readonly filesystem: FilesystemPolicy;
  readonly shell: ShellPolicy;
  readonly git: GitPolicy;
  readonly network: NetworkPolicy;
  readonly integrations: IntegrationsPolicy;
  readonly environment: EnvironmentPolicy;
  readonly background: boolean;
  readonly isolation: IsolationPolicy;
}

/** Partial override shape accepted by compileTaskPolicy (the pstack_task params + permissions). */
export interface PolicyOverrideInput {
  filesystem?: string;
  shell?: string;
  git?: string;
  network?: string;
  integrations?: string | string[];
  environment?: string;
  background?: boolean;
  isolation?: string;
  readonly?: boolean;
  worktree?: boolean;
}

export const FILESYSTEM_VALUES: readonly FilesystemPolicy[] = ["read-only", "workspace-write"];
export const SHELL_VALUES: readonly ShellPolicy[] = ["none", "restricted", "full"];
export const GIT_VALUES: readonly GitPolicy[] = ["read", "branch-write", "push", "merge"];
export const NETWORK_VALUES: readonly NetworkPolicy[] = ["none", "allowed"];
export const ENVIRONMENT_VALUES: readonly EnvironmentPolicy[] = ["local", "hosted"];
export const ISOLATION_VALUES: readonly IsolationPolicy[] = [
  "session",
  "process",
  "worktree",
  "container",
  "vm",
  "remote",
];

const BASE_POLICY: PstackTaskPolicy = Object.freeze({
  filesystem: "workspace-write",
  shell: "full",
  git: "branch-write",
  network: "allowed",
  integrations: "inherit",
  environment: "local",
  background: false,
  isolation: "session",
});

/**
 * Hosted execution places the run on the worker service. A caller who asked for a
 * local container or VM asked for a stronger sandbox than the worker default, so
 * that request survives; every weaker placement upgrades to remote.
 */
const HOSTED_STRONG_ISOLATION: ReadonlySet<IsolationPolicy> = new Set<IsolationPolicy>([
  "container",
  "vm",
  "remote",
]);

function basePolicy(overrides: Partial<PstackTaskPolicy>): PstackTaskPolicy {
  return Object.freeze({ ...BASE_POLICY, ...overrides });
}

/**
 * Per-role defaults. The read-only roles stop at the filesystem, shell, git, and
 * network axes. An investigator keeps integrations inherited: read-only files do
 * not imply integrations none.
 */
export const ROLE_POLICY_DEFAULTS: Readonly<Record<string, PstackTaskPolicy>> = Object.freeze({
  "comment-sicko": basePolicy({
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "none",
  }),
  investigator: basePolicy({
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "inherit",
  }),
  "poteto-agent": basePolicy({}),
  general: basePolicy({}),
});

export function defaultsForRole(role: string): PstackTaskPolicy {
  return Object.hasOwn(ROLE_POLICY_DEFAULTS, role)
    ? ROLE_POLICY_DEFAULTS[role]
    : ROLE_POLICY_DEFAULTS.general;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map((entry) => formatValue(entry)).join(", ")}]`;
  if (value === null || value === undefined) return String(value);
  return typeof value === "object" ? String(JSON.stringify(value)) : String(value);
}

function failInvalid(field: string, value: unknown, allowed: readonly string[]): never {
  throw new Error(
    `pstack task policy: invalid ${field} '${formatValue(value)}'; allowed: ${allowed.join(", ")}`,
  );
}

function pickEnum<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  return failInvalid(field, value, allowed);
}

function requireEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  const picked = pickEnum(field, value, allowed);
  if (picked === undefined) return failInvalid(field, value, allowed);
  return picked;
}

function pickBoolean(field: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  return failInvalid(field, value, ["true", "false"]);
}

function requireBoolean(field: string, value: unknown): boolean {
  const picked = pickBoolean(field, value);
  if (picked === undefined) return failInvalid(field, value, ["true", "false"]);
  return picked;
}

function pickIntegrations(value: unknown): IntegrationsPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "none" || value === "inherit") return value;
  const isGrantList =
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
  if (isGrantList) return Object.freeze([...(value as string[])]);
  return failInvalid("integrations", value, ["none", "inherit", "[<capability>, ...]"]);
}

function requireIntegrations(value: unknown): IntegrationsPolicy {
  const picked = pickIntegrations(value);
  if (picked === undefined) return failInvalid("integrations", value, ["none", "inherit", "[<capability>, ...]"]);
  return picked;
}

function resolveIsolation(opts: {
  isolation: IsolationPolicy;
  worktree: boolean;
  environment: EnvironmentPolicy;
}): IsolationPolicy {
  const placement = opts.worktree ? "worktree" : opts.isolation;
  const hostedNeedsRemote =
    opts.environment === "hosted" && !HOSTED_STRONG_ISOLATION.has(placement);
  return hostedNeedsRemote ? "remote" : placement;
}

/** Validate a complete policy object (all eight axes) and freeze it. */
export function normalizePolicyObject(raw: unknown): PstackTaskPolicy {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.freeze({
    filesystem: requireEnum("filesystem", source.filesystem, FILESYSTEM_VALUES),
    shell: requireEnum("shell", source.shell, SHELL_VALUES),
    git: requireEnum("git", source.git, GIT_VALUES),
    network: requireEnum("network", source.network, NETWORK_VALUES),
    integrations: requireIntegrations(source.integrations),
    environment: requireEnum("environment", source.environment, ENVIRONMENT_VALUES),
    background: requireBoolean("background", source.background),
    isolation: requireEnum("isolation", source.isolation, ISOLATION_VALUES),
  });
}

/** Merge role defaults with explicit overrides; readonly/worktree/hosted force their axes. */
export function compileTaskPolicy(input: PolicyOverrideInput | undefined, role: string): PstackTaskPolicy {
  const overrides = input ?? {};
  const defaults = defaultsForRole(role);
  const readonly = pickBoolean("readonly", overrides.readonly) === true;
  const worktree = pickBoolean("worktree", overrides.worktree) === true;
  const environment = pickEnum("environment", overrides.environment, ENVIRONMENT_VALUES) ?? defaults.environment;
  const isolation = pickEnum("isolation", overrides.isolation, ISOLATION_VALUES) ?? defaults.isolation;
  const merged = {
    filesystem: readonly ? "read-only" : (pickEnum("filesystem", overrides.filesystem, FILESYSTEM_VALUES) ?? defaults.filesystem),
    shell: readonly ? "none" : (pickEnum("shell", overrides.shell, SHELL_VALUES) ?? defaults.shell),
    git: readonly ? "read" : (pickEnum("git", overrides.git, GIT_VALUES) ?? defaults.git),
    network: pickEnum("network", overrides.network, NETWORK_VALUES) ?? defaults.network,
    integrations: pickIntegrations(overrides.integrations) ?? defaults.integrations,
    environment,
    background: pickBoolean("background", overrides.background) ?? defaults.background,
    isolation: resolveIsolation({ isolation, worktree, environment }),
  };
  return normalizePolicyObject(merged);
}

/**
 * Child `--tools` allowlist. Explicit tools win; a read-only filesystem drops to
 * the four Pi read builtins plus the integration tools the policy grants (the
 * whole point of the read-only-filesystem-with-inherited-integrations shape);
 * shell none removes bash from an inherited list. An undefined result means no
 * allowlist, so the child keeps full discovery and the runtime guard in
 * policy-guard.ts is the backstop.
 */
export function resolvePolicyTools(
  policy: PstackTaskPolicy,
  explicitTools?: string[],
  parentTools?: string[],
): string[] | undefined {
  if (explicitTools?.length) return [...explicitTools];
  if (policy.filesystem === "read-only") {
    return [...READONLY_TOOLS, ...integrationToolsFor(policy.integrations)];
  }
  const inherited = parentTools?.length ? [...parentTools] : undefined;
  if (policy.shell === "none") return inherited?.filter((tool) => tool !== "bash");
  return inherited;
}

function embeddedThinkingLevel(selector?: string): ThinkingLevel | undefined {
  if (!selector) return undefined;
  const colon = selector.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const suffix = selector.slice(colon + 1);
  return (THINKING_LEVELS as readonly string[]).includes(suffix) ? (suffix as ThinkingLevel) : undefined;
}

/**
 * Explicit thinkingLevel wins; otherwise read the `:<level>` suffix that
 * resolveRoleModel/withBudget embeds in the selector. An unrecognized explicit
 * level is a caller error and throws rather than silently downgrading.
 */
export function resolveThinkingLevel(
  input: { thinkingLevel?: string } | undefined,
  roleModelSelector?: string,
): ThinkingLevel | undefined {
  const explicit = input?.thinkingLevel;
  if (explicit === undefined) return embeddedThinkingLevel(roleModelSelector);
  if ((THINKING_LEVELS as readonly string[]).includes(explicit)) return explicit as ThinkingLevel;
  return failInvalid("thinkingLevel", explicit, THINKING_LEVELS);
}

/** The mandated integration/MCP capability categories, shared by S3 and the guard. */
const INTEGRATION_CATEGORY_VALUES = [
  "source-control",
  "issue-tracker",
  "long-form-docs",
  "team-chat",
  "observability",
  "error-tracking",
  "analytics",
  "browser-ui",
  "cli-tui",
] as const;

export type IntegrationCategory = (typeof INTEGRATION_CATEGORY_VALUES)[number];

export const INTEGRATION_CATEGORIES: readonly IntegrationCategory[] = Object.freeze([
  ...INTEGRATION_CATEGORY_VALUES,
]);

/**
 * Capability to tool-name-pattern table. browser-ui and cli-tui already exist as
 * Pi tools; the rest are the extension surfaces S3 adds, so the guard and the
 * registry read one source instead of two drifting lists.
 */
export const INTEGRATION_CAPABILITIES: Readonly<Record<IntegrationCategory, readonly string[]>> =
  Object.freeze({
    "source-control": Object.freeze(["pstack_source_control"]),
    "issue-tracker": Object.freeze(["pstack_issue_tracker"]),
    "long-form-docs": Object.freeze(["pstack_long_form_docs"]),
    "team-chat": Object.freeze(["pstack_team_chat"]),
    observability: Object.freeze(["pstack_observability"]),
    "error-tracking": Object.freeze(["pstack_error_tracking"]),
    analytics: Object.freeze(["pstack_analytics"]),
    "browser-ui": Object.freeze(["pstack_control_ui"]),
    "cli-tui": Object.freeze(["pstack_control_cli"]),
  });

/**
 * Tool names an integrations policy grants: every known capability tool for
 * "inherit", only the granted categories for an explicit list, none for "none".
 * Unknown tool names in a `--tools` allowlist are ignored by Pi, so a capability
 * tool that ships later becomes reachable without another policy change.
 */
export function integrationToolsFor(integrations: IntegrationsPolicy): string[] {
  if (integrations === "none") return [];
  const categories = Array.isArray(integrations) ? integrations : INTEGRATION_CATEGORIES;
  return categories.flatMap((category) => [...INTEGRATION_CAPABILITIES[category]]);
}

function matchesPattern(toolName: string, pattern: string): boolean {
  return toolName === pattern || toolName.startsWith(`${pattern}_`) || toolName.startsWith(`${pattern}.`);
}

export function capabilityForTool(toolName: string): IntegrationCategory | undefined {
  return INTEGRATION_CATEGORIES.find((category) =>
    INTEGRATION_CAPABILITIES[category].some((pattern) => matchesPattern(toolName, pattern)),
  );
}

export function describePolicy(policy: PstackTaskPolicy): string {
  const integrations = Array.isArray(policy.integrations)
    ? policy.integrations.join("|")
    : policy.integrations;
  return [
    `filesystem=${policy.filesystem}`,
    `shell=${policy.shell}`,
    `git=${policy.git}`,
    `network=${policy.network}`,
    `integrations=${integrations}`,
    `environment=${policy.environment}`,
    `background=${policy.background}`,
    `isolation=${policy.isolation}`,
  ].join(" ");
}
