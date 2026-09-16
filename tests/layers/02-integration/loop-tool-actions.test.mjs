import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { withSession } from "../../support/session.mjs";
import { initialRecord, reduceRun } from "../../../extensions/loop/fsm.ts";
import { saveRun } from "../../../extensions/loop/run-store.ts";

const DEFINED = [{ type: "predicate_defined", predicate: "ci green" }];
const RESUMED = [...DEFINED, { type: "heartbeat" }];
const ACTING = [...RESUMED, { type: "iteration_started", action: "smallest change" }];
const VERIFYING = [...ACTING, { type: "verification_started" }];
const CHECKPOINTED = [
  ...VERIFYING,
  { type: "iteration_verified", verification: "npm test", evidence: "exit 0" },
  { type: "checkpoint" },
  { type: "predicate_checked" },
];

function seeded(runId, steps, now = 1000) {
  return steps.reduce((record, event) => reduceRun(record, event, now).record, initialRecord({ runId, now }));
}

function runTool(f) {
  const tool = f.tool("pstack_run");
  assert.ok(tool, "pstack_run is registered by the loaded extension");
  const ctx = { ui: f.ui.context };
  return (params) => tool.definition.execute("probe", params, undefined, undefined, ctx);
}

function calls(f) {
  const dir = join(f.tmp.cwd, "runs");
  process.env.PSTACK_RUNS_DIR = dir;
  return { dir, call: runTool(f) };
}

test("loaded instance arms a run and reports the literal store path line", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    const armed = await call({ action: "arm", runId: "it-arm", predicate: "ci green", intervalSeconds: 60, maxFires: 4 });
    assert.equal(armed.details.run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
    assert.equal(armed.details.run.maxFires, 4);
    assert.equal(
      armed.content[0].text,
      "it-arm phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/4 predicate=ci green\nrun it-arm predicate defined: ci green",
    );
    const listed = await call({ action: "list" });
    assert.equal(listed.content[0].text, "it-arm phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/4 predicate=ci green");
    const state = await call({ action: "state", runId: "it-arm" });
    assert.equal(state.details.run.predicate, "ci green");
    const stopped = await call({ action: "stop", runId: "it-arm" });
    assert.equal(stopped.content[0].text, "stopped it-arm");
  });
});

test("loaded instance rejects the documented invalid arm inputs with literal messages", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    await assert.rejects(() => call({ action: "arm", intervalSeconds: 30 }), /predicate required to arm a run/);
    await assert.rejects(() => call({ action: "arm", predicate: "ci green" }), /intervalSeconds required to arm a run/);
    await assert.rejects(() => call({ action: "state", runId: "it-missing" }), /unknown run it-missing/);
    await assert.rejects(() => call({ action: "nope" }), /action must be arm\|state\|iterate/);
  });
});

test("loaded instance refuses a traversal runId without arming a loop or writing a record", async () => {
  await withSession(async (f) => {
    const { call, dir } = calls(f);
    await assert.rejects(
      () => call({ action: "arm", runId: "../evil", predicate: "ci green", intervalSeconds: 30 }),
      /invalid runId: \.\.\/evil/,
    );
    const loop = f.tool("pstack_loop");
    const status = await loop.definition.execute("probe", { action: "status" }, undefined, undefined, {
      ui: f.ui.context,
    });
    assert.equal(status.content[0].text, "(no active loops)");
    const stored = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
    assert.deepEqual(stored, []);
  });
});

test("loaded instance iterate on a freshly armed run is ignored and advances once resumed", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    await call({ action: "arm", runId: "it-wait", predicate: "ci green", intervalSeconds: 30 });
    const ignored = await call({ action: "iterate", runId: "it-wait", step: "try" });
    assert.equal(ignored.details.run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
    assert.equal(ignored.details.run.iterations.length, 0);
    assert.deepEqual(ignored.details.effects, []);
    assert.deepEqual(ignored.details.ignored, [
      { event: "iteration_started", phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" },
    ]);
    assert.match(ignored.content[0].text, /ignored iteration_started in phase WAIT_FOR_EVENT_OR_HEARTBEAT/);
    saveRun(seeded("it-go", RESUMED));
    const opened = await call({ action: "iterate", runId: "it-go", step: "patch the reducer" });
    assert.equal(opened.details.run.phase, "ACT");
    assert.equal(opened.details.run.iterations[0].action, "patch the reducer");
    assert.equal(opened.details.run.iterations[0].n, 1);
    assert.deepEqual(opened.details.ignored, []);
  });
});

