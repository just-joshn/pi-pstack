import { expect, test } from "vitest";
import {
  initialRecord,
  reduceRun,
  RUN_PHASES,
  type RunEvent,
  type RunRecord,
} from "../../../extensions/loop/fsm.ts";

const NOW = 1_700_000_000_000;

function fresh(overrides: { plateauLimit?: number; remoteRequired?: boolean } = {}): RunRecord {
  return initialRecord({ runId: "run-test", now: NOW, ...overrides });
}

function defined(record: RunRecord = fresh()): RunRecord {
  return reduceRun(record, { type: "predicate_defined", predicate: "ci green" }, NOW).record;
}

function resumed(record: RunRecord): RunRecord {
  if (record.phase === "WAIT_FOR_EVENT_OR_HEARTBEAT") {
    return reduceRun(record, { type: "heartbeat" }, NOW).record;
  }
  const checkpointed = reduceRun(record, { type: "checkpoint" }, NOW).record;
  const checked = reduceRun(checkpointed, { type: "predicate_checked" }, NOW).record;
  const waiting = reduceRun(checked, { type: "predicate_unmet" }, NOW).record;
  return reduceRun(waiting, { type: "heartbeat" }, NOW).record;
}

function acting(record: RunRecord): RunRecord {
  const resumedRun = resumed(record);
  const act = reduceRun(resumedRun, { type: "iteration_started", action: "smallest change" }, NOW).record;
  return reduceRun(act, { type: "verification_started" }, NOW).record;
}

