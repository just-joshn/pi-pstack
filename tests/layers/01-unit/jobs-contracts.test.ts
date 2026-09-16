import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

interface RecordedSpawn {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  killSignals: string[];
}

interface SpawnPlan {
  stdout: string;
  exitCode: number;
  closes: boolean;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: (signal?: string) => boolean;
}

let spawnPlan: SpawnPlan = { stdout: "", exitCode: 0, closes: true };
let recordedSpawns: RecordedSpawn[] = [];

function setSpawnPlan(plan: Partial<SpawnPlan>): void {
  spawnPlan = { stdout: "", exitCode: 0, closes: true, ...plan };
}

function messageLine(text: string): string {
  const event = {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
  return `${JSON.stringify(event)}\n`;
}

function makeFakeChild(plan: SpawnPlan, record: RecordedSpawn): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = (signal?: string) => {
    record.killSignals = [...record.killSignals, signal ?? "SIGTERM"];
    return true;
  };
  setImmediate(() => {
    if (plan.stdout) child.stdout.emit("data", Buffer.from(plan.stdout, "utf8"));
    if (plan.closes) child.emit("close", plan.exitCode);
  });
  return child;
}

function fakeSpawn(
  _command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): FakeChild {
  const record: RecordedSpawn = {
    args: [...args],
    cwd: options.cwd ?? "",
    env: options.env ?? {},
    killSignals: [],
  };
  recordedSpawns = [...recordedSpawns, record];
  return makeFakeChild(spawnPlan, record);
}

const nodeRequire = createRequire(import.meta.url);
const childProcessModule = nodeRequire("node:child_process") as { spawn: unknown };
childProcessModule.spawn = fakeSpawn as unknown;

const childProcessEsm = await import("node:child_process");
if (childProcessEsm.spawn !== (fakeSpawn as unknown)) {
  throw new Error("fake spawn did not reach the child_process ESM facade; refusing to run");
}

const childRunner = await import("../../../extensions/subagents/child-runner.ts");
const subagents = await import("../../../extensions/subagents/index.ts");

interface ToolUpdate {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface ToolReply {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
    ctx?: unknown,
  ) => Promise<ToolReply>;
}

interface FollowUpCall {
  text: string;
  options: Record<string, unknown>;
}

interface Harness {
  ctx: { model: { provider: string; id: string }; cwd: string };
  tool: (name: string) => CapturedTool;
  shutdown: () => void;
  followUps: FollowUpCall[];
}

function makeHarness(cwd: string): Harness {
  const tools = new Map<string, CapturedTool>();
  const listeners = new Map<string, () => void>();
  let followUps: FollowUpCall[] = [];
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
    sendUserMessage(text: string, options: Record<string, unknown>) {
      followUps = [...followUps, { text, options }];
    },
  };
  subagents.registerSpawn(pi as never);
  return {
    ctx: { model: { provider: "anthropic", id: "claude-parent-4-5" }, cwd, isProjectTrusted: () => false },
    tool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
    shutdown() {
      const handler = listeners.get("session_shutdown");
      if (!handler) throw new Error("session_shutdown handler not registered");
      handler();
    },
    get followUps() {
      return followUps;
    },
  };
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "pstack-jobs-contracts-"));
}

function runJobs(h: Harness, params: Record<string, unknown>): Promise<ToolReply> {
  return h.tool("pstack_jobs").execute("call-jobs", params, undefined, undefined, h.ctx);
}

function runSpawn(h: Harness, params: Record<string, unknown>): Promise<ToolReply> {
  return h.tool("pstack_spawn").execute("call-spawn", params, undefined, undefined, h.ctx);
}

function probeResult(output: string): {
  task: string;
  model: string;
  role: string;
  exitCode: number;
  output: string;
  stderr: string;
} {
  return { task: "brief", model: "test/model", role: "general", exitCode: 0, output, stderr: "" };
}

async function awaitFollowUp(h: Harness, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const call = h.followUps.at(-1);
    if (call) return call.text;
    await delay(10);
  }
  throw new Error("background completion follow-up was not delivered");
}