test("loaded instance names the ignored event and phase for every out-of-phase action", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    const cases = [
      [{ action: "iterate", step: "try" }, "iteration_started"],
      [{ action: "verify", evidence: "green" }, "iteration_verified"],
      [{ action: "discard", reason: "flat" }, "iteration_discarded"],
      [{ action: "inconclusive", reason: "unclear" }, "iteration_inconclusive"],
      [{ action: "checkpoint" }, "checkpoint"],
    ];
    for (const [params, event] of cases) {
      await call({ action: "arm", runId: "it-ignore", predicate: "ci green", intervalSeconds: 30 });
      const result = await call({ runId: "it-ignore", ...params });
      assert.equal(result.details.run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
      assert.deepEqual(result.details.ignored, [{ event, phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" }]);
      assert.match(result.content[0].text, new RegExp(`ignored ${event} in phase WAIT_FOR_EVENT_OR_HEARTBEAT`));
    }
  });
});

test("loaded instance verify advances, then the checkpoint chain completes the run", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    saveRun(seeded("it-verify", VERIFYING));
    await assert.rejects(() => call({ action: "verify", runId: "it-verify" }), /evidence required to verify an iteration/);
    const advanced = await call({ action: "verify", runId: "it-verify", evidence: "exit 0", verification: "npm test" });
    assert.equal(advanced.details.run.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
    assert.equal(advanced.details.run.iterations[0].verdict, "advanced");
    assert.equal(advanced.details.run.iterations[0].verification, "npm test");
    const checkpointed = await call({ action: "checkpoint", runId: "it-verify" });
    assert.equal(checkpointed.details.run.phase, "CHECKPOINT");
    const checked = await call({ action: "checkpoint", runId: "it-verify" });
    assert.equal(checked.details.run.phase, "CHECK_PREDICATE");
    const unmet = await call({ action: "checkpoint", runId: "it-verify" });
    assert.equal(unmet.details.run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
  });
});

test("loaded instance verify predicateMet completes the run and stops the armed loop", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    await call({ action: "arm", runId: "it-done", predicate: "ci green", intervalSeconds: 30 });
    saveRun({ ...seeded("it-done", ACTING), updatedAt: 2000 });
    const done = await call({ action: "verify", runId: "it-done", evidence: "checks green", predicateMet: true });
    assert.equal(done.details.run.phase, "COMPLETE");
    assert.equal(typeof done.details.run.completedAt, "number");
    assert.match(done.content[0].text, /run it-done COMPLETE: predicate met with evidence/);
    const loop = f.tool("pstack_loop");
    const listed = await loop.definition.execute("probe", { action: "list" }, undefined, undefined, { ui: f.ui.context });
    assert.equal(listed.content[0].text, "(no active loops)");
  });
});

test("loaded instance discard, inconclusive, blocked and handoff record their literal reasons", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    saveRun(seeded("it-discard", ACTING));
    const discarded = await call({ action: "discard", runId: "it-discard", reason: "metric flat", evidence: "flat" });
    assert.equal(discarded.details.run.iterations[0].verdict, "discarded");
    assert.equal(discarded.details.run.consecutiveDiscards, 1);
    assert.match(discarded.content[0].text, /discarded: metric flat/);
    saveRun(seeded("it-incon", ACTING));
    const inconclusive = await call({ action: "inconclusive", runId: "it-incon", reason: "ambiguous" });
    assert.equal(inconclusive.details.run.iterations[0].verdict, "inconclusive");
    assert.match(inconclusive.content[0].text, /inconclusive: ambiguous/);
    saveRun(seeded("it-blocked", RESUMED));
    const blocked = await call({ action: "blocked", runId: "it-blocked", reason: "awaiting review" });
    assert.equal(blocked.details.run.phase, "BLOCKED");
    assert.equal(blocked.details.run.blockedReason, "awaiting review");
    saveRun(seeded("it-handoff", RESUMED));
    const handed = await call({ action: "handoff", runId: "it-handoff", endpoint: "https://worker.example" });
    assert.equal(handed.details.run.phase, "BLOCKED");
    assert.deepEqual(handed.details.run.remote, { required: true, handedOff: true, endpoint: "https://worker.example" });
    await assert.rejects(() => call({ action: "blocked", runId: "it-handoff" }), /reason required to mark a run blocked/);
    await assert.rejects(() => call({ action: "handoff", runId: "it-handoff" }), /endpoint required for a hosted handoff/);
  });
});
