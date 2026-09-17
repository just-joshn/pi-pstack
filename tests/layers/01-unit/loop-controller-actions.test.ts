import { expect, test } from "vitest";
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

function runOf(result: LooseResult): {
  run: RunRecord;
  effects: Array<{ type: string; message?: string }>;
  ignored: Array<{ event: string; phase: string }>;
} {
  return result.details as unknown as {
    run: RunRecord;
    effects: Array<{ type: string; message?: string }>;
    ignored: Array<{ event: string; phase: string }>;
  };
}

function seeded(runId: string, steps: RunEvent[], now = 1000): RunRecord {
  const base = initialRecord({ runId, now });
  return steps.reduce((record, event) => reduceRun(record, event, now).record, base);
}

const DEFINED: RunEvent[] = [{ type: "predicate_defined", predicate: "ci green" }];
const RESUMED: RunEvent[] = [...DEFINED, { type: "heartbeat" }];
const ACTING: RunEvent[] = [...RESUMED, { type: "iteration_started", action: "smallest change" }];
const VERIFYING: RunEvent[] = [...ACTING, { type: "verification_started" }];
const COMMITTED: RunEvent[] = [...VERIFYING, { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }];
const CHECKPOINTED: RunEvent[] = [...COMMITTED, { type: "checkpoint" }, { type: "predicate_checked" }];

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
    expect(run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
    expect(run.predicate).toBe("ci green");
    expect(run.maxFires).toBe(7);
    expect(run.plateauLimit).toBe(5);
    expect(run.remote).toEqual({ required: true, handedOff: false });
    expect(run.fires).toBe(0);
    expect(run.iterations.length).toBe(0);
    expect(effects).toEqual([{ type: "notify", message: "run run-arm predicate defined: ci green" }]);
    expect(textOf(result)).toBe("run-arm phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/7 predicate=ci green\nrun run-arm predicate defined: ci green");
    expect(env.sent()).toEqual([]);
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
    expect(run.runId).toMatch(/^run-[0-9a-z]+-[0-9a-z]{6}$/);
    expect(run.maxFires).toBe(50);
    expect(run.plateauLimit).toBe(3);
    expect(run.remote).toEqual({ required: false, handedOff: false });
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
    expect(textOf(listed)).toBe("run-watch mode=dynamic fires=0/50 armed=true lastReason=-");
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
    expect(textOf(listed)).toMatch(/run-settle mode=settle/);
  } finally {
    cleanup();
  }
});

test("arm rejects a missing predicate, a non-numeric interval, and an unknown runId", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await expect(() => env.run({ action: "arm", intervalSeconds: 30 })).rejects.toThrow(/predicate required to arm a run/);
    await expect(() => env.run({ action: "arm", predicate: "ci green", intervalSeconds: "30" })).rejects.toThrow(/intervalSeconds required to arm a run/);
    await expect(() => env.run({ action: "iterate", runId: "run-nope" })).rejects.toThrow(/unknown run run-nope/);
    await expect(() => env.run({ action: "iterate" })).rejects.toThrow(/runId required for this action/);
    await expect(() => env.run({ action: "mystery" })).rejects.toThrow(/action must be arm\|state\|iterate\|verify\|discard\|inconclusive\|checkpoint\|blocked\|handoff\|stop\|list/);
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
    expect(runOf(byId).run.runId).toBe("run-old");
    expect(runOf(byId).effects).toEqual([]);
    const latest = await env.run({ action: "state" });
    expect(runOf(latest).run.runId).toBe("run-new");
    await expect(() => env.run({ action: "state", runId: "run-absent" })).rejects.toThrow(/unknown run run-absent/);
  } finally {
    cleanup();
  }
});

test("state with no runs recorded refuses instead of inventing a record", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await expect(() => env.run({ action: "state" })).rejects.toThrow(/no runs recorded/);
    const listed = await env.run({ action: "list" });
    expect(textOf(listed)).toBe("(no runs)");
    expect(listed.details).toEqual({ runs: [], count: 0 });
  } finally {
    cleanup();
  }
});

