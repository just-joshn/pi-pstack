import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLoopController } from "../../../extensions/loop/controller.ts";
import { registerHeartbeat } from "../../../extensions/heartbeat/index.ts";
import { initialRecord, reduceRun, type RunEvent, type RunRecord } from "../../../extensions/loop/fsm.ts";
import { loadRun, saveRun } from "../../../extensions/loop/run-store.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: { run: RunRecord; effects: Array<{ type: string }> };
}

interface LooseResult {
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
  ) => Promise<LooseResult>;
}

function scopedRuns(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "pstack-runctl-"));
  process.env.PSTACK_RUNS_DIR = dir;
  return () => rmSync(dir, { recursive: true, force: true });
}

function fakeEnv() {
  const tools = new Map<string, CapturedTool>();
  let shutdown: (() => void) | undefined;
  let sent: string[] = [];
  let notifications: string[] = [];
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    sendUserMessage(text: string) {
      sent = [...sent, text];
    },
    exec() {
      return new Promise(() => {});
    },
  };
  const ctx = {
    ui: {
      setStatus() {},
      notify(message: string) {
        notifications = [...notifications, message];
      },
    },
  };
  registerHeartbeat(pi as never);
  registerLoopController(pi as never);
  const tool = tools.get("pstack_run");
  const loopTool = tools.get("pstack_loop");
  if (!tool || !loopTool) throw new Error("pstack_run and pstack_loop must both register");
  return {
    ctx,
    loopTool,
    sent: () => sent,
    notifications: () => notifications,
    shutdown: () => shutdown?.(),
    run: (params: Record<string, unknown>) => tool.execute("t", params, undefined, undefined, ctx),
  };
}

function textOf(result: LooseResult): string {
  return result.content[0]?.text ?? "";
}

function runOf(result: LooseResult): { run: RunRecord; effects: Array<{ type: string }> } {
  return result.details as unknown as { run: RunRecord; effects: Array<{ type: string }> };
}

function seeded(runId: string, steps: RunEvent[], now = 1000): RunRecord {
  const base = initialRecord({ runId, now });
  return steps.reduce((record, event) => reduceRun(record, event, now).record, base);
}

const DEFINED: RunEvent[] = [{ type: "predicate_defined", predicate: "ci green" }];
const RESUMED: RunEvent[] = [...DEFINED, { type: "heartbeat" }];
const ACTING: RunEvent[] = [...RESUMED, { type: "iteration_started", action: "smallest change" }];
const VERIFYING: RunEvent[] = [...ACTING, { type: "verification_started" }];
const CHECKPOINTED: RunEvent[] = [...VERIFYING, { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, { type: "checkpoint" }, { type: "predicate_checked" }];

test("arm records the predicate, the limits, and the literal arming notification", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    const result = await env.run({
      action: "arm",
      runId: "run-arm",
      predicate: "ci green",
      intervalSeconds: 60,
      maxFires: 7,
      plateauLimit: 5,
      remoteRequired: true,
    });
    const { run, effects } = runOf(result);
    assert.equal(run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
    assert.equal(run.predicate, "ci green");
    assert.equal(run.maxFires, 7);
    assert.equal(run.plateauLimit, 5);
    assert.deepEqual(run.remote, { required: true, handedOff: false });
    assert.equal(run.fires, 0);
    assert.equal(run.iterations.length, 0);
    assert.deepEqual(effects, [{ type: "notify", message: "run run-arm predicate defined: ci green" }]);
    assert.equal(
      textOf(result),
      "run-arm phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/7 predicate=ci green\nrun run-arm predicate defined: ci green",
    );
    assert.deepEqual(env.sent(), []);
  } finally {
    cleanup();
  }
});

test("arm without a runId generates one and leaves the default limits in place", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    const result = await env.run({ action: "arm", predicate: "docs written", intervalSeconds: 30 });
    const { run } = runOf(result);
    assert.match(run.runId, /^run-[0-9a-z]+-[0-9a-z]{6}$/);
    assert.equal(run.maxFires, 50);
    assert.equal(run.plateauLimit, 3);
    assert.deepEqual(run.remote, { required: false, handedOff: false });
  } finally {
    cleanup();
  }
});

