/**
 * Runtime enforcement for a compiled PstackTaskPolicy.
 *
 * The parent compiles a policy, passes it to the child as PSTACK_CHILD_POLICY,
 * and the child's extension host registers this hook. argv is a hint; this guard
 * is the boundary, so a child cannot escalate by calling a tool the policy
 * excludes. A malformed policy fails closed instead of silently allowing writes.
 */
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  capabilityForTool,
  normalizePolicyObject,
  type GitPolicy,
  type PstackTaskPolicy,
} from "./policy.ts";

export interface GuardEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export type GuardDecision = { block: true; reason: string };

export interface GuardPolicyState {
  readonly policy?: PstackTaskPolicy;
  readonly blockReason?: string;
}

/** Filesystem read-only blocks exactly the two Pi mutation builtins. */
const FILESYSTEM_WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/** Tools a child keeps when its policy could not be parsed: reads cannot mutate. */
const UNPARSEABLE_SAFE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

const GIT_READ_BLOCKED: ReadonlySet<string> = new Set([
  "push",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "reset",
  "checkout",
  "switch",
  "branch",
  "tag",
  "remote",
  "config",
  "apply",
  "am",
  "stash",
  "clean",
  "restore",
]);

/** branch-write covers local branch mutation only; publishing and rewrites stay blocked. */
const GIT_BRANCH_WRITE_BLOCKED: ReadonlySet<string> = new Set([
  "push",
  "merge",
  "rebase",
  "cherry-pick",
  "reset",
  "tag",
  "remote",
  "config",
  "apply",
  "am",
  "stash",
  "clean",
  "restore",
]);

const GIT_PUSH_BLOCKED: ReadonlySet<string> = new Set(["merge"]);

const GIT_FETCH_SUBCOMMANDS: ReadonlySet<string> = new Set(["clone", "fetch", "pull"]);

const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
]);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv"]);

const PACKAGE_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "install",
  "i",
  "ci",
  "add",
  "update",
  "up",
  "upgrade",
  "remove",
  "rm",
  "uninstall",
  "publish",
]);

const PACKAGE_MANAGER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-p",
  "-w",
  "-F",
  "--prefix",
  "--cwd",
  "--dir",
  "--workspace",
  "--filter",
  "--registry",
  "--tag",
]);

const GH_WRITE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "merge",
  "close",
  "reopen",
  "edit",
  "delete",
  "comment",
  "review",
  "sync",
  "fork",
  "clone",
  "push",
  "transfer",
  "lock",
  "unlock",
  "rerun",
  "cancel",
  "enable",
  "disable",
  "set",
  "add",
  "remove",
  "import",
  "publish",
]);

const GH_READ_VERBS: ReadonlySet<string> = new Set([
  "view",
  "list",
  "status",
  "diff",
  "search",
  "checks",
  "help",
  "version",
  "browse",
  "show",
]);

/** Commands that only wrap another command, so the real name follows them. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "nice",
  "nohup",
  "time",
  "xargs",
]);

const SHELL_SEGMENT = /(?:&&|\|\||[;|&])/;

export interface BashSegment {
  readonly name: string;
  readonly args: readonly string[];
}

function block(reason: string): GuardDecision {
  return { block: true, reason: `pstack policy guard: ${reason}` };
}

function tokenName(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

function normalizeToken(token: string): string {
  return token.replace(/^[('"`]+/, "").replace(/[)'"`;,&|]+$/, "");
}

function segmentWithCommand(segment: string[]): BashSegment | undefined {
  let index = 0;
  let remaining = segment.length;
  while (remaining > 0) {
    const token = segment[index];
    const isAssignment = token.includes("=") && !token.startsWith("-") && index === 0;
    const name = tokenName(token);
    const isPrefix = COMMAND_PREFIXES.has(name) && remaining > 1;
    if (isAssignment || isPrefix) {
      index += 1;
      remaining = segment.length - index;
      continue;
    }
    return { name, args: segment.slice(index + 1) };
  }
  return undefined;
}

/** Split a bash command line into per-segment command names so operands never match. */
export function bashSegments(command: string): BashSegment[] {
  return command
    .split(SHELL_SEGMENT)
    .map((segment) =>
      segment
        .split(/\s+/)
        .map(normalizeToken)
        .filter((token) => token.length > 0),
    )
    .filter((tokens) => tokens.length > 0)
    .flatMap((tokens) => segmentWithCommand(tokens) ?? []);
}

function subcommandFromArgs(args: readonly string[], valueFlags: ReadonlySet<string>): string | undefined {
  let index = 0;
  let remaining = args.length;
  while (remaining > 0) {
    const token = args[index];
    if (!token.startsWith("-")) return token.toLowerCase();
    index += valueFlags.has(token) ? 2 : 1;
    remaining = args.length - index;
  }
  return undefined;
}

function gitSubcommands(segments: readonly BashSegment[]): string[] {
  return segments
    .filter((segment) => segment.name === "git")
    .flatMap((segment) => {
      const sub = subcommandFromArgs(segment.args, GIT_VALUE_FLAGS);
      return sub ? [sub] : [];
    });
}

function blockedGitSubcommands(git: GitPolicy): ReadonlySet<string> | undefined {
  if (git === "read") return GIT_READ_BLOCKED;
  if (git === "branch-write") return GIT_BRANCH_WRITE_BLOCKED;
  if (git === "push") return GIT_PUSH_BLOCKED;
  return undefined;
}