test("iterate from WAIT reports the ignored event and phase instead of a silent no-op", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    await env.run({ action: "arm", runId: "run-wait", predicate: "ci green", intervalSeconds: 30 });
    const result = await env.run({ action: "iterate", runId: "run-wait", step: "smallest change" });
    const { run, effects, ignored } = runOf(result);
    expect(run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
    expect(run.iterations.length).toBe(0);
    expect(effects).toEqual([]);
    expect(ignored).toEqual([{ event: "iteration_started", phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" }]);
    expect(textOf(result)).toBe("run-wait phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/50 predicate=ci green\nignored iteration_started in phase WAIT_FOR_EVENT_OR_HEARTBEAT");
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
    expect(run.phase).toBe("ACT");
    expect(run.iterations.length).toBe(1);
    expect(run.iterations[0]?.action).toBe("patch the reducer");
    expect(run.iterations[0]?.n).toBe(1);
    expect(run.iterations[0]?.verdict).toBe("inconclusive");
    expect(run.iterations[0]?.endedAt).toEqual(undefined);
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
    expect(runOf(fromReason).run.iterations[0]?.action).toBe("because");
    saveRun(seeded("run-default", RESUMED));
    const fallback = await env.run({ action: "iterate", runId: "run-default" });
    expect(runOf(fallback).run.iterations[0]?.action).toBe("iterate");
  } finally {
    cleanup();
  }
});

test("verify requires evidence and records the verification with an optional commit", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-verify", VERIFYING));
    await expect(() => env.run({ action: "verify", runId: "run-verify" })).rejects.toThrow(/evidence required to verify an iteration/);
    const result = await env.run({
      action: "verify",
      runId: "run-verify",
      evidence: "exit 0",
      verification: "npm test",
      commit: "abc1234",
    });
    const { run, effects } = runOf(result);
    expect(run.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
    expect(run.iterations[0]?.verdict).toBe("advanced");
    expect(run.iterations[0]?.verification).toBe("npm test");
    expect(run.iterations[0]?.evidence).toBe("exit 0");
    expect(run.iterations[0]?.commit).toBe("abc1234");
    expect(run.consecutiveDiscards).toBe(0);
    expect(effects).toEqual([{ type: "notify", message: "run run-verify iteration 1 advanced" }]);
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
    expect(iteration?.verification).toBe("verify");
    expect(iteration?.commit).toBe(undefined);
    expect("commit" in (iteration ?? {})).toBe(false);
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
    expect(run.phase).toBe("COMPLETE");
    expect(typeof run.completedAt).toBe("number");
    expect(effects.map((effect) => effect.type)).toEqual(["notify", "notify", "notify", "stop"]);
    expect(effects.filter((effect) => effect.type === "notify").map((effect) => effect.message)).toEqual([
        "run run-done iteration 1 advanced",
        "run run-done checkpoint written at iteration 1",
        "run run-done COMPLETE: predicate met with evidence",
      ]);
    expect(runOf(result).ignored).toEqual([]);
    expect(run.iterations[0]?.verdict).toBe("advanced");
    expect(textOf(result)).toMatch(/run run-done COMPLETE: predicate met with evidence/);
    const listed = await env.loopTool.execute("t", { action: "list" }, undefined, undefined, env.ctx);
    expect(textOf(listed)).toBe("(no active loops)");
  } finally {
    cleanup();
  }
});

test("verify predicateMet from CHECK_PREDICATE skips the repeated checkpoint", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-at-check", CHECKPOINTED));
    expect(loadRun("run-at-check")?.phase).toBe("CHECK_PREDICATE");
    const result = await env.run({
      action: "verify",
      runId: "run-at-check",
      evidence: "checks green",
      predicateMet: true,
    });
    expect(runOf(result).run.phase).toBe("COMPLETE");
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
    expect(run.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
    expect(run.iterations[0]?.verdict).toBe("discarded");
    expect(run.iterations[0]?.evidence).toBe("flat");
    expect(run.consecutiveDiscards).toBe(1);
    expect(effects).toEqual([{ type: "notify", message: "run run-discard iteration 1 discarded: metric flat" }]);
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
    expect(runOf(discarded).run.iterations[0]?.evidence).toBe("");
    expect(textOf(discarded)).toMatch(/discarded: no improvement/);
    saveRun(seeded("run-incon", ACTING));
    const inconclusive = await env.run({ action: "inconclusive", runId: "run-incon", reason: "ambiguous" });
    const run = runOf(inconclusive).run;
    expect(run.iterations[0]?.verdict).toBe("inconclusive");
    expect(run.consecutiveDiscards).toBe(1);
    expect(textOf(inconclusive)).toMatch(/inconclusive: ambiguous/);
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
    expect(runOf(first).run.phase).toBe("CHECKPOINT");
    const second = await env.run({ action: "checkpoint", runId: "run-cp" });
    expect(runOf(second).run.phase).toBe("CHECK_PREDICATE");
    const third = await env.run({ action: "checkpoint", runId: "run-cp" });
    expect(runOf(third).run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
    expect(textOf(third)).toMatch(/predicate unresolved; waiting for event or heartbeat/);
    const fourth = await env.run({ action: "checkpoint", runId: "run-cp" });
    expect(runOf(fourth).run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
    expect(runOf(fourth).effects).toEqual([]);
    expect(runOf(fourth).ignored).toEqual([{ event: "checkpoint", phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" }]);
    expect(textOf(fourth)).toMatch(/ignored checkpoint in phase WAIT_FOR_EVENT_OR_HEARTBEAT/);
  } finally {
    cleanup();
  }
});

test("every out-of-phase action names the ignored event and the phase without raising", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "iterate", step: "try" }, "iteration_started"],
      [{ action: "verify", evidence: "green" }, "iteration_verified"],
      [{ action: "discard", reason: "flat" }, "iteration_discarded"],
      [{ action: "inconclusive", reason: "unclear" }, "iteration_inconclusive"],
      [{ action: "checkpoint" }, "checkpoint"],
    ];
    const summary = "run-ignore phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/50 predicate=ci green";
    for (const [params, event] of cases) {
      await env.run({ action: "arm", runId: "run-ignore", predicate: "ci green", intervalSeconds: 30 });
      const result = await env.run({ runId: "run-ignore", ...params });
      expect(runOf(result).run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
      expect(runOf(result).effects).toEqual([]);
      expect(runOf(result).ignored).toEqual([{ event, phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" }]);
      expect(textOf(result)).toBe(`${summary}\nignored ${event} in phase WAIT_FOR_EVENT_OR_HEARTBEAT`);
    }
  } finally {
    cleanup();
  }
});

test("a terminal run names the terminal phase for every action it refuses", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-over", [...CHECKPOINTED, { type: "predicate_met", evidence: "ci green" }]));
    expect(loadRun("run-over")?.phase).toBe("COMPLETE");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "iterate", step: "again" }, "iteration_started"],
      [{ action: "verify", evidence: "green" }, "iteration_verified"],
      [{ action: "discard", reason: "flat" }, "iteration_discarded"],
      [{ action: "inconclusive", reason: "unclear" }, "iteration_inconclusive"],
      [{ action: "checkpoint" }, "checkpoint"],
      [{ action: "blocked", reason: "gave up" }, "mark_blocked"],
      [{ action: "handoff", endpoint: "https://worker.example" }, "handoff_requested"],
    ];
    for (const [params, event] of cases) {
      const result = await env.run({ runId: "run-over", ...params });
      expect(runOf(result).run.phase).toBe("COMPLETE");
      expect(runOf(result).effects).toEqual([]);
      expect(runOf(result).ignored).toEqual([{ event, phase: "COMPLETE" }]);
    }
    const last = await env.run({ action: "iterate", runId: "run-over", step: "again" });
    expect(textOf(last)).toBe("run-over phase=COMPLETE iterations=1 discards=0 fires=1/50 predicate=ci green\nignored iteration_started in phase COMPLETE");
  } finally {
    cleanup();
  }
});