function atPredicateCheck(record: RunRecord = defined()): RunRecord {
  const verify = acting(record);
  const advanced = reduceRun(verify, { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, NOW).record;
  const checkpointed = reduceRun(advanced, { type: "checkpoint" }, NOW).record;
  return reduceRun(checkpointed, { type: "predicate_checked" }, NOW).record;
}

function discard(record: RunRecord): RunRecord {
  const verify = acting(record);
  return reduceRun(verify, { type: "iteration_discarded", reason: "metric flat", evidence: "flat" }, NOW).record;
}

test("RUN_PHASES lists the mandated controller phases in order", () => {
  expect([...RUN_PHASES]).toEqual([
    "DEFINE_PREDICATE",
    "WAIT_FOR_EVENT_OR_HEARTBEAT",
    "RESUME_OR_START_ITERATION",
    "ACT",
    "VERIFY",
    "COMMIT_IF_ADVANCED_OR_DISCARD",
    "CHECKPOINT",
    "CHECK_PREDICATE",
    "COMPLETE",
    "BLOCKED",
  ]);
});

test("predicate_defined moves DEFINE_PREDICATE to WAIT_FOR_EVENT_OR_HEARTBEAT", () => {
  const base = fresh();
  expect(base.phase).toBe("DEFINE_PREDICATE");
  const result = reduceRun(base, { type: "predicate_defined", predicate: "ci green" }, NOW);
  expect(result.record.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
  expect(result.record.predicate).toBe("ci green");
  expect(result.record.updatedAt).toBe(NOW);
  expect(result.effects).toEqual([{ type: "notify", message: "run run-test predicate defined: ci green" }]);
});

test("predicate_defined refuses to relax an already defined predicate", () => {
  const waiting = defined();
  const result = reduceRun(waiting, { type: "predicate_defined", predicate: "anything goes" }, NOW + 1);
  expect(result.record.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
  expect(result.record.predicate).toBe("ci green");
});

test("heartbeat moves WAIT_FOR_EVENT_OR_HEARTBEAT to RESUME_OR_START_ITERATION and counts a fire", () => {
  const result = reduceRun(defined(), { type: "heartbeat" }, NOW);
  expect(result.record.phase).toBe("RESUME_OR_START_ITERATION");
  expect(result.record.fires).toBe(1);
  expect(result.effects).toEqual([{ type: "wake", reason: "heartbeat" }]);
});

test("event_wake records the event id and wakes with the event reason", () => {
  const result = reduceRun(defined(), { type: "event_wake", eventId: "evt-1", reason: "ci finished" }, NOW);
  expect(result.record.phase).toBe("RESUME_OR_START_ITERATION");
  expect(result.record.eventIds).toEqual(["evt-1"]);
  expect(result.record.lastEventId).toBe("evt-1");
  expect(result.effects).toEqual([{ type: "wake", reason: "ci finished" }]);
});

test("a duplicate event_wake with the same event id is a no-op", () => {
  const first = reduceRun(defined(), { type: "event_wake", eventId: "evt-1", reason: "ci" }, NOW);
  const duplicate = reduceRun(first.record, { type: "event_wake", eventId: "evt-1", reason: "ci" }, NOW + 5);
  expect(duplicate.record).toBe(first.record);
  expect(duplicate.effects).toEqual([]);
});

test("iteration_started moves RESUME_OR_START_ITERATION to ACT with an open iteration", () => {
  const result = reduceRun(resumed(defined()), { type: "iteration_started", action: "smallest change" }, NOW);
  expect(result.record.phase).toBe("ACT");
  expect(result.record.iterations.length).toBe(1);
  expect(result.record.iterations.at(0)).toEqual({
    n: 1,
    startedAt: NOW,
    action: "smallest change",
    verification: "",
    verdict: "inconclusive",
    evidence: "",
  });
});

test("verification_started moves ACT to VERIFY", () => {
  const act = reduceRun(resumed(defined()), { type: "iteration_started", action: "change" }, NOW).record;
  const result = reduceRun(act, { type: "verification_started" }, NOW);
  expect(result.record.phase).toBe("VERIFY");
});

test("iteration_verified closes the open iteration as advanced and resets discards", () => {
  const verify = acting(defined());
  const result = reduceRun(verify, { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, NOW + 10);
  expect(result.record.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
  expect(result.record.consecutiveDiscards).toBe(0);
  expect(result.record.iterations.at(-1)?.verdict).toBe("advanced");
  expect(result.record.iterations.at(-1)?.evidence).toBe("exit 0");
  expect(result.record.iterations.at(-1)?.endedAt).toBe(NOW + 10);
});

test("iteration_discarded increments consecutiveDiscards and lands in COMMIT_IF_ADVANCED_OR_DISCARD", () => {
  const result = reduceRun(acting(defined()), { type: "iteration_discarded", reason: "flat", evidence: "no gain" }, NOW);
  expect(result.record.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
  expect(result.record.consecutiveDiscards).toBe(1);
  expect(result.record.iterations.at(-1)?.verdict).toBe("discarded");
});

test("checkpoint moves COMMIT_IF_ADVANCED_OR_DISCARD to CHECKPOINT", () => {
  const committed = reduceRun(acting(defined()), { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, NOW).record;
  const result = reduceRun(committed, { type: "checkpoint" }, NOW);
  expect(result.record.phase).toBe("CHECKPOINT");
});

test("predicate_checked moves CHECKPOINT to CHECK_PREDICATE", () => {
  const committed = reduceRun(acting(defined()), { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, NOW).record;
  const checkpointed = reduceRun(committed, { type: "checkpoint" }, NOW).record;
  const result = reduceRun(checkpointed, { type: "predicate_checked" }, NOW);
  expect(result.record.phase).toBe("CHECK_PREDICATE");
});

test("predicate_met with evidence completes the run", () => {
  const checked = atPredicateCheck();
  expect(checked.phase).toBe("CHECK_PREDICATE");
  const result = reduceRun(checked, { type: "predicate_met", evidence: "ci green on shasum abc" }, NOW + 1);
  expect(result.record.phase).toBe("COMPLETE");
  expect(result.record.completedAt).toBe(NOW + 1);
  expect(result.effects.at(-1)).toEqual({ type: "stop" });
});

test("predicate_met without evidence never completes", () => {
  const checked = atPredicateCheck();
  const result = reduceRun(checked, { type: "predicate_met", evidence: "   " }, NOW + 1);
  expect(result.record.phase).toBe("CHECK_PREDICATE");
  expect(result.record.completedAt).toBe(undefined);
  const first = result.effects.at(0);
  const message = first && first.type === "notify" ? first.message : "";
  expect(message).toMatch(/evidence required/);
});

test("predicate_unmet returns CHECK_PREDICATE to WAIT_FOR_EVENT_OR_HEARTBEAT", () => {
  const result = reduceRun(atPredicateCheck(), { type: "predicate_unmet" }, NOW + 1);
  expect(result.record.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
});

test("three consecutive discards block the run on plateau", () => {
  const first = discard(defined(fresh({ plateauLimit: 3 })));
  expect(first.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
  const second = discard(first);
  expect(second.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
  const third = reduceRun(acting(second), { type: "iteration_discarded", reason: "flat", evidence: "no gain" }, NOW);
  expect(third.record.phase).toBe("BLOCKED");
  expect(third.record.consecutiveDiscards).toBe(3);
  expect(third.record.blockedReason ?? "").toMatch(/plateau/);
  expect(third.record.blockedReason ?? "").toMatch(/ci green/);
  expect(third.effects.at(-1)).toEqual({ type: "stop" });
});

test("inconclusive counts toward the plateau and is reported distinctly", () => {
  const first = reduceRun(acting(defined(fresh({ plateauLimit: 2 }))), { type: "iteration_inconclusive", reason: "no signal", evidence: "flat" }, NOW);
  expect(first.record.phase).toBe("COMMIT_IF_ADVANCED_OR_DISCARD");
  expect(first.record.consecutiveDiscards).toBe(1);
  const second = reduceRun(acting(first.record), { type: "iteration_inconclusive", reason: "no signal", evidence: "flat" }, NOW);
  expect(second.record.phase).toBe("BLOCKED");
  const messages = second.effects.filter((effect) => effect.type === "notify").map((effect) => effect.message);
  expect(messages.some((message) => message.includes("inconclusive: no signal"))).toBe(true);
  expect(messages.some((message) => message.includes("BLOCKED on plateau"))).toBe(true);
});

test("completed records ignore further events", () => {
  const completed = reduceRun(atPredicateCheck(), { type: "predicate_met", evidence: "ci green" }, NOW).record;
  expect(completed.phase).toBe("COMPLETE");
  const after = reduceRun(completed, { type: "heartbeat" }, NOW + 1);
  expect(after.record).toBe(completed);
  expect(after.effects).toEqual([]);
});

test("blocked records ignore further events except stop", () => {
  const blocked = reduceRun(defined(), { type: "mark_blocked", reason: "dependency gone" }, NOW).record;
  expect(blocked.phase).toBe("BLOCKED");
  const ignoredEvent = reduceRun(blocked, { type: "iteration_started", action: "more work" }, NOW + 1);
  expect(ignoredEvent.record).toBe(blocked);
  const stop = reduceRun(blocked, { type: "stop" }, NOW + 2);
  expect(stop.effects).toEqual([{ type: "stop" }]);
});

test("hosted_unavailable blocks a remote-required run and never continues locally", () => {
  const remote = reduceRun(defined(fresh({ remoteRequired: true })), { type: "hosted_unavailable" }, NOW);
  expect(remote.record.phase).toBe("BLOCKED");
  expect(remote.record.blockedReason ?? "").toMatch(/hosted/);
  const local = reduceRun(remote.record, { type: "iteration_started", action: "pretend locally" }, NOW + 1);
  expect(local.record.phase).toBe("BLOCKED");
  expect(local.effects).toEqual([]);
});

test("hosted_unavailable leaves a local run waiting", () => {
  const waiting = defined();
  const result = reduceRun(waiting, { type: "hosted_unavailable" }, NOW);
  expect(result.record.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
});

test("handoff_requested stores the endpoint and blocks the run locally", () => {
  const result = reduceRun(defined(), { type: "handoff_requested", endpoint: "https://worker.example/runs/1" }, NOW);
  expect(result.record.phase).toBe("BLOCKED");
  expect(result.record.remote.handedOff).toBe(true);
  expect(result.record.remote.endpoint).toBe("https://worker.example/runs/1");
  expect(result.effects.at(0)).toEqual({ type: "handoff", endpoint: "https://worker.example/runs/1" });
});

test("reduceRun never mutates the input record", () => {
  const act: RunRecord = acting(defined());
  const snapshot = JSON.parse(JSON.stringify(act)) as RunRecord;
  const event: RunEvent = { type: "iteration_verified", verification: "npm test", evidence: "exit 0" };
  const result = reduceRun(act, event, NOW + 5);
  expect(act).toEqual(snapshot);
  expect(act.phase).toBe("VERIFY");
  expect(act.iterations.at(-1)?.verdict).toBe("inconclusive");
  expect(result.record).not.toBe(act);
  expect(result.record.iterations.at(-1)?.verdict).toBe("advanced");
});