test("arm clamps a below-floor interval and defaults the mode to dynamic when watchArgv is set", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await env.run({
      action: "arm",
      runId: "run-watch",
      predicate: "ci green",
      intervalSeconds: 1,
      watchArgv: ["gh", "pr", "checks"],
    });
    const listed = await env.loopTool.execute("t", { action: "list" }, undefined, undefined, env.ctx);
    assert.equal(textOf(listed), "run-watch mode=dynamic fires=0/50 armed=true lastReason=-");
  } finally {
    cleanup();
  }
});

test("arm honours an explicit mode over the watchArgv default", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await env.run({
      action: "arm",
      runId: "run-settle",
      predicate: "ci green",
      intervalSeconds: 30,
      mode: "settle",
      watchArgv: ["gh", "pr", "checks"],
    });
    const listed = await env.loopTool.execute("t", { action: "list" }, undefined, undefined, env.ctx);
    assert.match(textOf(listed), /run-settle mode=settle/);
  } finally {
    cleanup();
  }
});

test("arm rejects a missing predicate, a non-numeric interval, and an unknown runId", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await assert.rejects(
      () => env.run({ action: "arm", intervalSeconds: 30 }),
      /predicate required to arm a run/,
    );
    await assert.rejects(
      () => env.run({ action: "arm", predicate: "ci green", intervalSeconds: "30" }),
      /intervalSeconds required to arm a run/,
    );
    await assert.rejects(() => env.run({ action: "iterate", runId: "run-nope" }), /unknown run run-nope/);
    await assert.rejects(() => env.run({ action: "iterate" }), /runId required for this action/);
    await assert.rejects(
      () => env.run({ action: "mystery" }),
      /action must be arm\|state\|iterate\|verify\|discard\|inconclusive\|checkpoint\|blocked\|handoff\|stop\|list/,
    );
  } finally {
    cleanup();
  }
});

test("state reads a stored run by id and falls back to the latest by updatedAt", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun({ ...seeded("run-old", DEFINED), updatedAt: 5000 });
    saveRun({ ...seeded("run-new", DEFINED), updatedAt: 9000 });
    const byId = await env.run({ action: "state", runId: "run-old" });
    assert.equal(runOf(byId).run.runId, "run-old");
    assert.deepEqual(runOf(byId).effects, []);
    const latest = await env.run({ action: "state" });
    assert.equal(runOf(latest).run.runId, "run-new");
    await assert.rejects(() => env.run({ action: "state", runId: "run-absent" }), /unknown run run-absent/);
  } finally {
    cleanup();
  }
});

test("state with no runs recorded refuses instead of inventing a record", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await assert.rejects(() => env.run({ action: "state" }), /no runs recorded/);
    const listed = await env.run({ action: "list" });
    assert.equal(textOf(listed), "(no runs)");
    assert.deepEqual(listed.details, { runs: [], count: 0 });
  } finally {
    cleanup();
  }
});

test("iterate is a no-op on a freshly armed run because the phase is still WAIT", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await env.run({ action: "arm", runId: "run-wait", predicate: "ci green", intervalSeconds: 30 });
    const result = await env.run({ action: "iterate", runId: "run-wait", step: "smallest change" });
    const { run, effects } = runOf(result);
    assert.equal(run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
    assert.equal(run.iterations.length, 0);
    assert.deepEqual(effects, []);
  } finally {
    cleanup();
  }
});

test("iterate opens an iteration once the run has resumed, taking step before reason", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-resumed", RESUMED));
    const fromStep = await env.run({ action: "iterate", runId: "run-resumed", step: "patch the reducer" });
    const { run } = runOf(fromStep);
    assert.equal(run.phase, "ACT");
    assert.equal(run.iterations.length, 1);
    assert.equal(run.iterations[0]?.action, "patch the reducer");
    assert.equal(run.iterations[0]?.n, 1);
    assert.equal(run.iterations[0]?.verdict, "inconclusive");
    assert.deepEqual(run.iterations[0]?.endedAt, undefined);
  } finally {
    cleanup();
  }
});

test("iterate falls back to reason and then to the literal action name", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-reason", RESUMED));
    const fromReason = await env.run({ action: "iterate", runId: "run-reason", reason: "because" });
    assert.equal(runOf(fromReason).run.iterations[0]?.action, "because");
    saveRun(seeded("run-default", RESUMED));
    const fallback = await env.run({ action: "iterate", runId: "run-default" });
    assert.equal(runOf(fallback).run.iterations[0]?.action, "iterate");
  } finally {
    cleanup();
  }
});

