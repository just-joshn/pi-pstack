/**
 * Thin Pi child-agent runner (official Pi ExtensionAPI child-process pattern).
 * Spawns `pi --mode json -p` subprocesses. No pi-subagents dependency.
 *
 * Global child concurrency is capped via withChildSlot (default 8; override
 * with PSTACK_MAX_CONCURRENCY). Output cap default 50KiB (PSTACK_MAX_OUTPUT_BYTES);
 * oversized output can be summarized to disk under .pi/pstack-child-output/.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, DEFAULT_MAX_LINES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { READONLY_TOOLS, type PstackTaskPolicy } from "../agents/policy.ts";
import { resolveChildSessionDir } from "./session-dir.ts";

export { READONLY_TOOLS };
export { resolveChildSessionDir } from "./session-dir.ts";

export const MAX_TASKS = 8;

function parsePositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Shared cap for all pstack child agents (spawn + swarm + arena). Env: PSTACK_MAX_CONCURRENCY (1–32). */
export const MAX_CONCURRENCY = parsePositiveInt(process.env.PSTACK_MAX_CONCURRENCY, 8, 1, 32);

/** Default output cap. Env: PSTACK_MAX_OUTPUT_BYTES (4KiB–2MiB). */
export const MAX_OUTPUT_BYTES = parsePositiveInt(
  process.env.PSTACK_MAX_OUTPUT_BYTES,
  50 * 1024,
  4 * 1024,
  2 * 1024 * 1024,
);

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** Pi builtins that cannot mutate the tree (no bash / write / edit). Owned by policy.ts. */
export interface ChildTaskInput {
  task: string;
  model?: string;
  cwd?: string;
  role?: string;
  poteto?: boolean;
  tools?: string[];
  timeoutMs?: number;
  skillPath?: string;
  /** When true, write full output to disk if truncated and return path in trailer. */
  persistOutput?: boolean;
  /**
   * Session mode for the child process (Pi CLI flags — exact):
   * - isolated (default): `--session-dir` under cwd/.pi/pstack-child-sessions
   *   (dedicated transcript; extensions/skills still discover — Pi has no
   *   parent MCP/session-history inheritance API; we never pass --no-extensions)
   * - ephemeral: `--no-session` (no transcript save; still discovers extensions/skills)
   * Env default override: PSTACK_CHILD_SESSION=ephemeral|isolated
   */
  sessionMode?: "ephemeral" | "isolated";
  /**
   * Resume a prior child: reuse its `--session-dir` AND pass `--continue`/`-c`
   * so Pi calls continueRecent (not SessionManager.create). Absolute or cwd-relative.
   * Fail closed if missing/unreadable. Conflicts with sessionMode=ephemeral.
   */
  resumeSessionDir?: string;
  /**
   * Pre-resolved isolated session dir (e.g. minted by enqueueBackgroundChild).
   * Uses `--session-dir` without `--continue` (fresh create). Not a resume signal.
   */
  sessionDir?: string;
  /** Compiled multidimensional policy; forwarded to the child as PSTACK_CHILD_POLICY. */
  policy?: PstackTaskPolicy;
  /** Explicit Pi thinking level; forwarded as `--thinking <level>`. */
  thinkingLevel?: string;
}

export interface ChildTaskResult {
  task: string;
  model: string;
  role?: string;
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string;
  outputPath?: string;
  /** Child `--session-dir` when isolated/resume (for in-session resumeJobId). */
  sessionDir?: string;
}

let activeChildren = 0;
let childWaiters: Array<() => void> = [];

export function childConcurrencyStats(): { active: number; cap: number; waiting: number } {
  return { active: activeChildren, cap: MAX_CONCURRENCY, waiting: childWaiters.length };
}

export async function withChildSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeChildren >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => {
      childWaiters = [...childWaiters, resolve];
    });
  }
  activeChildren = activeChildren + 1;
  try {
    return await run();
  } finally {
    activeChildren = activeChildren - 1;
    const [next, ...rest] = childWaiters;
    childWaiters = rest;
    if (next) next();
  }
}

export function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [script, ...args] };
  }
  return { command: "pi", args };
}

function finalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i = i - 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.content.find((part) => part.type === "text");
    if (text?.type === "text") return text.text;
  }
  return "";
}

