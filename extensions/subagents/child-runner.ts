/**
 * Thin Pi child-agent runner (official Pi ExtensionAPI child-process pattern).
 * Spawns `pi --mode json -p` subprocesses. No pi-subagents dependency.
 *
 * Global child concurrency is capped via withChildSlot (default 8; override
 * with PSTACK_MAX_CONCURRENCY). Output cap default 50KiB (PSTACK_MAX_OUTPUT_BYTES);
 * oversized output can be summarized to disk under .pi/pstack-child-output/.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { allowedCwdRoots, assertPathContainment } from "../lib/path-contain.ts";
import { READONLY_TOOLS, type PstackTaskPolicy } from "../agents/policy.ts";
import { resolveChildSessionDir } from "./session-dir.ts";
import { createJobRegistryCell } from "./job-registry.ts";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  appendCapped,
  parsePositiveInt,
  shouldPersistOutput,
  truncate,
} from "./output-policy.ts";

export { READONLY_TOOLS };
export { resolveChildSessionDir } from "./session-dir.ts";
export {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  persistOutputSummary,
  shouldPersistOutput,
  truncate,
} from "./output-policy.ts";

export const MAX_TASKS = 8;

/** Shared cap for all pstack child agents (spawn + swarm + arena). Env: PSTACK_MAX_CONCURRENCY (1–32). */
export const MAX_CONCURRENCY = parsePositiveInt(process.env.PSTACK_MAX_CONCURRENCY, 8, 1, 32);

/** Pi builtins that cannot mutate the tree (no bash / write / edit). Owned by policy.ts. */
export interface ChildTaskInput {
  task: string;
  model?: string | undefined;
  cwd?: string | undefined;
  role?: string | undefined;
  poteto?: boolean | undefined;
  tools?: string[] | undefined;
  timeoutMs?: number | undefined;
  skillPath?: string | undefined;
  /** When true, write full output to disk if truncated and return path in trailer. */
  persistOutput?: boolean | undefined;
  /**
   * Session mode for the child process (Pi CLI flags — exact):
   * - isolated (default): `--session-dir` under cwd/.pi/pstack-child-sessions
   *   (dedicated transcript; extensions/skills still discover — Pi has no
   *   parent MCP/session-history inheritance API; we never pass --no-extensions)
   * - ephemeral: `--no-session` (no transcript save; still discovers extensions/skills)
   * Env default override: PSTACK_CHILD_SESSION=ephemeral|isolated
   */
  sessionMode?: "ephemeral" | "isolated" | undefined;
  /**
   * Resume a prior child: reuse its `--session-dir` AND pass `--continue`/`-c`
   * so Pi calls continueRecent (not SessionManager.create). Absolute or cwd-relative.
   * Fail closed if missing/unreadable. Conflicts with sessionMode=ephemeral.
   */
  resumeSessionDir?: string | undefined;
  /**
   * Pre-resolved isolated session dir (e.g. minted by enqueueBackgroundChild).
   * Uses `--session-dir` without `--continue` (fresh create). Not a resume signal.
   */
  sessionDir?: string | undefined;
  /** Compiled multidimensional policy; forwarded to the child as PSTACK_CHILD_POLICY. */
  policy?: PstackTaskPolicy | undefined;
  /** Explicit Pi thinking level; forwarded as `--thinking <level>`. */
  thinkingLevel?: string | undefined;
}

export interface ChildTaskResult {
  task: string;
  model: string;
  role?: string | undefined;
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string | undefined;
  outputPath?: string | undefined;
  /** Child `--session-dir` when isolated/resume (for in-session resumeJobId). */
  sessionDir?: string | undefined;
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

function messageText(message: Message): string | undefined {
  if (message.role !== "assistant") return undefined;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.find((part) => part.type === "text");
  return text?.type === "text" ? text.text : undefined;
}

function finalText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i = i - 1) {
    const message = messages[i];
    if (message === undefined) continue;
    const text = messageText(message);
    if (text !== undefined) return text;
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
  sessionDir?: string | undefined;
  continueSession?: boolean | undefined;
  inheritNote: string;
  skillPath?: string | undefined;
  tools?: string[] | undefined;
  thinkingLevel?: string | undefined;
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
      const item = items[index];
      if (item === undefined) throw new Error(`mapConcurrent lost an item at index ${index}`);
      results[index] = await run(item, index);
    }
  });
  await Promise.all(workers);
  return results;
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
  stopReason?: string | undefined;
  midStreamCapped: boolean;
  aborted: boolean;
  timedOut: boolean;
  exitCode: number;
}