test("verify requires evidence and records the verification with an optional commit", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-verify", VERIFYING));
    await assert.rejects(
      () => env.run({ action: "verify", runId: "run-verify" }),
      /evidence required to verify an iteration/,
    );
    const result = await env.run({
      action: "verify",
      runId: "run-verify",
      evidence: "exit 0",
      verification: "npm test",
      commit: "abc1234",
    });
    const { run, effects } = runOf(result);
    assert.equal(run.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
    assert.equal(run.iterations[0]?.verdict, "advanced");
    assert.equal(run.iterations[0]?.verification, "npm test");
    assert.equal(run.iterations[0]?.evidence, "exit 0");
    assert.equal(run.iterations[0]?.commit, "abc1234");
    assert.equal(run.consecutiveDiscards, 0);
    assert.deepEqual(effects, [{ type: "notify", message: "run run-verify iteration 1 advanced" }]);
  } finally {
    cleanup();
  }
});

test("verify defaults the verification label and omits an absent commit", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-plain", ACTING));
    const result = await env.run({ action: "verify", runId: "run-plain", evidence: "measured" });
    const iteration = runOf(result).run.iterations[0];
    assert.equal(iteration?.verification, "verify");
    assert.equal(iteration?.commit, undefined);
    assert.equal("commit" in (iteration ?? {}), false);
  } finally {
    cleanup();
  }
});

test("verify predicateMet runs the checkpoint chain to COMPLETE and stops the loop", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await env.run({ action: "arm", runId: "run-done", predicate: "ci green", intervalSeconds: 30 });
    saveRun({ ...loadRun("run-done"), ...seeded("run-done", ACTING) });
    const result = await env.run({
      action: "verify",
      runId: "run-done",
      evidence: "checks green",
      predicateMet: true,
    });
    const { run, effects } = runOf(result);
    assert.equal(run.phase, "COMPLETE");
    assert.equal(typeof run.completedAt, "number");
    assert.deepEqual(
      effects.map((effect) => effect.type),
      ["notify", "stop"],
    );
    assert.equal(run.iterations[0]?.verdict, "advanced");
    assert.match(textOf(result), /run run-done COMPLETE: predicate met with evidence/);
    const listed = await env.loopTool.execute("t", { action: "list" }, undefined, undefined, env.ctx);
    assert.equal(textOf(listed), "(no active loops)");
  } finally {
    cleanup();
  }
});

test("verify predicateMet from CHECK_PREDICATE skips the repeated checkpoint", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-at-check", CHECKPOINTED));
    assert.equal(loadRun("run-at-check")?.phase, "CHECK_PREDICATE");
    const result = await env.run({
      action: "verify",
      runId: "run-at-check",
      evidence: "checks green",
      predicateMet: true,
    });
    assert.equal(runOf(result).run.phase, "COMPLETE");
  } finally {
    cleanup();
  }
});

test("discard records the reason and starts the non-advancing counter", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-discard", ACTING));
    const result = await env.run({ action: "discard", runId: "run-discard", reason: "metric flat", evidence: "flat" });
    const { run, effects } = runOf(result);
    assert.equal(run.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
    assert.equal(run.iterations[0]?.verdict, "discarded");
    assert.equal(run.iterations[0]?.evidence, "flat");
    assert.equal(run.consecutiveDiscards, 1);
    assert.deepEqual(effects, [{ type: "notify", message: "run run-discard iteration 1 discarded: metric flat" }]);
  } finally {
    cleanup();
  }
});

test("discard defaults its reason and evidence and inconclusive counts as non-advancing", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-plateau", ACTING));
    const discarded = await env.run({ action: "discard", runId: "run-plateau" });
    assert.equal(runOf(discarded).run.iterations[0]?.evidence, "");
    assert.match(textOf(discarded), /discarded: no improvement/);
    saveRun(seeded("run-incon", ACTING));
    const inconclusive = await env.run({ action: "inconclusive", runId: "run-incon", reason: "ambiguous" });
    const run = runOf(inconclusive).run;
    assert.equal(run.iterations[0]?.verdict, "inconclusive");
    assert.equal(run.consecutiveDiscards, 1);
    assert.match(textOf(inconclusive), /inconclusive: ambiguous/);
  } finally {
    cleanup();
  }
});

