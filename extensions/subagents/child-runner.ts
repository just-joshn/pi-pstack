/**
 * Thin Pi child-agent runner (official Pi ExtensionAPI child-process pattern).
 * Spawns `pi --mode json -p` subprocesses. No pi-subagents dependency.
 *
 * Global child concurrency is capped via withChildSlot (default 8; override
 * with PSTACK_MAX_CONCURRENCY). Output cap default 50KiB (PSTACK_MAX_OUTPUT_BYTES);
 * oversized output can be summarized to disk under .pi/pstack-child-output/.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";

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

/** Pi builtins that cannot mutate the tree (no bash / write / edit). */
export const READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

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
const childWaiters: Array<() => void> = [];

export function childConcurrencyStats(): { active: number; cap: number; waiting: number } {
  return { active: activeChildren, cap: MAX_CONCURRENCY, waiting: childWaiters.length };
}

export async function withChildSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeChildren >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => childWaiters.push(resolve));
  }
  activeChildren++;
  try {
    return await run();
  } finally {
    activeChildren--;
    const next = childWaiters.shift();
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = message.content.find((part) => part.type === "text");
    if (text?.type === "text") return text.text;
  }
  return "";
}

function resolveSessionMode(input: ChildTaskInput): "ephemeral" | "isolated" {
  if (input.sessionMode === "ephemeral" || input.sessionMode === "isolated") return input.sessionMode;
  const env = process.env.PSTACK_CHILD_SESSION;
  if (env === "isolated" || env === "ephemeral") return env;
  // Prefer isolated: preserves tools/MCP discovery via normal Pi package load
  // (no --no-extensions) + dedicated --session-dir. Pi CLI cannot inherit parent
  // MCP bindings or conversation history into children.
  return "isolated";
}

/**
 * Resolve child session dir for isolated/resume paths.
 * Resume fails closed if path missing; resume+ephemeral is rejected.
 * Mint creates under cwd/.pi/pstack-child-sessions when not resuming.
 * `continueSession` is true only for true resume (resumeSessionDir) — argv must add -c/--continue.
 */
