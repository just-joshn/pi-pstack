import { expect, test } from "vitest";
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
  expect(tool, "pstack_run is registered by the loaded extension").toBeTruthy();
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
    expect(armed.details.run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
    expect(armed.details.run.maxFires).toBe(4);
    expect(armed.content[0].text).toBe("it-arm phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/4 predicate=ci green\nrun it-arm predicate defined: ci green");
    const listed = await call({ action: "list" });
    expect(listed.content[0].text).toBe("it-arm phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/4 predicate=ci green");
    const state = await call({ action: "state", runId: "it-arm" });
    expect(state.details.run.predicate).toBe("ci green");
    const stopped = await call({ action: "stop", runId: "it-arm" });
    expect(stopped.content[0].text).toBe("stopped it-arm");
  });
});

test("loaded instance rejects the documented invalid arm inputs with literal messages", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    await expect(() => call({ action: "arm", intervalSeconds: 30 })).rejects.toThrow(/predicate required to arm a run/);
    await expect(() => call({ action: "arm", predicate: "ci green" })).rejects.toThrow(/intervalSeconds required to arm a run/);
    await expect(() => call({ action: "state", runId: "it-missing" })).rejects.toThrow(/unknown run it-missing/);
    await expect(() => call({ action: "nope" })).rejects.toThrow(/action must be arm\|state\|iterate/);
  });
});

test("loaded instance refuses a traversal runId without arming a loop or writing a record", async () => {
  await withSession(async (f) => {
    const { call, dir } = calls(f);
    await expect(() => call({ action: "arm", runId: "../evil", predicate: "ci green", intervalSeconds: 30 })).rejects.toThrow(/invalid runId: \.\.\/evil/);
    const loop = f.tool("pstack_loop");
    const status = await loop.definition.execute("probe", { action: "status" }, undefined, undefined, {
      ui: f.ui.context,
    });
    expect(status.content[0].text).toBe("(no active loops)");
    const stored = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
    expect(stored).toEqual([]);
  });
});

test("loaded instance iterate on a freshly armed run is ignored and advances once resumed", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    await call({ action: "arm", runId: "it-wait", predicate: "ci green", intervalSeconds: 30 });
    const ignored = await call({ action: "iterate", runId: "it-wait", step: "try" });
    expect(ignored.details.run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
    expect(ignored.details.run.iterations.length).toBe(0);
    expect(ignored.details.effects).toEqual([]);
    expect(ignored.details.ignored).toEqual([
      { event: "iteration_started", phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" },
    ]);
    expect(ignored.content[0].text).toMatch(/ignored iteration_started in phase WAIT_FOR_EVENT_OR_HEARTBEAT/);
    saveRun(seeded("it-go", RESUMED));
    const opened = await call({ action: "iterate", runId: "it-go", step: "patch the reducer" });
    expect(opened.details.run.phase).toBe("ACT");
    expect(opened.details.run.iterations[0].action).toBe("patch the reducer");
    expect(opened.details.run.iterations[0].n).toBe(1);
    expect(opened.details.ignored).toEqual([]);
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
      expect(result.details.run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
      expect(result.details.ignored).toEqual([{ event, phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" }]);
      expect(result.content[0].text).toMatch(new RegExp(`ignored ${event} in phase WAIT_FOR_EVENT_OR_HEARTBEAT`));
    }
  });
});

test("loaded instance verify advances, then the checkpoint chain completes the run", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    saveRun(seeded("it-verify", VERIFYING));
    await expect(() => call({ action: "verify", runId: "it-verify" })).rejects.toThrow(/evidence required to verify an iteration/);
    const advanced = await call({ action: "verify", runId: "it-verify", evidence: "exit 0", verification: "npm test" });
    expect(advanced.details.run.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
    expect(advanced.details.run.iterations[0].verdict).toBe("advanced");
    expect(advanced.details.run.iterations[0].verification).toBe("npm test");
    const checkpointed = await call({ action: "checkpoint", runId: "it-verify" });
    expect(checkpointed.details.run.phase).toBe("CHECKPOINT");
    const checked = await call({ action: "checkpoint", runId: "it-verify" });
    expect(checked.details.run.phase).toBe("CHECK_PREDICATE");
    const unmet = await call({ action: "checkpoint", runId: "it-verify" });
    expect(unmet.details.run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
  });
});

test("loaded instance verify predicateMet completes the run and stops the armed loop", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    await call({ action: "arm", runId: "it-done", predicate: "ci green", intervalSeconds: 30 });
    saveRun({ ...seeded("it-done", ACTING), updatedAt: 2000 });
    const done = await call({ action: "verify", runId: "it-done", evidence: "checks green", predicateMet: true });
    expect(done.details.run.phase).toBe("COMPLETE");
    expect(typeof done.details.run.completedAt).toBe("number");
    expect(done.content[0].text).toMatch(/run it-done COMPLETE: predicate met with evidence/);
    const loop = f.tool("pstack_loop");
    const listed = await loop.definition.execute("probe", { action: "list" }, undefined, undefined, { ui: f.ui.context });
    expect(listed.content[0].text).toBe("(no active loops)");
  });
});

test("loaded instance discard, inconclusive, blocked and handoff record their literal reasons", async () => {
  await withSession(async (f) => {
    const { call } = calls(f);
    saveRun(seeded("it-discard", ACTING));
    const discarded = await call({ action: "discard", runId: "it-discard", reason: "metric flat", evidence: "flat" });
    expect(discarded.details.run.iterations[0].verdict).toBe("discarded");
    expect(discarded.details.run.consecutiveDiscards).toBe(1);
    expect(discarded.content[0].text).toMatch(/discarded: metric flat/);
    saveRun(seeded("it-incon", ACTING));
    const inconclusive = await call({ action: "inconclusive", runId: "it-incon", reason: "ambiguous" });
    expect(inconclusive.details.run.iterations[0].verdict).toBe("inconclusive");
    expect(inconclusive.content[0].text).toMatch(/inconclusive: ambiguous/);
    saveRun(seeded("it-blocked", RESUMED));
    const blocked = await call({ action: "blocked", runId: "it-blocked", reason: "awaiting review" });
    expect(blocked.details.run.phase).toBe("BLOCKED");
    expect(blocked.details.run.blockedReason).toBe("awaiting review");
    saveRun(seeded("it-handoff", RESUMED));
    const handed = await call({ action: "handoff", runId: "it-handoff", endpoint: "https://worker.example" });
    expect(handed.details.run.phase).toBe("BLOCKED");
    expect(handed.details.run.remote).toEqual({ required: true, handedOff: true, endpoint: "https://worker.example" });
    await expect(() => call({ action: "blocked", runId: "it-handoff" })).rejects.toThrow(/reason required to mark a run blocked/);
    await expect(() => call({ action: "handoff", runId: "it-handoff" })).rejects.toThrow(/endpoint required for a hosted handoff/);
  });
});
