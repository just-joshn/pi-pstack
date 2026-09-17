/**
 * The background-child registry is shared state reachable from the spawn path,
 * the cancel path, and session shutdown. These drive those paths through the
 * public API and assert what a caller can observe.
 */
import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  killSignals: string[];
  kill: (signal?: string) => boolean;
}

interface ToolReply {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolReply>;
}

interface Harness {
  spawn: (params: Record<string, unknown>) => Promise<ToolReply>;
  shutdown: () => void;
}

let spawned: FakeChild[] = [];

function fakeSpawn(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 5150;
  child.killSignals = [];
  child.kill = (signal?: string) => {
    child.killSignals = [...child.killSignals, signal ?? "SIGTERM"];
    return true;
  };
  spawned = [...spawned, child];
  return child;
}

const childProcessModule = createRequire(import.meta.url)("node:child_process") as { spawn: unknown };
childProcessModule.spawn = fakeSpawn as unknown;
const childProcessEsm = await import("node:child_process");
if (childProcessEsm.spawn !== (fakeSpawn as unknown)) {
  throw new Error("fake spawn did not reach the child_process ESM facade; refusing to run");
}

const childRunner = await import("../../../extensions/subagents/child-runner.ts");
const subagents = await import("../../../extensions/subagents/index.ts");

function makeHarness(cwd: string): Harness {
  const tools = new Map<string, CapturedTool>();
  const listeners = new Map<string, () => void>();
  const ctx = { model: { provider: "anthropic", id: "claude-parent-4-5" }, cwd, isProjectTrusted: () => false };
  const pi = {
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
    },
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    getActiveTools() {
      return [] as string[];
    },
    sendUserMessage() {},
  };
  subagents.registerSpawn(pi as never);
  const spawnTool = tools.get("pstack_spawn");
  if (!spawnTool) throw new Error("pstack_spawn was not registered");
  return {
    spawn: (params) => spawnTool.execute("call-spawn", params, undefined, undefined, ctx),
    shutdown: () => {
      const handler = listeners.get("session_shutdown");
      if (!handler) throw new Error("session_shutdown handler was not registered");
      handler();
    },
  };
}

function tempCwd(t: { after: (fn: () => void) => void }): string {
  const cwd = mkdtempSync(join(tmpdir(), "pstack-background-registry-"));
  t.onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function spawnBackground(harness: Harness, task: string): Promise<ToolReply> {
  return harness.spawn({ task, role: "general", model: "test/model", background: true });
}

async function runningJobId(harness: Harness, task: string): Promise<string> {
  const reply = await spawnBackground(harness, task);
  const jobId = reply.details.jobId;
  if (typeof jobId !== "string") throw new Error("pstack_spawn did not return a job id");
  await delay(5);
  return jobId;
}

test("a background spawn is recorded and listed while it runs", async (t) => {
  childRunner.__resetBackgroundJobsForTests();
  spawned = [];
  const harness = makeHarness(tempCwd(t));
  const jobId = await runningJobId(harness, "registry brief");
  expect(childRunner.getBackgroundJob(jobId)?.status).toBe("running");
  expect(childRunner.listBackgroundJobs().map((job) => job.id)).toEqual([jobId]);
  childRunner.abortAllBackgroundJobs();
});

test("cancelling a running job reaches the child process it owns", async (t) => {
  childRunner.__resetBackgroundJobsForTests();
  spawned = [];
  const harness = makeHarness(tempCwd(t));
  const jobId = await runningJobId(harness, "cancel brief");
  const aborted = childRunner.abortBackgroundJob(jobId);
  expect(aborted?.status).toBe("aborted");
  expect(spawned.at(-1)?.killSignals).toEqual(["SIGTERM"]);
  expect(childRunner.abortBackgroundJob(jobId)?.status).toBe("aborted");
  expect(childRunner.getBackgroundJob(jobId)?.status).toBe("aborted");
});

test("session shutdown aborts an in-flight job and drops its record", async (t) => {
  childRunner.__resetBackgroundJobsForTests();
  spawned = [];
  const harness = makeHarness(tempCwd(t));
  const jobId = await runningJobId(harness, "shutdown brief");
  harness.shutdown();
  expect(childRunner.getBackgroundJob(jobId)).toBe(undefined);
  expect(childRunner.listBackgroundJobs()).toEqual([]);
  expect(spawned.at(-1)?.killSignals).toEqual(["SIGTERM"]);
});