type ChildStream = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Every key is present on a snapshot; a value may be undefined when the stream
 * ended without the child reporting that field. Modelling it as required rather
 * than optional is what makes `stopReason: undefined` legal under
 * `exactOptionalPropertyTypes`, which distinguishes an absent key from a
 * present-but-undefined one.
 */
interface ChildStreamSnapshot {
  messages: Message[];
  stderr: string;
  stopReason: string | undefined;
  midStreamCapped: boolean;
}

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
): ChildProcessByStdio<null, Readable, Readable> {
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

function consumeChildStream(child: ChildStream): () => ChildStreamSnapshot {
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
  child: ChildStream,
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
  const cwd = assertPathContainment(input.cwd ?? defaultCwd, {
    root: defaultCwd,
    label: "child cwd",
    allowedRoots: allowedCwdRoots(defaultCwd),
  });
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
  resumeSessionDir?: string | undefined;
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
  role?: string | undefined;
  model: string;
  taskPreview: string;
  startedAt: number;
  finishedAt?: number | undefined;
  result?: ChildTaskResult | undefined;
  error?: string | undefined;
  /** Child `--session-dir` when known (in-memory; enables resumeJobId within session). */
  sessionDir?: string | undefined;
}

const registry = createJobRegistryCell<BackgroundJob>();
let backgroundSeq = 0;

export function listBackgroundJobs(): BackgroundJob[] {
  return registry.jobs().toSorted((a, b) => a.startedAt - b.startedAt);
}

export function getBackgroundJob(id: string): BackgroundJob | undefined {
  return registry.job(id);
}

export function abortBackgroundJob(id: string): BackgroundJob | undefined {
  const controller = registry.controller(id);
  const job = registry.job(id);
  if (controller) {
    controller.abort();
    registry.dropController(id);
  }
  if (job && (job.status === "queued" || job.status === "running")) {
    const abortedJob: BackgroundJob = { ...job, status: "aborted", finishedAt: Date.now() };
    registry.putJob(abortedJob);
    return abortedJob;
  }
  return job;
}

export function abortAllBackgroundJobs(): void {
  for (const id of registry.controllerIds()) {
    abortBackgroundJob(id);
  }
  registry.reset();
}

function createBackgroundJob(
  input: ChildTaskInput,
  defaultCwd: string,
  parentModel: string,
): { job: BackgroundJob; controller: AbortController; resolvedInput: ChildTaskInput } {
  backgroundSeq = backgroundSeq + 1;
  const id = `bg-${backgroundSeq}-${Date.now().toString(36)}`;
  const controller = new AbortController();
  const cwd = assertPathContainment(input.cwd ?? defaultCwd, {
    root: defaultCwd,
    label: "child cwd",
    allowedRoots: allowedCwdRoots(defaultCwd),
  });
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
  registry.putJob(runningJob);
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
  registry.putJob(job);
  registry.putController(job.id, controller);
  void runBackgroundJob(job, controller, resolvedInput, defaultCwd, parentModel)
    .then((finalJob) => {
      registry.putJob(finalJob);
      registry.dropController(job.id);
      // A throwing onComplete must not reclassify a finished job or fire twice.
      deliverBackgroundCompletion(onComplete, finalJob);
    })
    .catch((error: unknown) => {
      recordBackgroundFailure(job, error);
    });
  return job;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deliverBackgroundCompletion(
  onComplete: ((job: BackgroundJob) => void) | undefined,
  finalJob: BackgroundJob,
): void {
  try {
    onComplete?.(finalJob);
  } catch (error) {
    registry.putJob({ ...finalJob, error: `completion callback failed: ${errorMessage(error)}` });
  }
}

function recordBackgroundFailure(job: BackgroundJob, error: unknown): void {
  registry.putJob({
    ...job,
    status: "failed",
    error: errorMessage(error),
    finishedAt: Date.now(),
  });
  registry.dropController(job.id);
}

export async function awaitBackgroundJob(
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BackgroundJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = registry.job(id);
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
  registry.putJob({
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
  backgroundSeq = 0;
  activeChildren = 0;
  childWaiters = [];
}