/**
 * Build pi child argv. Resume MUST include --continue|-c with --session-dir.
 * Fresh isolated: --session-dir only (create OK). Never -r/--resume for -p children.
 */
export function buildChildPiArgs(opts: {
  selectedModel: string;
  sessionMode: "ephemeral" | "isolated";
  sessionDir?: string;
  continueSession?: boolean;
  inheritNote: string;
  skillPath?: string;
  tools?: string[];
  thinkingLevel?: string;
  prompt: string;
}): string[] {
  const base = ["--mode", "json", "-p", "--model", opts.selectedModel];
  const sessionArgs =
    opts.sessionMode === "ephemeral"
      ? ["--no-session"]
      : (() => {
          if (!opts.sessionDir) {
            throw new Error("internal: isolated child missing sessionDir");
          }
          return opts.continueSession
            ? ["--session-dir", opts.sessionDir, "--continue"]
            : ["--session-dir", opts.sessionDir];
        })();
  const systemPromptArgs = ["--append-system-prompt", opts.inheritNote];
  const skillArgs = opts.skillPath ? ["--skill", opts.skillPath] : [];
  const toolsArgs = opts.tools?.length ? ["--tools", opts.tools.join(",")] : [];
  const thinkingArgs = opts.thinkingLevel ? ["--thinking", opts.thinkingLevel] : [];
  return [...base, ...sessionArgs, ...systemPromptArgs, ...skillArgs, ...toolsArgs, ...thinkingArgs, opts.prompt];
}

/** True if argv has continue semantics (not dir-only / not interactive -r). */
export function argvHasContinueSemantics(args: string[]): boolean {
  return args.includes("--continue") || args.includes("-c");
}

/** True if argv is the forbidden dir-only resume shape (session-dir without continue/session open). */
export function argvIsDirOnlyResume(args: string[]): boolean {
  const hasSessionDir = args.includes("--session-dir");
  const hasContinue = argvHasContinueSemantics(args);
  const hasSessionOpen = args.includes("--session") || args.includes("--session-id");
  const hasInteractiveResume = args.includes("--resume") || args.includes("-r");
  return hasSessionDir && !hasContinue && !hasSessionOpen && !hasInteractiveResume;
}

/**
 * Persist full text under outDir; return path.
 * Same collision hazard as mintChildSessionDir: two children sharing a role
 * (a common parallel-spawn pattern) finish in the same millisecond and would
 * mint the same `${tag}-${timestamp}.txt`, so a plain write would silently
 * clobber the first child's persisted output. Write exclusively (`wx`) and
 * retry on EEXIST instead of overwriting.
 */
