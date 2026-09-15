/**
 * Thin Pi child-agent runner (official Pi ExtensionAPI child-process pattern).
 * Spawns `pi --mode json -p` subprocesses. No pi-subagents dependency.
 *
 * Global child concurrency is capped at MAX_CONCURRENCY (4) across
 * pstack_spawn / pstack_swarm / pstack_arena via withChildSlot.
 */
import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";

export const MAX_TASKS = 8;
/** Shared cap for all pstack child agents (spawn + swarm + arena). */
export const MAX_CONCURRENCY = 4;
export const MAX_OUTPUT_BYTES = 50 * 1024;
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
}

export interface ChildTaskResult {
  task: string;
  model: string;
  role?: string;
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string;
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

export function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  let content = text.slice(0, MAX_OUTPUT_BYTES);
  while (Buffer.byteLength(content, "utf8") > MAX_OUTPUT_BYTES) content = content.slice(0, -1);
  return `${content}\n\n[Output truncated to ${MAX_OUTPUT_BYTES} bytes.]`;
}

function appendCapped(current: string, chunk: string): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_OUTPUT_BYTES) return current;
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_OUTPUT_BYTES) return next;
  return truncate(next);
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

  const args = ["--mode", "json", "-p", "--no-session", "--model", selectedModel];
  if (input.skillPath) args.push("--skill", input.skillPath);
  if (input.tools?.length) args.push("--tools", input.tools.join(","));

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

  args.push(prompt);

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
    cwd: input.cwd ?? defaultCwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
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
      // Keep draining so the child does not block on a full pipe, but stop retaining.
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

  let output = truncate(finalText(messages) || stderr || (timedOut ? "(timed out)" : "(no output)"));
  if (midStreamCapped && !output.includes("[Output truncated")) {
    output = `${output}\n\n[Mid-stream output capped at ${MAX_OUTPUT_BYTES} bytes.]`;
  }

  return {
    task: input.task,
    model: selectedModel,
    role: input.role,
    exitCode: timedOut ? 124 : aborted ? 130 : exitCode,
    output,
    stderr: truncate(stderr),
    stopReason: timedOut ? "timeout" : aborted ? "aborted" : stopReason,
  };
}

/** In-process background job registry (session-scoped). */
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
 */
export function enqueueBackgroundChild(
  input: ChildTaskInput,
  defaultCwd: string,
  parentModel: string,
  onComplete?: (job: BackgroundJob) => void,
): BackgroundJob {
  const id = `bg-${++backgroundSeq}-${Date.now().toString(36)}`;
  const controller = new AbortController();
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
  };
  backgroundJobs.set(id, job);
  backgroundControllers.set(id, controller);

  void (async () => {
    job.status = "running";
    try {
      const result = await runChildTask(input, defaultCwd, parentModel, controller.signal);
      job.result = result;
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
