import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLoopController } from "../../../extensions/loop/controller.ts";
import { registerHeartbeat } from "../../../extensions/heartbeat/index.ts";
import { initialRecord, reduceRun, type RunRecord } from "../../../extensions/loop/fsm.ts";
import { saveRun } from "../../../extensions/loop/run-store.ts";

const dir = mkdtempSync(join(tmpdir(), "pstack-runs-"));
process.env.PSTACK_RUNS_DIR = dir;

after(() => {
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
  assert.equal(env.tool().name, "pstack_run");
  const error = await env.tool().execute("t", { action: "bogus" }, undefined, undefined, env.ctx).catch((err: Error) => err);
  assert.ok(error instanceof Error);
  for (const action of MANDATED_ACTIONS) {
    assert.equal(error.message.includes(action), true, `error names action ${action}`);
  }
});

test("arm without a predicate errors before arming a loop", async () => {
  const env = fakeRunEnv();
  await assert.rejects(
    () => env.tool().execute("t", { action: "arm", intervalSeconds: 30 }, undefined, undefined, env.ctx),
    /predicate required to arm a run/,
  );
});

test("arm without intervalSeconds errors", async () => {
  const env = fakeRunEnv();
  await assert.rejects(
    () => env.tool().execute("t", { action: "arm", predicate: "ci green" }, undefined, undefined, env.ctx),
    /intervalSeconds required to arm a run/,
  );
});

test("verify without evidence errors", async () => {
  const env = fakeRunEnv();
  saveRun(waitingRecord("run-verify"));
  await assert.rejects(
    () => env.tool().execute("t", { action: "verify", runId: "run-verify" }, undefined, undefined, env.ctx),
    /evidence required to verify an iteration/,
  );
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
  assert.ok(run && loop);
  const armed = await run.execute(
    "t",
    { action: "arm", runId: "run-arm", predicate: "ci green", intervalSeconds: 60, maxFires: 5 },
    undefined,
    undefined,
    env.ctx,
  );
  assert.equal((armed as { details: { run: RunRecord } }).details.run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
  const listed = await loop.execute("t", { action: "list" }, undefined, undefined, env.ctx);
  assert.match(textOf(listed), /run-arm mode=interval/);
  const stopped = await run.execute("t", { action: "stop", runId: "run-arm" }, undefined, undefined, env.ctx);
  assert.match(textOf(stopped), /stopped run-arm/);
});

test("state reports a stored run and rejects an unknown id", async () => {
  const env = fakeRunEnv();
  saveRun(waitingRecord("run-state"));
  const result = (await env.tool().execute("t", { action: "state", runId: "run-state" }, undefined, undefined, env.ctx)) as { content: Array<{ text: string }> };
  assert.match(result.content.at(0)?.text ?? "", /run-state phase=WAIT_FOR_EVENT_OR_HEARTBEAT/);
  await assert.rejects(
    () => env.tool().execute("t", { action: "state", runId: "run-missing" }, undefined, undefined, env.ctx),
    /unknown run run-missing/,
  );
});