export function persistOutputSummary(fullText: string, outDir: string, tag: string): string {
  mkdirSync(outDir, { recursive: true });
  const safe = tag.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "child";
  let attempt = 0;
  while (attempt < 20) {
    const path = join(outDir, `${safe}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.txt`);
    try {
      writeFileSync(path, fullText, { encoding: "utf8", flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        attempt = attempt + 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`failed to mint a unique output path under ${outDir} after 20 attempts`);
}

export function truncate(
  text: string,
  opts?: { maxBytes?: number; persistDir?: string; tag?: string },
): { text: string; outputPath?: string } {
  const max = opts?.maxBytes ?? MAX_OUTPUT_BYTES;
  const truncation = truncateHead(text, { maxBytes: max, maxLines: DEFAULT_MAX_LINES });
  if (!truncation.truncated) return { text };
  // truncateHead drops a first line longer than the byte cap entirely; fall back
  // to truncateLine so a single-line child answer still yields a visible snippet.
  const content = truncation.firstLineExceedsLimit
    ? truncateLine(text, max).text
    : truncation.content;
  let outputPath: string | undefined;
  if (opts?.persistDir) {
    try {
      outputPath = persistOutputSummary(text, opts.persistDir, opts.tag ?? "out");
    } catch {
      /* ignore disk errors; still truncate and return path-less result */
      outputPath = undefined;
    }
  }
  const outputLines = truncation.firstLineExceedsLimit
    ? Math.max(1, truncation.outputLines)
    : truncation.outputLines;
  const counts = `${outputLines} of ${truncation.totalLines} lines (${formatSize(Buffer.byteLength(content, "utf8"))} of ${formatSize(truncation.totalBytes)})`;
  const trailer = outputPath
    ? `\n\n[Output truncated: ${counts}. Full output: ${outputPath}]`
    : `\n\n[Output truncated: ${counts}. Set persistOutput:true or PSTACK_PERSIST_OUTPUT=1 to save full text under .pi/pstack-child-output/.]`;
  return { text: `${content}${trailer}`, outputPath };
}

function appendCapped(current: string, chunk: string, max = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(current, "utf8") >= max) return current;
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= max) return next;
  return truncate(next, { maxBytes: max }).text;
}

export async function mapConcurrent<T, U>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next = next + 1;
      results[index] = await run(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}


/** Persist full output when explicitly requested, env on, or long-running child (timeout >= 5m). Default-on for long children. */
export function shouldPersistOutput(input: ChildTaskInput): boolean {
  if (input.persistOutput === true) return true;
  if (input.persistOutput === false) return false;
  const env = process.env.PSTACK_PERSIST_OUTPUT;
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return timeout >= 5 * 60 * 1000;
}

export async function runChildTask(
  input: ChildTaskInput,
  defaultCwd: string,
  parentModel: string,
  signal: AbortSignal | undefined,
): Promise<ChildTaskResult> {
  return withChildSlot(() => runChildTaskUnlocked(input, defaultCwd, parentModel, signal));
}

interface ChildRunOutcome {
  messages: Message[];
  stderr: string;
  stopReason?: string;
  midStreamCapped: boolean;
  aborted: boolean;
  timedOut: boolean;
  exitCode: number;
}

type ChildStreamSnapshot = Pick<ChildRunOutcome, "messages" | "stderr" | "stopReason" | "midStreamCapped">;
type ChildLifecycleOutcome = Pick<ChildRunOutcome, "aborted" | "timedOut">;

function buildChildPrompt(input: ChildTaskInput): string {
  if (input.role === "poteto-agent" || input.poteto) return `/skill:poteto-mode ${input.task}`;
  if (input.role === "comment-sicko") {
    return [
      "You are Comment Sicko. Follow agents/comment-sicko.md rules.",
      "First output exactly: Yes... Ha ha ha... Yes!",
      "You are readonly: report only; do not write, edit, or run bash.",
      input.task,
    ].join("\n\n");
  }
  if (input.role === "investigator") {
    return [
      "You are a read-only investigator. Do not write, edit, or mutate the tree.",
      "Cite files and evidence. Return findings only.",
      input.task,
    ].join("\n\n");
  }
  return input.task;
}

function spawnChildProcess(
  args: string[],
  cwd: string,
  parentModel: string,
  role: string | undefined,
  policy: PstackTaskPolicy | undefined,
): ChildProcessWithoutNullStreams {
  const invocation = piInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PSTACK_PARENT_MODEL: parentModel,
      PSTACK_CHILD_ROLE: role ?? "general",
      ...(policy ? { PSTACK_CHILD_POLICY: JSON.stringify(policy) } : {}),
    },
  });
}

function consumeChildStream(child: ChildProcessWithoutNullStreams): () => ChildStreamSnapshot {
  let messages: Message[] = [];
  let stderr = "";
  let stopReason: string | undefined;
  let buffer = "";
  let midStreamCapped = false;
  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as { type?: string; message?: Message };
      if (event.type === "message_end" && event.message) {
        messages = [...messages, event.message];
        if (event.message.role === "assistant") {
          stopReason = (event.message as { stopReason?: string }).stopReason;
        }
      }
    } catch {
      return;
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    if (Buffer.byteLength(buffer, "utf8") >= MAX_OUTPUT_BYTES * 2) {
      midStreamCapped = true;
      const nl = text.lastIndexOf("\n");
      if (nl >= 0) {
        for (const line of text.slice(0, nl).split("\n")) processLine(line);
        buffer = text.slice(nl + 1).slice(-1024);
      }
      return;
    }
    const combined = buffer + text;
    const lines = combined.split("\n");
    buffer = lines[lines.length - 1] ?? "";
    for (const line of lines.slice(0, -1)) processLine(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const before = stderr.length;
    stderr = appendCapped(stderr, chunk.toString());
    if (stderr.length === before && chunk.length > 0) midStreamCapped = true;
  });
  return () => {
    if (buffer.trim()) processLine(buffer);
    return { messages, stderr, stopReason, midStreamCapped };
  };
}