test("checkpoint walks COMMIT to CHECKPOINT to CHECK_PREDICATE to WAIT and then stops", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-cp", [...VERIFYING, { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }]));
    const first = await env.run({ action: "checkpoint", runId: "run-cp" });
    assert.equal(runOf(first).run.phase, "CHECKPOINT");
    const second = await env.run({ action: "checkpoint", runId: "run-cp" });
    assert.equal(runOf(second).run.phase, "CHECK_PREDICATE");
    const third = await env.run({ action: "checkpoint", runId: "run-cp" });
    assert.equal(runOf(third).run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
    assert.match(textOf(third), /predicate unresolved; waiting for event or heartbeat/);
    const fourth = await env.run({ action: "checkpoint", runId: "run-cp" });
    assert.equal(runOf(fourth).run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
    assert.deepEqual(runOf(fourth).effects, []);
  } finally {
    cleanup();
  }
});

test("blocked requires a reason and records it literally", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-block", RESUMED));
    await assert.rejects(
      () => env.run({ action: "blocked", runId: "run-block" }),
      /reason required to mark a run blocked/,
    );
    const result = await env.run({ action: "blocked", runId: "run-block", reason: "awaiting review" });
    const { run, effects } = runOf(result);
    assert.equal(run.phase, "BLOCKED");
    assert.equal(run.blockedReason, "awaiting review");
    assert.deepEqual(
      effects.map((effect) => effect.type),
      ["notify", "stop"],
    );
    assert.match(textOf(result), /blockedReason: awaiting review/);
  } finally {
    cleanup();
  }
});

test("handoff requires an endpoint and marks the run blocked with a recorded handoff", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-handoff", RESUMED));
    await assert.rejects(
      () => env.run({ action: "handoff", runId: "run-handoff" }),
      /endpoint required for a hosted handoff/,
    );
    const result = await env.run({
      action: "handoff",
      runId: "run-handoff",
      endpoint: "https://worker.example",
    });
    const { run, effects } = runOf(result);
    assert.equal(run.phase, "BLOCKED");
    assert.deepEqual(run.remote, { required: true, handedOff: true, endpoint: "https://worker.example" });
    assert.deepEqual(
      effects.map((effect) => effect.type),
      ["handoff", "notify"],
    );
    assert.deepEqual(env.notifications(), [
      "run run-handoff hosted handoff recorded for https://worker.example; no local continuation",
      "run run-handoff handed off to https://worker.example; BLOCKED locally until the hosted worker exists",
    ]);
    assert.deepEqual(env.sent(), []);
  } finally {
    cleanup();
  }
});

test("stop reports whether an armed loop existed and list renders every stored run", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await env.run({ action: "arm", runId: "run-stop", predicate: "ci green", intervalSeconds: 30 });
    const armed = await env.run({ action: "stop", runId: "run-stop" });
    assert.equal(textOf(armed), "stopped run-stop");
    assert.deepEqual(armed.details, { runId: "run-stop", stopped: true });
    const again = await env.run({ action: "stop", runId: "run-stop" });
    assert.equal(textOf(again), "no armed loop for run-stop");
    assert.deepEqual(again.details, { runId: "run-stop", stopped: false });
    const listed = await env.run({ action: "list" });
    assert.equal(
      textOf(listed),
      "run-stop phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/50 predicate=ci green",
    );
    assert.equal(listed.details.count, 1);
  } finally {
    cleanup();
  }
});

test("session_shutdown blocks only the non-terminal runs armed in this process", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await env.run({ action: "arm", runId: "run-live", predicate: "ci green", intervalSeconds: 30 });
    await env.run({ action: "arm", runId: "run-done", predicate: "ci green", intervalSeconds: 30 });
    const blocked = await env.run({ action: "blocked", runId: "run-done", reason: "already done" });
    assert.equal(runOf(blocked).run.phase, "BLOCKED");
    env.shutdown();
    assert.equal(loadRun("run-live")?.phase, "BLOCKED");
    assert.equal(loadRun("run-live")?.blockedReason, "local runtime session ended without completion; hand off to a hosted worker or re-arm");
    assert.equal(loadRun("run-done")?.blockedReason, "already done");
    const listed = await env.loopTool.execute("t", { action: "list" }, undefined, undefined, env.ctx);
    assert.equal(textOf(listed), "(no active loops)");
  } finally {
    cleanup();
  }
});