test("verify predicateMet from CHECKPOINT completes and groups the ignored events by phase", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-cp-verify", [...VERIFYING, { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, { type: "checkpoint" }]));
    expect(loadRun("run-cp-verify")?.phase).toBe("CHECKPOINT");
    const result = await env.run({
      action: "verify",
      runId: "run-cp-verify",
      evidence: "checks green",
      predicateMet: true,
    });
    expect(runOf(result).run.phase).toBe("COMPLETE");
    expect(runOf(result).ignored).toEqual([
      { event: "iteration_verified", phase: "CHECKPOINT" },
      { event: "checkpoint", phase: "CHECKPOINT" },
    ]);
    expect(textOf(result)).toBe("run-cp-verify phase=COMPLETE iterations=1 discards=0 fires=1/50 predicate=ci green\nrun run-cp-verify COMPLETE: predicate met with evidence\nignored iteration_verified, checkpoint in phase CHECKPOINT");
  } finally {
    cleanup();
  }
});

test("blocked requires a reason and records it literally", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-block", RESUMED));
    await expect(() => env.run({ action: "blocked", runId: "run-block" })).rejects.toThrow(/reason required to mark a run blocked/);
    const result = await env.run({ action: "blocked", runId: "run-block", reason: "awaiting review" });
    const { run, effects } = runOf(result);
    expect(run.phase).toBe("BLOCKED");
    expect(run.blockedReason).toBe("awaiting review");
    expect(effects.map((effect) => effect.type)).toEqual(["notify", "stop"]);
    expect(textOf(result)).toMatch(/blockedReason: awaiting review/);
  } finally {
    cleanup();
  }
});

