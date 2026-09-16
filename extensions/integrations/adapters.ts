/**
 * Executors and argv builders behind pstack_integrations.
 *
 * Availability probing and command-adapter execution live here because they
 * spawn processes; registry.ts stays pure. Every argv is built and validated
 * before it reaches exec, argv[0] is always a command name, and nothing in this
 * module prints or persists output.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execOptions } from "../lib/exec-options.ts";
import type { IntegrationEntry, IntegrationsConfig, ProbeContext } from "./registry.ts";

export interface ExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ExecOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export type ExecLike = (request: ExecRequest) => Promise<ExecOutcome>;

export const DEFAULT_ADAPTER_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

export const GIT_WORK_TREE_ARGV: readonly string[] = Object.freeze([
  "git",
  "rev-parse",
  "--is-inside-work-tree",
]);
export const GH_VERSION_ARGV: readonly string[] = Object.freeze(["gh", "--version"]);

export const GIT_LOG_FORMAT = "%H%x09%an%x09%aI%x09%s";
const MAX_LOG_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 20;

/** Reject an argv that is empty, non-string, or starts with an option. */
export function assertArgv(argv: readonly string[], where: string): readonly [string, ...string[]] {
  const head = argv[0];
  const allStrings = argv.every((entry) => typeof entry === "string" && entry.length > 0);
  if (head === undefined) throw new Error(`${where}: command argv must not be empty`);
  if (!allStrings) throw new Error(`${where}: command argv must be non-empty strings`);
  if (head.startsWith("-")) {
    throw new Error(`${where}: argv[0] must be a command name, not an option ('${head}')`);
  }
  return [head, ...argv.slice(1)];
}

export function assertSafePath(value: string, where: string): string {
  if (!value || value.startsWith("-") || value.includes("\0")) {
    throw new Error(`${where}: unsafe path '${value}'`);
  }
  return value;
}

/** Wrap pi.exec as the ExecLike shape the adapters test and call. */
export function piExec(pi: Pick<ExtensionAPI, "exec">): ExecLike {
  return async ({ command, args, cwd, timeoutMs, signal }) => {
    const result = await pi.exec(
      command,
      [...args],
      execOptions({ cwd, timeout: timeoutMs, signal }),
    );
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code };
  };
}

