import { afterAll, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLoopController } from "../../../extensions/loop/controller.ts";
import { registerHeartbeat } from "../../../extensions/heartbeat/index.ts";
import { initialRecord, reduceRun, type RunRecord } from "../../../extensions/loop/fsm.ts";
import { saveRun, loadRun } from "../../../extensions/loop/run-store.ts";

const dir = mkdtempSync(join(tmpdir(), "pstack-runs-"));
process.env.PSTACK_RUNS_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MANDATED_ACTIONS = [
  "arm",
  "state",
  "iterate",
  "verify",
  "discard",
  "inconclusive",
  "checkpoint",
  "blocked",
  "handoff",
  "stop",
  "list",
];

interface CapturedTool {
  name: string;
  description: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
}

function fakeRunEnv() {
  let tool: CapturedTool | undefined;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    sendUserMessage() {},
  };
  const ctx = { ui: { setStatus() {}, notify() {} } };
  registerLoopController(pi as never);
  return { tool: () => tool as CapturedTool, ctx };
}

function waitingRecord(runId: string) {
  const base = initialRecord({ runId, now: 1000 });
  return reduceRun(base, { type: "predicate_defined", predicate: "ci green" }, 1000).record;
}

test("pstack_run registers the mandated action set", async () => {
  const env = fakeRunEnv();
  expect(env.tool().name).toBe("pstack_run");
  const error = await env.tool().execute("t", { action: "bogus" }, undefined, undefined, env.ctx).catch((err: Error) => err);
  expect(error instanceof Error).toBeTruthy();
  for (const action of MANDATED_ACTIONS) {
    expect(error.message.includes(action), `error names action ${action}`).toBe(true);
  }
});

test("arm without a predicate errors before arming a loop", async () => {
  const env = fakeRunEnv();
  await expect(() => env.tool().execute("t", { action: "arm", intervalSeconds: 30 }, undefined, undefined, env.ctx)).rejects.toThrow(/predicate required to arm a run/);
});

test("arm without intervalSeconds errors", async () => {
  const env = fakeRunEnv();
  await expect(() => env.tool().execute("t", { action: "arm", predicate: "ci green" }, undefined, undefined, env.ctx)).rejects.toThrow(/intervalSeconds required to arm a run/);
});

test("verify without evidence errors", async () => {
  const env = fakeRunEnv();
  saveRun(waitingRecord("run-verify"));
  await expect(() => env.tool().execute("t", { action: "verify", runId: "run-verify" }, undefined, undefined, env.ctx)).rejects.toThrow(/evidence required to verify an iteration/);
});

function fakeFullEnv() {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    sendUserMessage() {},
    exec() {
      return new Promise(() => {});
    },
  };
  const ctx = { ui: { setStatus() {}, notify() {} } };
  registerHeartbeat(pi as never);
  registerLoopController(pi as never);
  return { tools, ctx };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text: string }> }).content;
  return content.at(0)?.text ?? "";
}

test("arm routes the run through the heartbeat wake path and stop removes it", async () => {
  const env = fakeFullEnv();
  const run = env.tools.get("pstack_run");
  const loop = env.tools.get("pstack_loop");
  expect(run && loop).toBeTruthy();
  const armed = await run.execute(
    "t",
    { action: "arm", runId: "run-arm", predicate: "ci green", intervalSeconds: 60, maxFires: 5 },
    undefined,
    undefined,
    env.ctx,
  );
  expect((armed as { details: { run: RunRecord } }).details.run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
  const listed = await loop.execute("t", { action: "list" }, undefined, undefined, env.ctx);
  expect(textOf(listed)).toMatch(/run-arm mode=interval/);
  const stopped = await run.execute("t", { action: "stop", runId: "run-arm" }, undefined, undefined, env.ctx);
  expect(textOf(stopped)).toMatch(/stopped run-arm/);
});

test("state reports a stored run and rejects an unknown id", async () => {
  const env = fakeRunEnv();
  saveRun(waitingRecord("run-state"));
  const result = (await env.tool().execute("t", { action: "state", runId: "run-state" }, undefined, undefined, env.ctx)) as { content: Array<{ text: string }> };
  expect(result.content.at(0)?.text ?? "").toMatch(/run-state phase=WAIT_FOR_EVENT_OR_HEARTBEAT/);
  await expect(() => env.tool().execute("t", { action: "state", runId: "run-missing" }, undefined, undefined, env.ctx)).rejects.toThrow(/unknown run run-missing/);
});

test("session_shutdown blocks every run armed in this process", async () => {
  let shutdown: (() => void) | undefined;
  let tool: CapturedTool | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    sendUserMessage() {},
    exec() {
      return new Promise(() => {});
    },
  };
  const ctx = { ui: { setStatus() {}, notify() {} } };
  registerHeartbeat(pi as never);
  registerLoopController(pi as never);
  expect(tool && shutdown, "the controller registers pstack_run and a shutdown handler").toBeTruthy();
  await tool.execute(
    "t",
    { action: "arm", runId: "run-shutdown", predicate: "ci green", intervalSeconds: 60 },
    undefined,
    undefined,
    ctx,
  );
  shutdown();
  const record = loadRun("run-shutdown");
  expect(record?.phase).toBe("BLOCKED");
  expect(record?.blockedReason ?? "").toMatch(/local runtime session ended without completion/);
});

function shutdownEnv() {
  let shutdown: (() => void) | undefined;
  let tool: CapturedTool | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    sendUserMessage() {},
    exec() {
      return new Promise(() => {});
    },
  };
  const ctx = { ui: { setStatus() {}, notify() {} } };
  registerHeartbeat(pi as never);
  registerLoopController(pi as never);
  if (!tool || !shutdown) throw new Error("the controller registers pstack_run and a shutdown handler");
  return { tool, shutdown, ctx };
}

function armRun(env: ReturnType<typeof shutdownEnv>, runId: string): Promise<unknown> {
  return env.tool.execute(
    "t",
    { action: "arm", runId, predicate: "ci green", intervalSeconds: 60 },
    undefined,
    undefined,
    env.ctx,
  );
}

test("a run armed after a shutdown is still tracked and blocked by the next shutdown", async () => {
  const first = shutdownEnv();
  await armRun(first, "run-after-1");
  first.shutdown();
  expect(loadRun("run-after-1")?.phase).toBe("BLOCKED");

  const second = shutdownEnv();
  await armRun(second, "run-after-2");
  expect(loadRun("run-after-2")?.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
  second.shutdown();
  expect(loadRun("run-after-2")?.phase).toBe("BLOCKED");
});