test("handoff requires an endpoint and marks the run blocked with a recorded handoff", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    saveRun(seeded("run-handoff", RESUMED));
    await expect(() => env.run({ action: "handoff", runId: "run-handoff" })).rejects.toThrow(/endpoint required for a hosted handoff/);
    const result = await env.run({
      action: "handoff",
      runId: "run-handoff",
      endpoint: "https://worker.example",
    });
    const { run, effects } = runOf(result);
    expect(run.phase).toBe("BLOCKED");
    expect(run.remote).toEqual({ required: true, handedOff: true, endpoint: "https://worker.example" });
    expect(effects.map((effect) => effect.type)).toEqual(["handoff", "notify"]);
    expect(env.notifications()).toEqual([
      "run run-handoff hosted handoff recorded for https://worker.example; no local continuation",
      "run run-handoff handed off to https://worker.example; BLOCKED locally until the hosted worker exists",
    ]);
    expect(env.sent()).toEqual([]);
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
    expect(textOf(armed)).toBe("stopped run-stop");
    expect(armed.details).toEqual({ runId: "run-stop", stopped: true });
    const again = await env.run({ action: "stop", runId: "run-stop" });
    expect(textOf(again)).toBe("no armed loop for run-stop");
    expect(again.details).toEqual({ runId: "run-stop", stopped: false });
    const listed = await env.run({ action: "list" });
    expect(textOf(listed)).toBe("run-stop phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/50 predicate=ci green");
    expect(listed.details.count).toBe(1);
  } finally {
    cleanup();
  }
});

test("no action is a silent no-op in any phase", async () => {
  const cleanup = scopedRuns();
  try {
    const env = fakeEnv();
    const actions: Array<[string, Record<string, unknown>]> = [
      ["iterate", { action: "iterate", step: "try" }],
      ["verify", { action: "verify", evidence: "green" }],
      ["discard", { action: "discard", reason: "flat" }],
      ["inconclusive", { action: "inconclusive", reason: "unclear" }],
      ["checkpoint", { action: "checkpoint" }],
      ["blocked", { action: "blocked", reason: "give up" }],
      ["handoff", { action: "handoff", endpoint: "https://worker.example" }],
    ];
    const seeds: Array<[string, RunEvent[]]> = [
      ["DEFINE_PREDICATE", []],
      ["WAIT_FOR_EVENT_OR_HEARTBEAT", DEFINED],
      ["RESUME_OR_START_ITERATION", RESUMED],
      ["ACT", ACTING],
      ["VERIFY", VERIFYING],
      ["COMMIT_IF_ADVANCED_OR_DISCARD", COMMITTED],
      ["CHECKPOINT", COMMITTED.concat([{ type: "checkpoint" }])],
      ["CHECK_PREDICATE", CHECKPOINTED],
      ["COMPLETE", CHECKPOINTED.concat([{ type: "predicate_met", evidence: "ci green" }])],
      ["BLOCKED", [{ type: "mark_blocked", reason: "upstream gone" }]],
    ];
    for (const [phase, steps] of seeds) {
      for (const [name, params] of actions) {
        saveRun(seeded("run-matrix", steps));
        expect(loadRun("run-matrix")?.phase).toBe(phase);
        const result = await env.run({ runId: "run-matrix", ...params });
        const advanced = runOf(result).run.phase !== phase;
        const reported = runOf(result).effects.length + runOf(result).ignored.length;
        expect(advanced || reported > 0, `${name} from ${phase} was a silent no-op`).toBeTruthy();
      }
    }
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
    expect(runOf(blocked).run.phase).toBe("BLOCKED");
    env.shutdown();
    expect(loadRun("run-live")?.phase).toBe("BLOCKED");
    expect(loadRun("run-live")?.blockedReason).toBe("local runtime session ended without completion; hand off to a hosted worker or re-arm");
    expect(loadRun("run-done")?.blockedReason).toBe("already done");
    const listed = await env.loopTool.execute("t", { action: "list" }, undefined, undefined, env.ctx);
    expect(textOf(listed)).toBe("(no active loops)");
  } finally {
    cleanup();
  }
});
