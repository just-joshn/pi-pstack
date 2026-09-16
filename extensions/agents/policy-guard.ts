/**
 * Runtime enforcement for a compiled PstackTaskPolicy.
 *
 * The parent compiles a policy, passes it to the child as PSTACK_CHILD_POLICY,
 * and the child's extension host registers this hook. argv is a hint; this guard
 * is the boundary, so a child cannot escalate by calling a tool the policy
 * excludes. A malformed policy fails closed instead of silently allowing writes.
 *
 * A shell command is inspected as a flat list of executions (see shell-parse.ts).
 * A construct the parser cannot decompose blocks whenever any axis it feeds is
 * restrictive, so the guard never allows an uninspected command.
 *
 * Executing a command is a capability, not a tool name. Tools that run a
 * caller-supplied command are registered in COMMAND_TOOLS and put through the
 * same parser as bash, so `shell: "none"` and `filesystem: "read-only"` gate
 * every route to a subprocess rather than only the `bash` tool.
 */
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  capabilityForTool,
  normalizePolicyObject,
  type GitPolicy,
  type PstackTaskPolicy,
} from "./policy.ts";
import {
  parseShellCommand,
  subcommandOf,
  type ShellArg,
  type ShellExecution,
  type ShellParse,
} from "./shell-parse.ts";

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

function setOf(source: string): ReadonlySet<string> {
  return new Set(source.split(/\s+/).filter((token) => token.length > 0));
}

/** Tools a child keeps when its policy could not be parsed: reads cannot mutate. */
const UNPARSEABLE_SAFE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

const GIT_READ_BLOCKED: ReadonlySet<string> = setOf(
  "push commit merge rebase cherry-pick reset checkout switch branch tag remote config apply am stash clean restore",
);

/** branch-write covers local branch mutation only; publishing and rewrites stay blocked. */
const GIT_BRANCH_WRITE_BLOCKED: ReadonlySet<string> = setOf(
  "push merge rebase cherry-pick reset tag remote config apply am stash clean restore",
);

const GIT_PUSH_BLOCKED: ReadonlySet<string> = setOf("merge");

/** Subcommands that only read the object store and the working tree. */
const GIT_TREE_READ_SUBCOMMANDS: ReadonlySet<string> = setOf(
  "log status diff show blame grep ls-files rev-parse describe cat-file ls-tree show-ref for-each-ref " +
    "shortlog name-rev merge-base rev-list symbolic-ref whatchanged show-branch version help reflog " +
    "count-objects check-ignore check-attr check-ref-format diff-tree diff-index diff-files var " +
    "verify-commit verify-tag",
);

const GIT_FETCH_SUBCOMMANDS: ReadonlySet<string> = setOf("clone fetch pull");

const GIT_VALUE_FLAGS: ReadonlySet<string> = setOf(
  "-C -c --git-dir --work-tree --namespace --exec-path --config-env",
);

const NETWORK_COMMANDS: ReadonlySet<string> = setOf("curl wget nc ncat ssh scp sftp rsync");

const PACKAGE_MANAGERS: ReadonlySet<string> = setOf("npm pnpm yarn bun pip pip3 uv");

const PACKAGE_WRITE_SUBCOMMANDS: ReadonlySet<string> = setOf(
  "install i ci add update up upgrade remove rm uninstall publish",
);

const PACKAGE_MANAGER_VALUE_FLAGS: ReadonlySet<string> = setOf(
  "-C -p -w -F --prefix --cwd --dir --workspace --filter --registry --tag",
);

const GH_READ_VERBS: ReadonlySet<string> = setOf("view list status diff search checks help version browse show");

/** Commands that mutate the filesystem whenever they run. */
const FILESYSTEM_WRITE_COMMANDS: ReadonlySet<string> = setOf(
  "rm rmdir unlink mv cp install dd truncate fallocate touch mkdir mknod mkfifo chmod chown chgrp ln tee " +
    "patch zip unzip gzip gunzip bzip2 xz tar rsync scp sftp shred mktemp cpio split csplit rename " +
    "setfacl chattr chflags",
);