test("jobs-02 exercises list, status, await, abort, and cancel and requires an id outside list", async () => {
  childRunner.__resetBackgroundJobsForTests();
  const h = makeHarness(tempCwd());
  childRunner.__seedBackgroundJobForTests({
    id: "bg-probe",
    status: "done",
    role: "general",
    model: "test/model",
    startedAt: 10,
    finishedAt: 20,
    sessionDir: "/tmp/probe-session",
    result: probeResult("probe output"),
  });
  const listed = await runJobs(h, { action: "list" });
  expect(listed.content[0].text).toMatch(/^concurrency \d+\/\d+ waiting=\d+/);
  const status = await runJobs(h, { action: "status", id: "bg-probe" });
  expect(status.content[0].text).toMatch(/^bg-probe status=done/);
  const awaited = await runJobs(h, { action: "await", id: "bg-probe" });
  expect(awaited.content[0].text).toMatch(/^### pstack_jobs await \(bg-probe, status=done/);
  const aborted = await runJobs(h, { action: "abort", id: "bg-probe" });
  expect(aborted.content[0].text).toMatch(/^abort requested; job bg-probe status=done/);
  const cancelled = await runJobs(h, { action: "cancel", id: "bg-probe" });
  expect(cancelled.content[0].text).toMatch(/^abort requested; job bg-probe status=done/);
  await expect(runJobs(h, { action: "frobnicate", id: "bg-probe" })).rejects.toThrow(/action must be list\|status\|await\|abort\|cancel/);
  await expect(runJobs(h, { action: "status" })).rejects.toThrow(/id required for status\|await/);
  await expect(runJobs(h, { action: "await" })).rejects.toThrow(/id required for status\|await/);
  await expect(runJobs(h, { action: "abort" })).rejects.toThrow(/id required for abort/);
  await expect(runJobs(h, { action: "cancel" })).rejects.toThrow(/id required for abort/);
  await expect(runJobs(h, { action: "status", id: "bg-missing" })).rejects.toThrow(/unknown job: bg-missing/);
  await expect(runJobs(h, { action: "cancel", id: "bg-missing" })).rejects.toThrow(/unknown job: bg-missing/);
});

test("jobs-03 prints the list header with counts and orders rows by start time", async () => {
  childRunner.__resetBackgroundJobsForTests();
  const h = makeHarness(tempCwd());
  childRunner.__seedBackgroundJobForTests({
    id: "bg-late",
    status: "done",
    role: "reviewer",
    model: "test/late-model",
    startedAt: 200,
    finishedAt: 600,
    sessionDir: "/tmp/late",
  });
  childRunner.__seedBackgroundJobForTests({
    id: "bg-early",
    status: "done",
    role: "general",
    model: "test/early-model",
    startedAt: 100,
    finishedAt: 500,
    sessionDir: "/tmp/early",
  });
  const reply = await runJobs(h, { action: "list" });
  const lines = reply.content[0].text.split("\n");
  expect(lines[0]).toBe(`concurrency 0/${childRunner.MAX_CONCURRENCY} waiting=0`);
  expect(lines[1]).toBe(`bg-early status=done role=general model=test/early-model started=${new Date(100).toISOString()} finished=${new Date(500).toISOString()} sessionDir=/tmp/early`);
  expect(lines[2]).toBe(`bg-late status=done role=reviewer model=test/late-model started=${new Date(200).toISOString()} finished=${new Date(600).toISOString()} sessionDir=/tmp/late`);
  expect(lines.length).toBe(3);
  expect(reply.details.jobs).toEqual([
    { id: "bg-early", status: "done", sessionDir: "/tmp/early" },
    { id: "bg-late", status: "done", sessionDir: "/tmp/late" },
  ]);
  expect(reply.details.concurrency).toEqual({ active: 0, cap: childRunner.MAX_CONCURRENCY, waiting: 0 });
});

test("jobs-04 truncates status output to 8000 characters and fails closed on an unknown id", async () => {
  childRunner.__resetBackgroundJobsForTests();
  const h = makeHarness(tempCwd());
  const longOutput = `${"A".repeat(9000)}TAIL`;
  childRunner.__seedBackgroundJobForTests({
    id: "bg-long",
    status: "done",
    role: "general",
    model: "test/model",
    startedAt: 10,
    finishedAt: 20,
    sessionDir: "/tmp/long-session",
    result: probeResult(longOutput),
  });
  const reply = await runJobs(h, { action: "status", id: "bg-long" });
  const text = reply.content[0].text;
  expect(text.startsWith("bg-long status=done role=general model=test/model sessionDir=/tmp/long-session\n\nexit 0\n")).toBe(true);
  expect(text.endsWith("A".repeat(8000))).toBe(true);
  expect(text.includes("TAIL")).toBe(false);
  const job = reply.details.job as { result: { output: string } };
  expect(job.result.output).toBe(longOutput);
  expect(reply.details.sessionDir).toBe("/tmp/long-session");
  await expect(runJobs(h, { action: "status", id: "bg-unknown" })).rejects.toThrow(/unknown job: bg-unknown/);
});

test("jobs-05 awaits a terminal result and times out without leaking the job", async () => {
  childRunner.__resetBackgroundJobsForTests();
  const h = makeHarness(tempCwd());
  childRunner.__seedBackgroundJobForTests({
    id: "bg-terminal",
    status: "done",
    role: "general",
    startedAt: 10,
    finishedAt: 20,
    sessionDir: "/tmp/terminal",
    result: probeResult("terminal output"),
  });
  const done = await childRunner.awaitBackgroundJob("bg-terminal", 5000);
  expect(done.status).toBe("done");
  expect(done.result?.output).toBe("terminal output");
  const awaited = await runJobs(h, { action: "await", id: "bg-terminal" });
  expect(awaited.content[0].text).toBe("### pstack_jobs await (bg-terminal, status=done, sessionDir=/tmp/terminal)\n\nterminal output");

  childRunner.__seedBackgroundJobForTests({ id: "bg-flip", status: "running", role: "general", startedAt: 30 });
  const flipping = childRunner.awaitBackgroundJob("bg-flip", 5000);
  await delay(60);
  childRunner.__seedBackgroundJobForTests({
    id: "bg-flip",
    status: "done",
    role: "general",
    startedAt: 30,
    finishedAt: 90,
    result: probeResult("flipped"),
  });
  const flipped = await flipping;
  expect(flipped.status).toBe("done");
  expect(flipped.result?.output).toBe("flipped");

  childRunner.__seedBackgroundJobForTests({ id: "bg-stuck", status: "running", role: "general", startedAt: 40 });
  await expect(childRunner.awaitBackgroundJob("bg-stuck", 300)).rejects.toThrow(/await timed out for job bg-stuck/);
  const still = await runJobs(h, { action: "status", id: "bg-stuck" });
  expect(still.content[0].text).toMatch(/^bg-stuck status=running/);
  expect(childRunner.getBackgroundJob("bg-stuck")?.status).toBe("running");
  await expect(childRunner.awaitBackgroundJob("bg-missing", 200)).rejects.toThrow(/unknown background job: bg-missing/);
});

test("jobs-07 keeps records queryable across follow-ups and aborts in-flight jobs on shutdown", async () => {
  childRunner.__resetBackgroundJobsForTests();
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    setSpawnPlan({ stdout: messageLine("first done") });
    const first = await runSpawn(h, { task: "first brief", role: "general", model: "test/model", background: true });
    await awaitFollowUp(h);
    const firstId = first.details.jobId as string;
    const afterFollowUp = await runJobs(h, { action: "status", id: firstId });
    expect(afterFollowUp.content[0].text).toMatch(/status=done/);
    const afterSecondPoll = await runJobs(h, { action: "status", id: firstId });
    expect(afterSecondPoll.content[0].text).toMatch(/status=done/);
    expect(childRunner.listBackgroundJobs().some((job) => job.id === firstId)).toBe(true);

    setSpawnPlan({ closes: false });
    const running = await runSpawn(h, { task: "long brief", role: "general", model: "test/model", background: true });
    await delay(5);
    const runningId = running.details.jobId as string;
    expect(childRunner.getBackgroundJob(runningId)?.status).toBe("running");
    h.shutdown();
    expect(childRunner.getBackgroundJob(runningId), "shutdown clears job records").toBe(undefined);
    expect(childRunner.listBackgroundJobs()).toEqual([]);
    expect(recordedSpawns.at(-1)?.killSignals).toEqual(["SIGTERM"]);
    await expect(runJobs(h, { action: "status", id: runningId })).rejects.toThrow(new RegExp(`unknown job: ${runningId}`));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