function armChildLifecycle(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): () => ChildLifecycleOutcome {
  let aborted = false;
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const stopChild = (reason: "aborted" | "timeout") => {
    if (reason === "aborted") aborted = true;
    else timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKillTimer.unref();
  };
  const abort = () => stopChild("aborted");
  const timeoutId = setTimeout(() => stopChild("timeout"), timeoutMs);
  timeoutId.unref();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return () => {
    clearTimeout(timeoutId);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    signal?.removeEventListener("abort", abort);
    return { aborted, timedOut };
  };
}

function finalizeChildResult(
  input: ChildTaskInput,
  selectedModel: string,
  sessionDir: string | undefined,
  outcome: ChildRunOutcome,
  cwd: string,
): ChildTaskResult {
  const persist = shouldPersistOutput(input);
  const persistDir = persist ? join(cwd, CONFIG_DIR_NAME, "pstack-child-output") : undefined;
  const fullOut = finalText(outcome.messages) || outcome.stderr || (outcome.timedOut ? "(timed out)" : "(no output)");
  const truncated = truncate(fullOut, {
    persistDir,
    tag: `${input.role ?? "general"}-${selectedModel.replace(/\//g, "_")}`,
  });
  const output =
    outcome.midStreamCapped && !truncated.text.includes("[Output truncated")
      ? `${truncated.text}\n\n[Mid-stream output capped at ${MAX_OUTPUT_BYTES} bytes.]`
      : truncated.text;
  const stderrTrunc = truncate(outcome.stderr, { persistDir: undefined });
  return {
    task: input.task,
    model: selectedModel,
    role: input.role,
    exitCode: outcome.timedOut ? 124 : outcome.aborted ? 130 : outcome.exitCode,
    output,
    stderr: stderrTrunc.text,
    stopReason: outcome.timedOut ? "timeout" : outcome.aborted ? "aborted" : outcome.stopReason,
    outputPath: truncated.outputPath,
    sessionDir,
  };
}