export function resolveChildSessionDir(
  input: ChildTaskInput,
  cwd: string,
): { sessionMode: "ephemeral" | "isolated"; sessionDir?: string; continueSession: boolean } {
  const sessionMode = resolveSessionMode(input);
  if (input.resumeSessionDir) {
    if (sessionMode === "ephemeral") {
      throw new Error(
        "resumeSessionDir conflicts with sessionMode=ephemeral; omit ephemeral to resume, or spawn fresh without resume",
      );
    }
    const sessionDir = isAbsolute(input.resumeSessionDir)
      ? input.resumeSessionDir
      : resolve(cwd, input.resumeSessionDir);
    if (!existsSync(sessionDir)) {
      throw new Error(`resumeSessionDir missing or unreadable: ${sessionDir}`);
    }
    try {
      if (!statSync(sessionDir).isDirectory()) {
        throw new Error(`resumeSessionDir is not a directory: ${sessionDir}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("resumeSessionDir")) throw err;
      throw new Error(`resumeSessionDir missing or unreadable: ${sessionDir}`);
    }
    return { sessionMode: "isolated", sessionDir, continueSession: true };
  }
  if (sessionMode === "ephemeral") return { sessionMode, continueSession: false };
  // Pre-resolved mint (enqueue): reuse dir without continue semantics.
  if (input.sessionDir) {
    const sessionDir = isAbsolute(input.sessionDir) ? input.sessionDir : resolve(cwd, input.sessionDir);
    return { sessionMode, sessionDir, continueSession: false };
  }
  const sessionDir = join(cwd, ".pi", "pstack-child-sessions", `c-${Date.now().toString(36)}`);
  mkdirSync(sessionDir, { recursive: true });
  return { sessionMode, sessionDir, continueSession: false };
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
  prompt: string;
}): string[] {
  const args = ["--mode", "json", "-p", "--model", opts.selectedModel];
  if (opts.sessionMode === "ephemeral") {
    args.push("--no-session");
  } else {
    if (!opts.sessionDir) {
      throw new Error("internal: isolated child missing sessionDir");
    }
    args.push("--session-dir", opts.sessionDir);
    if (opts.continueSession) {
      // Pi 0.85.1: parsed.continue → SessionManager.continueRecent(cwd, sessionDir)
      args.push("--continue");
    }
  }
  args.push("--append-system-prompt", opts.inheritNote);
  if (opts.skillPath) args.push("--skill", opts.skillPath);
  if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
  args.push(opts.prompt);
  return args;
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

/** Persist full text under outDir; return path. */
export function persistOutputSummary(fullText: string, outDir: string, tag: string): string {
  mkdirSync(outDir, { recursive: true });
  const safe = tag.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "child";
  const path = join(outDir, `${safe}-${Date.now().toString(36)}.txt`);
  writeFileSync(path, fullText, "utf8");
  return path;
}

export function truncate(
  text: string,
  opts?: { maxBytes?: number; persistDir?: string; tag?: string },
): { text: string; outputPath?: string } {
  const max = opts?.maxBytes ?? MAX_OUTPUT_BYTES;
  if (Buffer.byteLength(text, "utf8") <= max) return { text };
  let outputPath: string | undefined;
  if (opts?.persistDir) {
    try {
      outputPath = persistOutputSummary(text, opts.persistDir, opts.tag ?? "out");
    } catch {
      /* ignore disk errors; still truncate */
    }
  }
  let content = text.slice(0, max);
  while (Buffer.byteLength(content, "utf8") > max) content = content.slice(0, -1);
  const trailer = outputPath
    ? `\n\n[Output truncated to ${max} bytes. Full output: ${outputPath}]`
    : `\n\n[Output truncated to ${max} bytes. Set persistOutput:true or PSTACK_PERSIST_OUTPUT=1 to save full text under .pi/pstack-child-output/.]`;
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
      const index = next++;
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
  const sessionMode = prepared.sessionMode;
  const sessionDir = prepared.sessionDir;
  const continueSession = prepared.continueSession;

  // Children still discover extensions/skills from package + project (not --no-extensions).
  // Append a short inheritance note so the child knows parent role expectations.
  const inheritNote = [
    `pstack child: role=${input.role ?? "general"} sessionMode=${sessionMode}.`,
    "Extensions/skills discover from Pi defaults; conversation history is not inherited.",
    input.tools?.length ? `Tool allowlist: ${input.tools.join(",")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  let prompt = input.task;
  if (input.role === "poteto-agent" || input.poteto) {
    prompt = `/skill:poteto-mode ${input.task}`;
  } else if (input.role === "comment-sicko") {
    prompt = [
      "You are Comment Sicko. Follow agents/comment-sicko.md rules.",
      "First output exactly: Yes... Ha ha ha... Yes!",
      "You are readonly: report only; do not write, edit, or run bash.",
      input.task,
    ].join("\n\n");
  } else if (input.role === "investigator") {
    prompt = [
      "You are a read-only investigator. Do not write, edit, or mutate the tree.",
      "Cite files and evidence. Return findings only.",
      input.task,
    ].join("\n\n");
  }

  const args = buildChildPiArgs({
    selectedModel,
    sessionMode,
    sessionDir,
    continueSession,
    inheritNote,
    skillPath: input.skillPath,
    tools: input.tools,
    prompt,
  });

  const messages: Message[] = [];
  let stderr = "";
  let stopReason: string | undefined;
  let buffer = "";
  let aborted = false;
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  let midStreamCapped = false;
  const invocation = piInvocation(args);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PSTACK_PARENT_MODEL: parentModel,
      PSTACK_CHILD_ROLE: input.role ?? "general",
    },
  });

  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as { type?: string; message?: Message };
      if (event.type === "message_end" && event.message) {
        messages.push(event.message);
        if (event.message.role === "assistant") {
          stopReason = (event.message as { stopReason?: string }).stopReason;
        }
      }
    } catch {
      /* ignore non-JSON diagnostics */
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
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const before = stderr.length;
    stderr = appendCapped(stderr, chunk.toString());
    if (stderr.length === before && chunk.length > 0) midStreamCapped = true;
  });

  const stopChild = (reason: "aborted" | "timeout") => {
    if (reason === "aborted") aborted = true;
    else timedOut = true;
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    forceKillTimer.unref();
  };
  const abort = () => stopChild("aborted");
  const timeoutId = setTimeout(() => stopChild("timeout"), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeoutId.unref();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  const exitCode = await new Promise<number>((complete) => {
    child.on("error", () => complete(1));
    child.on("close", (code) => complete(code ?? 1));
  });
  clearTimeout(timeoutId);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  signal?.removeEventListener("abort", abort);
  if (buffer.trim()) processLine(buffer);

  const persist = shouldPersistOutput(input);
  const persistDir = persist ? join(cwd, ".pi", "pstack-child-output") : undefined;

  const fullOut = finalText(messages) || stderr || (timedOut ? "(timed out)" : "(no output)");
  const truncated = truncate(fullOut, {
    persistDir,
    tag: `${input.role ?? "general"}-${selectedModel.replace(/\//g, "_")}`,
  });
  let output = truncated.text;
  if (midStreamCapped && !output.includes("[Output truncated")) {
    output = `${output}\n\n[Mid-stream output capped at ${MAX_OUTPUT_BYTES} bytes.]`;
  }

  const stderrTrunc = truncate(stderr, { persistDir: undefined });

  return {
    task: input.task,
    model: selectedModel,
    role: input.role,
    exitCode: timedOut ? 124 : aborted ? 130 : exitCode,
    output,
    stderr: stderrTrunc.text,
    stopReason: timedOut ? "timeout" : aborted ? "aborted" : stopReason,
    outputPath: truncated.outputPath,
    sessionDir,
  };
}

/** Roles that always get the readonly tool allowlist (no bash/write/edit). */
export const AUTO_READONLY_ROLES = new Set(["comment-sicko", "investigator"]);

/** Omit/undefined → background (detach); explicit false → sync-await. */
export function wantsBackground(background?: boolean): boolean {
  return background !== false;
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
  return [...backgroundJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
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
    job.status = "aborted";
    job.finishedAt = Date.now();
  }
  return job;
}

export function abortAllBackgroundJobs(): void {
  for (const id of [...backgroundControllers.keys()]) {
    abortBackgroundJob(id);
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
  const id = `bg-${++backgroundSeq}-${Date.now().toString(36)}`;
  const controller = new AbortController();
  const cwd = input.cwd ?? defaultCwd;
  // Resolve session dir synchronously so resumeJobId can see it while the job runs.
  // Fresh mint → pass sessionDir (no continue). True resume → keep resumeSessionDir (adds -c).
  const prepared = resolveChildSessionDir(input, cwd);
  const resolvedInput: ChildTaskInput = prepared.continueSession
    ? {
        ...input,
        sessionMode: prepared.sessionMode,
        resumeSessionDir: prepared.sessionDir,
        sessionDir: undefined,
      }
    : {
        ...input,
        sessionMode: prepared.sessionMode,
        resumeSessionDir: undefined,
        sessionDir: prepared.sessionDir,
      };
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
  backgroundJobs.set(id, job);
  backgroundControllers.set(id, controller);

  void (async () => {
    job.status = "running";
    try {
      const result = await runChildTask(resolvedInput, defaultCwd, parentModel, controller.signal);
      job.result = result;
      if (result.sessionDir) job.sessionDir = result.sessionDir;
      if (controller.signal.aborted) job.status = "aborted";
      else if (result.exitCode === 0) job.status = "done";
      else job.status = "failed";
    } catch (err) {
      job.status = controller.signal.aborted ? "aborted" : "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = Date.now();
      backgroundControllers.delete(id);
      onComplete?.(job);
    }
  })();

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
  childWaiters.length = 0;
}