/** Commands that mutate only when one of these flags is present. */
const FILESYSTEM_WRITE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  sed: setOf("-i --in-place"),
  find: setOf("-delete -exec -execdir -ok -okdir -fprint -fprint0 -fls"),
  curl: setOf("-o --output -O --remote-name"),
  wget: setOf("-O --output-document"),
  sort: setOf("-o --output"),
});

/** Commands that run caller-supplied code, so no argument table can bound what
 * they write. Read-only filesystems refuse them rather than guess.
 */
const FILESYSTEM_OPAQUE_INTERPRETERS: ReadonlySet<string> = setOf(
  "python python2 python3 node nodejs deno bun perl perl5 ruby irb php lua luajit awk gawk mawk nawk " +
    "tclsh wish rscript r julia make cargo go rustc cc gcc clang javac java dotnet mvn gradle groovy " +
    "elixir mix erl escript expect ghc cabal stack nix nix-shell busybox docker podman kubectl " +
    "terraform vim nvim vi ed ex emacs nano tsx pytest",
);

/** Package-manager subcommands that run code no argument table can bound. */
const PACKAGE_EXEC_SUBCOMMANDS: ReadonlySet<string> = setOf("exec x dlx create init run run-script");

/**
 * Tools that execute a caller-supplied command, each with the reader for its own
 * command input. A tool registered here is shell execution under a different
 * label, so the shell and filesystem axes apply to it exactly as they do to bash.
 */
const COMMAND_TOOLS: Readonly<Record<string, CommandExtractor>> = Object.freeze({
  pstack_control_cli: (input) => argvCommandLine(input.argv),
});

/** Tools that reach the network on their own, with no command line to inspect. */
const NETWORK_TOOLS: ReadonlySet<string> = setOf("pstack_control_ui");

type CommandExtraction =
  | { readonly ok: true; readonly command: string }
  | { readonly ok: false; readonly reason: string };

/** Reads one tool's caller-supplied command line, or refuses the call. */
type CommandExtractor = (input: Record<string, unknown>) => CommandExtraction;

/** POSIX single-quote escaping, so an argv element reaches the tokenizer verbatim. */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

function argvCommandLine(argv: unknown): CommandExtraction {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: "argv must be a non-empty array of strings" };
  }
  if (!argv.every((part): part is string => typeof part === "string")) {
    return { ok: false, reason: "every argv element must be a string" };
  }
  const program = argv[0];
  if (program === undefined || program === "") {
    return { ok: false, reason: "argv[0] must be a non-empty command name" };
  }
  if (argv.some((part) => part.includes("\0"))) {
    return { ok: false, reason: "argv elements must not contain a NUL byte" };
  }
  return { ok: true, command: argv.map(shellQuote).join(" ") };
}

function block(reason: string): GuardDecision {
  return { block: true, reason: `pstack policy guard: ${reason}` };
}

function gitInvocations(executions: readonly ShellExecution[]): readonly { sub?: string; dynamic: boolean }[] {
  return executions
    .filter((execution) => execution.name === "git")
    .map((execution) => subcommandOf(execution.args, GIT_VALUE_FLAGS));
}

function blockedGitSubcommands(git: GitPolicy): ReadonlySet<string> | undefined {
  if (git === "read") return GIT_READ_BLOCKED;
  if (git === "branch-write") return GIT_BRANCH_WRITE_BLOCKED;
  if (git === "push") return GIT_PUSH_BLOCKED;
  return undefined;
}

function gitGuard(policy: PstackTaskPolicy, executions: readonly ShellExecution[]): GuardDecision | undefined {
  const blocked = blockedGitSubcommands(policy.git);
  if (!blocked) return undefined;
  const invocations = gitInvocations(executions);
  if (invocations.some((invocation) => invocation.dynamic)) {
    return block(`git policy ${policy.git} cannot verify a git subcommand built from a variable`);
  }
  const hit = invocations.map((invocation) => invocation.sub).find((sub) => sub !== undefined && blocked.has(sub));
  return hit ? block(`git policy ${policy.git} blocks 'git ${hit}'`) : undefined;
}