function gitGuard(policy: PstackTaskPolicy, segments: readonly BashSegment[]): GuardDecision | undefined {
  const blocked = blockedGitSubcommands(policy.git);
  if (!blocked) return undefined;
  const hit = gitSubcommands(segments).find((sub) => blocked.has(sub));
  return hit ? block(`git policy ${policy.git} blocks 'git ${hit}'`) : undefined;
}

function packageWriterFor(segment: BashSegment): string | undefined {
  if (!PACKAGE_MANAGERS.has(segment.name)) return undefined;
  const sub = subcommandFromArgs(segment.args, PACKAGE_MANAGER_VALUE_FLAGS);
  return sub && PACKAGE_WRITE_SUBCOMMANDS.has(sub) ? `${segment.name} ${sub}` : undefined;
}

function ghCulprit(segments: readonly BashSegment[]): string | undefined {
  const gh = segments.find((segment) => segment.name === "gh");
  if (!gh) return undefined;
  const words = gh.args.map((arg) => arg.toLowerCase()).filter((arg) => !arg.startsWith("-"));
  if (words.some((word) => GH_READ_VERBS.has(word))) return undefined;
  return `gh ${words.slice(0, 2).join(" ")}`.trim();
}

function networkCulprit(segments: readonly BashSegment[]): string | undefined {
  const direct = segments.find((segment) => NETWORK_COMMANDS.has(segment.name));
  if (direct) return direct.name;
  const fetch = gitSubcommands(segments).find((sub) => GIT_FETCH_SUBCOMMANDS.has(sub));
  if (fetch) return `git ${fetch}`;
  const writer = segments.map(packageWriterFor).find((hit) => hit !== undefined);
  return writer ?? ghCulprit(segments);
}

function networkGuard(policy: PstackTaskPolicy, segments: readonly BashSegment[]): GuardDecision | undefined {
  if (policy.network !== "none") return undefined;
  const hit = networkCulprit(segments);
  return hit ? block(`network none blocks '${hit}'`) : undefined;
}

function filesystemGuard(policy: PstackTaskPolicy, toolName: string): GuardDecision | undefined {
  if (policy.filesystem !== "read-only" || !FILESYSTEM_WRITE_TOOLS.has(toolName)) return undefined;
  return block(`filesystem read-only blocks ${toolName}`);
}

function integrationsGuard(policy: PstackTaskPolicy, toolName: string): GuardDecision | undefined {
  const category = capabilityForTool(toolName);
  if (!category) return undefined;
  const grants = policy.integrations;
  if (grants === "inherit") return undefined;
  if (grants === "none") return block(`integrations none excludes ${category}, needed by ${toolName}`);
  if (grants.includes(category)) return undefined;
  return block(`integrations grant [${grants.join(", ")}] excludes ${category}, needed by ${toolName}`);
}

function shellGuard(policy: PstackTaskPolicy, input: Record<string, unknown>): GuardDecision | undefined {
  if (policy.shell === "none") return block("shell none blocks bash");
  const command = typeof input.command === "string" ? input.command : "";
  const segments = bashSegments(command);
  return gitGuard(policy, segments) ?? networkGuard(policy, segments);
}

export function evaluateGuard(policy: PstackTaskPolicy, event: GuardEvent): GuardDecision | undefined {
  const filesystem = filesystemGuard(policy, event.toolName);
  if (filesystem) return filesystem;
  const integrations = integrationsGuard(policy, event.toolName);
  if (integrations) return integrations;
  return event.toolName === "bash" ? shellGuard(policy, event.input) : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse PSTACK_CHILD_POLICY defensively; never throw at registration time. */
export function parseGuardPolicy(raw: string): GuardPolicyState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { blockReason: `PSTACK_CHILD_POLICY is not valid JSON (${errorText(err)}); refusing writes` };
  }
  try {
    return { policy: normalizePolicyObject(parsed) };
  } catch (err) {
    return {
      blockReason: `PSTACK_CHILD_POLICY failed policy validation (${errorText(err)}); refusing writes`,
    };
  }
}

let activeGuard: GuardPolicyState | undefined;

export function decideGuardEvent(event: GuardEvent): GuardDecision | undefined {
  const guard = activeGuard;
  if (!guard) return undefined;
  if (guard.blockReason) {
    return UNPARSEABLE_SAFE_TOOLS.has(event.toolName) ? undefined : block(guard.blockReason);
  }
  if (!guard.policy) return undefined;
  return evaluateGuard(guard.policy, event);
}

/** No-op when PSTACK_CHILD_POLICY is absent; the parent decides whether to attach a policy. */
export function registerPolicyGuard(pi: ExtensionAPI): void {
  const raw = process.env.PSTACK_CHILD_POLICY;
  if (raw) activeGuard = parseGuardPolicy(raw);
  if (!activeGuard) return;
  pi.on("tool_call", (event: ToolCallEvent) =>
    decideGuardEvent({ toolName: event.toolName, input: event.input as Record<string, unknown> }),
  );
}

/** Unit-test seam: exercise the hook and the decision path without spawning a child. */
export function __setGuardPolicyForTests(policy: PstackTaskPolicy | null): void {
  activeGuard = policy ? { policy } : undefined;
}