async function runChildTaskUnlocked(
  input: ChildTaskInput,
  defaultCwd: string,
  parentModel: string,
  signal: AbortSignal | undefined,
): Promise<ChildTaskResult> {
  const selectedModel =
    !input.model || input.model === "auto" || input.model === "inherit-parent"
      ? parentModel
      : input.model;
  const cwd = input.cwd ?? defaultCwd;
  const prepared = resolveChildSessionDir(input, cwd);
  // Children still discover extensions/skills from package + project (not --no-extensions).
  // Append a short inheritance note so the child knows parent role expectations.
  const inheritNote = [
    `pstack child: role=${input.role ?? "general"} sessionMode=${prepared.sessionMode}.`,
    "Extensions/skills discover from Pi defaults; conversation history is not inherited.",
    input.tools?.length ? `Tool allowlist: ${input.tools.join(",")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const args = buildChildPiArgs({
    selectedModel,
    sessionMode: prepared.sessionMode,
    sessionDir: prepared.sessionDir,
    continueSession: prepared.continueSession,
    inheritNote,
    skillPath: input.skillPath,
    tools: input.tools,
    thinkingLevel: input.thinkingLevel,
    prompt: buildChildPrompt(input),
  });
  const child = spawnChildProcess(args, cwd, parentModel, input.role, input.policy);
  const finishStream = consumeChildStream(child);
  const disposeLifecycle = armChildLifecycle(child, input.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
  const exitCode = await new Promise<number>((complete) => {
    child.on("error", () => complete(1));
    child.on("close", (code) => complete(code ?? 1));
  });
  const lifecycle = disposeLifecycle();
  const stream = finishStream();
  const outcome: ChildRunOutcome = { ...stream, ...lifecycle, exitCode };
  return finalizeChildResult(input, selectedModel, prepared.sessionDir, outcome, cwd);
}

/** Roles that always get the readonly tool allowlist (no bash/write/edit). */
export const AUTO_READONLY_ROLES = new Set(["comment-sicko", "investigator"]);

/**
 * Explicit `background` wins in both directions. Otherwise the `poteto-agent`
 * role (or the `poteto` flag) detaches by default, mirroring
 * `agents/poteto-agent.md`'s `is_background: true`. Every other role
 * (general, comment-sicko, investigator, ...) is synchronous by default,
 * matching upstream `Task` calls with no `run_in_background`.
 */
export function wantsBackground(background?: boolean, poteto?: boolean): boolean {
  if (background !== undefined) return background;
  return poteto === true;
}

/**
 * Tool allowlist resolution (Cap2 inherit default-on):
 * tools? → use tools
 * else if readonly / auto-readonly role → READONLY_TOOLS
 * else if inheritParentTools !== false and parentTools non-empty → inherit
 * else → undefined (child full default discovery)
 */
export function resolveTools(
  role: string,
  params: { tools?: string[]; readonly?: boolean; inheritParentTools?: boolean },
  parentTools?: string[],
): string[] | undefined {
  if (params.tools?.length) return params.tools;
  if (params.readonly === true || AUTO_READONLY_ROLES.has(role)) {
    return [...READONLY_TOOLS];
  }
  if (params.inheritParentTools !== false && parentTools?.length) {
    return [...parentTools];
  }
  return undefined;
}

/** Resolve resumeSessionDir from explicit path and/or in-memory resumeJobId. Fail closed. */
export function resolveResumeSessionDirParam(params: {
  resumeSessionDir?: string;
  resumeJobId?: string;
  sessionMode?: string;
}): string | undefined {
  let resumeSessionDir = params.resumeSessionDir;
  if (!resumeSessionDir && params.resumeJobId) {
    const job = getBackgroundJob(params.resumeJobId);
    if (!job) {
      throw new Error(
        `resumeJobId unknown: ${params.resumeJobId}. Spawn fresh with a consolidated brief, or pass resumeSessionDir if the child session path is known.`,
      );
    }
    if (!job.sessionDir) {
      throw new Error(
        `resumeJobId ${params.resumeJobId} has no recorded sessionDir (ephemeral or not yet known). Pass resumeSessionDir or spawn fresh with a consolidated brief.`,
      );
    }
    resumeSessionDir = job.sessionDir;
  }
  if (resumeSessionDir && params.sessionMode === "ephemeral") {
    throw new Error(
      "resumeSessionDir/resumeJobId conflicts with sessionMode=ephemeral; omit ephemeral to resume",
    );
  }
  return resumeSessionDir;
}

/** In-process background job registry (session-scoped; survives follow-ups until session_shutdown). */
export type BackgroundJobStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface BackgroundJob {
  id: string;
  status: BackgroundJobStatus;
  role?: string;
  model: string;
  taskPreview: string;
  startedAt: number;
  finishedAt?: number;
  result?: ChildTaskResult;
  error?: string;
  /** Child `--session-dir` when known (in-memory; enables resumeJobId within session). */
  sessionDir?: string;
}

const backgroundJobs = new Map<string, BackgroundJob>();
const backgroundControllers = new Map<string, AbortController>();
let backgroundSeq = 0;

export function listBackgroundJobs(): BackgroundJob[] {
  return [...backgroundJobs.values()].toSorted((a, b) => a.startedAt - b.startedAt);
}

export function getBackgroundJob(id: string): BackgroundJob | undefined {
  return backgroundJobs.get(id);
}

export function abortBackgroundJob(id: string): BackgroundJob | undefined {
  const controller = backgroundControllers.get(id);
  const job = backgroundJobs.get(id);
  if (controller) {
    controller.abort();
    backgroundControllers.delete(id);
  }
  if (job && (job.status === "queued" || job.status === "running")) {
    const abortedJob = { ...job, status: "aborted" as const, finishedAt: Date.now() };
    backgroundJobs.set(id, abortedJob);
    return abortedJob;
  }
  return job;
}

export function abortAllBackgroundJobs(): void {
  for (const id of [...backgroundControllers.keys()]) {
    abortBackgroundJob(id);
  }
  backgroundJobs.clear();
  backgroundControllers.clear();
}

function createBackgroundJob(
  input: ChildTaskInput,
  defaultCwd: string,
  parentModel: string,
): { job: BackgroundJob; controller: AbortController; resolvedInput: ChildTaskInput } {
  backgroundSeq = backgroundSeq + 1;
  const id = `bg-${backgroundSeq}-${Date.now().toString(36)}`;
  const controller = new AbortController();
  const cwd = input.cwd ?? defaultCwd;
  // Resolve session dir synchronously so resumeJobId can see it while the job runs.
  // Fresh mint → pass sessionDir (no continue). True resume → keep resumeSessionDir (adds -c).
  const prepared = resolveChildSessionDir(input, cwd);
  const resolvedInput: ChildTaskInput = prepared.continueSession
    ? { ...input, sessionMode: prepared.sessionMode, resumeSessionDir: prepared.sessionDir, sessionDir: undefined }
    : { ...input, sessionMode: prepared.sessionMode, resumeSessionDir: undefined, sessionDir: prepared.sessionDir };
  const job: BackgroundJob = {
    id,
    status: "queued",
    role: input.role,
    model:
      !input.model || input.model === "auto" || input.model === "inherit-parent"
        ? parentModel
        : input.model,
    taskPreview: input.task.slice(0, 200),
    startedAt: Date.now(),
    sessionDir: prepared.sessionDir,
  };
  return { job, controller, resolvedInput };
}

async function runBackgroundJob(
  job: BackgroundJob,
  controller: AbortController,
  resolvedInput: ChildTaskInput,
  defaultCwd: string,
  parentModel: string,
): Promise<BackgroundJob> {
  const runningJob = { ...job, status: "running" as const };
  backgroundJobs.set(job.id, runningJob);
  try {
    const result = await runChildTask(resolvedInput, defaultCwd, parentModel, controller.signal);
    const finalStatus = controller.signal.aborted
      ? "aborted"
      : result.exitCode === 0
        ? "done"
        : "failed";
    return {
      ...runningJob,
      result,
      sessionDir: result.sessionDir ?? runningJob.sessionDir,
      status: finalStatus as BackgroundJobStatus,
      finishedAt: Date.now(),
    };
  } catch (err) {
    return {
      ...runningJob,
      status: (controller.signal.aborted ? "aborted" : "failed") as BackgroundJobStatus,
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
    };
  }
}

/**
 * Detach a child: returns immediately with a job id; completion is async.
 * Uses an independent AbortController (not the parent tool signal) so the
 * child survives the spawn tool returning. Still respects MAX_CONCURRENCY.
 * Job records remain queryable via pstack_jobs for the rest of the session
 * (including after follow-up completion messages).
 */
export function enqueueBackgroundChild(
  input: ChildTaskInput,
  defaultCwd: string,
  parentModel: string,
  onComplete?: (job: BackgroundJob) => void,
): BackgroundJob {
  const { job, controller, resolvedInput } = createBackgroundJob(input, defaultCwd, parentModel);
  backgroundJobs.set(job.id, job);
  backgroundControllers.set(job.id, controller);
  void runBackgroundJob(job, controller, resolvedInput, defaultCwd, parentModel).then((finalJob) => {
    backgroundJobs.set(job.id, finalJob);
    backgroundControllers.delete(job.id);
    // A throwing onComplete must not reclassify a finished job or fire twice.
    onComplete?.(finalJob);
  });
  return job;
}

export async function awaitBackgroundJob(
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BackgroundJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = backgroundJobs.get(id);
    if (!job) throw new Error(`unknown background job: ${id}`);
    if (job.status === "done" || job.status === "failed" || job.status === "aborted") return job;
    if (Date.now() >= deadline) throw new Error(`await timed out for job ${id}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}


/** Test helper: seed a job record (for resumeJobId unit tests). */
export function __seedBackgroundJobForTests(
  job: Pick<BackgroundJob, "id" | "sessionDir"> & Partial<BackgroundJob>,
): void {
  backgroundJobs.set(job.id, {
    id: job.id,
    status: job.status ?? "done",
    role: job.role,
    model: job.model ?? "test/model",
    taskPreview: job.taskPreview ?? "",
    startedAt: job.startedAt ?? Date.now(),
    finishedAt: job.finishedAt ?? Date.now(),
    sessionDir: job.sessionDir,
    result: job.result,
    error: job.error,
  });
}

/** Test helper: reset in-process job registry. */
export function __resetBackgroundJobsForTests(): void {
  abortAllBackgroundJobs();
  backgroundJobs.clear();
  backgroundControllers.clear();
  backgroundSeq = 0;
  activeChildren = 0;
  childWaiters = [];
}