function gitTreeGuard(policy: PstackTaskPolicy, executions: readonly ShellExecution[]): GuardDecision | undefined {
  if (policy.filesystem !== "read-only") return undefined;
  const invocations = gitInvocations(executions);
  if (invocations.some((invocation) => invocation.dynamic)) {
    return block("filesystem read-only cannot verify a git subcommand built from a variable");
  }
  const hit = invocations
    .map((invocation) => invocation.sub)
    .find((sub) => sub !== undefined && !GIT_TREE_READ_SUBCOMMANDS.has(sub));
  return hit ? block(`filesystem read-only blocks 'git ${hit}', which writes the tree or the object store`) : undefined;
}

function packageWriterFor(execution: ShellExecution): string | undefined {
  if (!PACKAGE_MANAGERS.has(execution.name)) return undefined;
  const resolved = subcommandOf(execution.args, PACKAGE_MANAGER_VALUE_FLAGS);
  if (resolved.dynamic) return `${execution.name} <variable>`;
  return resolved.sub && PACKAGE_WRITE_SUBCOMMANDS.has(resolved.sub)
    ? `${execution.name} ${resolved.sub}`
    : undefined;
}

function ghCulprit(executions: readonly ShellExecution[]): string | undefined {
  const gh = executions.find((execution) => execution.name === "gh");
  if (!gh) return undefined;
  const operands = gh.args.filter((arg) => !arg.value.startsWith("-"));
  if (operands.some((arg) => arg.dynamic)) return "gh <variable>";
  const words = operands.map((arg) => arg.value.toLowerCase());
  if (words.some((word) => GH_READ_VERBS.has(word))) return undefined;
  return `gh ${words.slice(0, 2).join(" ")}`.trim();
}

function networkCulprit(executions: readonly ShellExecution[]): string | undefined {
  const direct = executions.find((execution) => NETWORK_COMMANDS.has(execution.name));
  if (direct) return direct.name;
  const invocations = gitInvocations(executions);
  if (invocations.some((invocation) => invocation.dynamic)) return "git <variable>";
  const fetch = invocations
    .map((invocation) => invocation.sub)
    .find((sub) => sub !== undefined && GIT_FETCH_SUBCOMMANDS.has(sub));
  if (fetch) return `git ${fetch}`;
  const writer = executions.map(packageWriterFor).find((hit) => hit !== undefined);
  return writer ?? ghCulprit(executions);
}

function networkGuard(policy: PstackTaskPolicy, executions: readonly ShellExecution[]): GuardDecision | undefined {
  if (policy.network !== "none") return undefined;
  const hit = networkCulprit(executions);
  return hit ? block(`network none blocks '${hit}'`) : undefined;
}

function matchesWriteFlag(value: string, flag: string): boolean {
  if (value === flag || value.startsWith(`${flag}=`)) return true;
  return flag.length === 2 && flag.startsWith("-") && value.startsWith(flag) && value.length > 2;
}

function writeFlagCulprit(execution: ShellExecution): string | undefined {
  const flags = FILESYSTEM_WRITE_FLAGS[execution.name];
  if (!flags) return undefined;
  const hit = execution.args.find((arg) => [...flags].some((flag) => matchesWriteFlag(arg.value, flag)));
  if (hit) return `${execution.name} ${hit.value}`;
  return execution.args.some((arg) => arg.dynamic) ? `${execution.name} <variable>` : undefined;
}

function writeCulprit(execution: ShellExecution): string | undefined {
  if (FILESYSTEM_WRITE_COMMANDS.has(execution.name)) return execution.name;
  if (FILESYSTEM_OPAQUE_INTERPRETERS.has(execution.name)) return execution.name;
  return packageWriterFor(execution) ?? packageExecCulprit(execution) ?? writeFlagCulprit(execution);
}

function packageExecCulprit(execution: ShellExecution): string | undefined {
  if (!PACKAGE_MANAGERS.has(execution.name)) return undefined;
  const { sub } = subcommandOf(execution.args, PACKAGE_MANAGER_VALUE_FLAGS);
  return sub !== undefined && PACKAGE_EXEC_SUBCOMMANDS.has(sub) ? `${execution.name} ${sub}` : undefined;
}