/** Run the configured argv with the query as a trailing argument. */
export function executeCommandAdapter(
  exec: ExecLike,
  command: readonly string[],
  query: string,
  opts: { cwd?: string | undefined; timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<ExecOutcome> {
  const argv = assertArgv(command, "command adapter");
  const head = argv[0];
  const rest = argv.slice(1);
  const args = query.length > 0 ? [...rest, query] : [...rest];
  return exec({
    command: head,
    args,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
    signal: opts.signal,
  });
}

export async function runArgv(
  exec: ExecLike,
  argv: readonly string[],
  opts: { cwd?: string | undefined; timeoutMs?: number | undefined; signal?: AbortSignal | undefined } = {},
): Promise<ExecOutcome> {
  const validated = assertArgv(argv, "source-control");
  return exec({
    command: validated[0],
    args: validated.slice(1),
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS,
    signal: opts.signal,
  });
}

function boundedLimit(limit: number | undefined): number {
  const value = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LOG_LIMIT;
  return Math.min(MAX_LOG_LIMIT, Math.max(1, value));
}

function boundedLine(line: number): number {
  if (!Number.isFinite(line)) throw new Error("git blame line must be a finite number");
  return Math.max(1, Math.trunc(line));
}

export function gitLog(
  paths: readonly string[] | undefined,
  limit: number | undefined,
  grep?: string,
): readonly string[] {
  const head = ["git", "log", `-n${boundedLimit(limit)}`, `--format=${GIT_LOG_FORMAT}`];
  const term = typeof grep === "string" ? grep.trim() : "";
  const filtered = (paths ?? []).map((path) => assertSafePath(path, "git log pathspec"));
  const base = term.length > 0 ? [...head, `--grep=${term}`] : head;
  return Object.freeze(filtered.length > 0 ? [...base, "--", ...filtered] : base);
}

export function gitBlame(file: string, line: number): readonly string[] {
  const target = assertSafePath(file, "git blame file");
  const start = boundedLine(line);
  return Object.freeze(["git", "blame", "-L", `${start},${start}`, "--porcelain", "--", target]);
}

export function ghPrSearch(query: string): readonly string[] {
  const term = query.trim();
  if (term.length === 0) throw new Error("gh PR search requires a non-empty query");
  return Object.freeze([
    "gh",
    "search",
    "prs",
    term,
    "--json",
    "number,title,state,url,author",
    "--limit",
    "20",
  ]);
}

export const SOURCE_CONTROL_MODES = ["log", "blame", "prs"] as const;
export type SourceControlMode = (typeof SOURCE_CONTROL_MODES)[number];

export interface SourceControlPlan {
  readonly mode: SourceControlMode;
  readonly requiresGh: boolean;
  readonly argv: readonly string[];
}

const BLAME_QUERY = /^blame:(.+):(\d+)$/;
const PRS_QUERY = /^prs?:(.+)$/;

/**
 * Source-control query grammar. `blame:<file>:<line>` blames one line,
 * `pr:`/`prs:<terms>` searches pull requests, and any other text is a commit
 * message search through git log. No prefix silently degrades to another mode.
 */
export function planSourceControlQuery(
  query: string,
  paths: readonly string[] | undefined,
  limit: number | undefined,
): SourceControlPlan {
  const text = query.trim();
  const blame = BLAME_QUERY.exec(text);
  if (blame) {
    const file = blame[1];
    const line = blame[2];
    if (file === undefined || line === undefined) throw new Error(`malformed blame query: ${text}`);
    return Object.freeze({ mode: "blame", requiresGh: false, argv: gitBlame(file, Number(line)) });
  }
  const prs = PRS_QUERY.exec(text);
  if (prs) {
    const term = prs[1];
    if (term === undefined) throw new Error(`malformed PR query: ${text}`);
    return Object.freeze({ mode: "prs", requiresGh: true, argv: ghPrSearch(term) });
  }
  return Object.freeze({
    mode: "log",
    requiresGh: false,
    argv: gitLog(paths, limit, text.length > 0 ? text : undefined),
  });
}

async function probeCode(exec: ExecLike, argv: readonly string[], cwd?: string): Promise<number | null> {
  try {
    const outcome = await runArgv(exec, argv, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
    return outcome.code;
  } catch {
    return null;
  }
}

export async function detectGitWorkTree(exec: ExecLike, cwd?: string): Promise<boolean> {
  try {
    const outcome = await runArgv(exec, GIT_WORK_TREE_ARGV, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
    return outcome.code === 0 && outcome.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function detectGhOnPath(exec: ExecLike): Promise<boolean> {
  return (await probeCode(exec, GH_VERSION_ARGV)) === 0;
}

export async function probeContext(
  exec: ExecLike,
  config: IntegrationsConfig,
  opts: { cwd?: string | undefined; registeredTools?: readonly string[] | undefined } = {},
): Promise<ProbeContext> {
  const gitWorkTree = await detectGitWorkTree(exec, opts.cwd);
  const ghOnPath = gitWorkTree ? await detectGhOnPath(exec) : false;
  return Object.freeze({
    gitWorkTree,
    ghOnPath,
    config,
    registeredTools: opts.registeredTools,
  });
}

/**
 * Probe only the facts one entry needs. list/status/probe gather all nine
 * categories at once; a single query gathers just its own prerequisite, so a
 * configured command adapter or a builtin-tool delegation spawns nothing.
 */
export async function probeForEntry(
  entry: IntegrationEntry,
  exec: ExecLike,
  config: IntegrationsConfig,
  opts: { cwd?: string | undefined; registeredTools?: readonly string[] | undefined } = {},
): Promise<ProbeContext> {
  const needsSourceControl = entry.probeSpec.kind === "source-control";
  const gitWorkTree = needsSourceControl ? await detectGitWorkTree(exec, opts.cwd) : false;
  const ghOnPath = needsSourceControl && gitWorkTree ? await detectGhOnPath(exec) : false;
  return Object.freeze({ gitWorkTree, ghOnPath, config, registeredTools: opts.registeredTools });
}