function filesystemBashGuard(policy: PstackTaskPolicy, parse: ShellParse): GuardDecision | undefined {
  if (policy.filesystem !== "read-only") return undefined;
  const redirect = parse.redirects.find((entry) => entry.write);
  if (redirect) return block(`filesystem read-only blocks '${redirect.operator} ${redirect.target}'`);
  const hit = parse.executions.map(writeCulprit).find((culprit) => culprit !== undefined);
  if (hit) return block(`filesystem read-only blocks '${hit}'`);
  return gitTreeGuard(policy, parse.executions);
}

function filesystemToolGuard(policy: PstackTaskPolicy, toolName: string): GuardDecision | undefined {
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

/** Axes whose verdict depends on having parsed the command line. */
function parsingIsRestricted(policy: PstackTaskPolicy): boolean {
  return (
    policy.filesystem === "read-only" ||
    policy.shell === "restricted" ||
    policy.network === "none" ||
    policy.git !== "merge"
  );
}

function refusalGuard(policy: PstackTaskPolicy, parse: ShellParse): GuardDecision | undefined {
  if (parse.refusals.length === 0 || !parsingIsRestricted(policy)) return undefined;
  return block(`cannot enforce this policy on ${parse.refusals.join("; ")}`);
}

/** The axes that apply to any command line, whatever tool produced it. */
function commandGuard(policy: PstackTaskPolicy, command: string): GuardDecision | undefined {
  const parse = parseShellCommand(command);
  return (
    refusalGuard(policy, parse) ??
    filesystemBashGuard(policy, parse) ??
    gitGuard(policy, parse.executions) ??
    networkGuard(policy, parse.executions)
  );
}

function bashGuard(policy: PstackTaskPolicy, command: string): GuardDecision | undefined {
  if (policy.shell === "none") return block("shell none blocks bash");
  return commandGuard(policy, command);
}

/**
 * A registered command-executing tool is a subprocess, so any shell policy but
 * `full` refuses it outright; there is no command line a `none` policy could
 * inspect and permit.
 */
function executingToolGuard(
  policy: PstackTaskPolicy,
  toolName: string,
  input: Record<string, unknown>,
): GuardDecision | undefined {
  const extract = COMMAND_TOOLS[toolName];
  if (!extract) return undefined;
  if (policy.shell !== "full") {
    return block(`shell ${policy.shell} blocks ${toolName}, which executes a caller-supplied command`);
  }
  const extracted = extract(input);
  if (!extracted.ok) return block(`${toolName} was called with a malformed command: ${extracted.reason}`);
  return commandGuard(policy, extracted.command);
}

function networkToolGuard(policy: PstackTaskPolicy, toolName: string): GuardDecision | undefined {
  if (policy.network !== "none" || !NETWORK_TOOLS.has(toolName)) return undefined;
  return block(`network none blocks ${toolName}`);
}

export function evaluateGuard(policy: PstackTaskPolicy, event: GuardEvent): GuardDecision | undefined {
  if (event.toolName === "bash") {
    const command = event.input.command;
    if (typeof command !== "string") return block("bash tool call without a string command");
    return bashGuard(policy, command);
  }
  return (
    filesystemToolGuard(policy, event.toolName) ??
    networkToolGuard(policy, event.toolName) ??
    integrationsGuard(policy, event.toolName) ??
    executingToolGuard(policy, event.toolName, event.input)
  );
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

/**
 * No-op when PSTACK_CHILD_POLICY is absent; the parent decides whether to attach
 * a policy. An already-injected policy wins, so the test seam cannot be clobbered
 * by an inherited child policy.
 */
export function registerPolicyGuard(pi: ExtensionAPI): void {
  const raw = process.env.PSTACK_CHILD_POLICY;
  if (raw && activeGuard === undefined) activeGuard = parseGuardPolicy(raw);
  if (!activeGuard) return;
  pi.on("tool_call", (event: ToolCallEvent) =>
    decideGuardEvent({ toolName: event.toolName, input: event.input as Record<string, unknown> }),
  );
}

/** Unit-test seam: exercise the hook and the decision path without spawning a child. */
export function __setGuardPolicyForTests(policy: PstackTaskPolicy | null): void {
  activeGuard = policy ? { policy } : undefined;
}
