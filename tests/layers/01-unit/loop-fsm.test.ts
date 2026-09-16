import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual([...RUN_PHASES], [
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
  assert.equal(base.phase, "DEFINE_PREDICATE");
  const result = reduceRun(base, { type: "predicate_defined", predicate: "ci green" }, NOW);
  assert.equal(result.record.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
  assert.equal(result.record.predicate, "ci green");
  assert.equal(result.record.updatedAt, NOW);
  assert.deepEqual(result.effects, [{ type: "notify", message: "run run-test predicate defined: ci green" }]);
});

test("predicate_defined refuses to relax an already defined predicate", () => {
  const waiting = defined();
  const result = reduceRun(waiting, { type: "predicate_defined", predicate: "anything goes" }, NOW + 1);
  assert.equal(result.record.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
  assert.equal(result.record.predicate, "ci green");
});

test("heartbeat moves WAIT_FOR_EVENT_OR_HEARTBEAT to RESUME_OR_START_ITERATION and counts a fire", () => {
  const result = reduceRun(defined(), { type: "heartbeat" }, NOW);
  assert.equal(result.record.phase, "RESUME_OR_START_ITERATION");
  assert.equal(result.record.fires, 1);
  assert.deepEqual(result.effects, [{ type: "wake", reason: "heartbeat" }]);
});

test("event_wake records the event id and wakes with the event reason", () => {
  const result = reduceRun(defined(), { type: "event_wake", eventId: "evt-1", reason: "ci finished" }, NOW);
  assert.equal(result.record.phase, "RESUME_OR_START_ITERATION");
  assert.deepEqual(result.record.eventIds, ["evt-1"]);
  assert.equal(result.record.lastEventId, "evt-1");
  assert.deepEqual(result.effects, [{ type: "wake", reason: "ci finished" }]);
});

test("a duplicate event_wake with the same event id is a no-op", () => {
  const first = reduceRun(defined(), { type: "event_wake", eventId: "evt-1", reason: "ci" }, NOW);
  const duplicate = reduceRun(first.record, { type: "event_wake", eventId: "evt-1", reason: "ci" }, NOW + 5);
  assert.equal(duplicate.record, first.record);
  assert.deepEqual(duplicate.effects, []);
});

test("iteration_started moves RESUME_OR_START_ITERATION to ACT with an open iteration", () => {
  const result = reduceRun(resumed(defined()), { type: "iteration_started", action: "smallest change" }, NOW);
  assert.equal(result.record.phase, "ACT");
  assert.equal(result.record.iterations.length, 1);
  assert.deepEqual(result.record.iterations.at(0), {
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
  assert.equal(result.record.phase, "VERIFY");
});

test("iteration_verified closes the open iteration as advanced and resets discards", () => {
  const verify = acting(defined());
  const result = reduceRun(verify, { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, NOW + 10);
  assert.equal(result.record.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
  assert.equal(result.record.consecutiveDiscards, 0);
  assert.equal(result.record.iterations.at(-1)?.verdict, "advanced");
  assert.equal(result.record.iterations.at(-1)?.evidence, "exit 0");
  assert.equal(result.record.iterations.at(-1)?.endedAt, NOW + 10);
});

test("iteration_discarded increments consecutiveDiscards and lands in COMMIT_IF_ADVANCED_OR_DISCARD", () => {
  const result = reduceRun(acting(defined()), { type: "iteration_discarded", reason: "flat", evidence: "no gain" }, NOW);
  assert.equal(result.record.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
  assert.equal(result.record.consecutiveDiscards, 1);
  assert.equal(result.record.iterations.at(-1)?.verdict, "discarded");
});

test("checkpoint moves COMMIT_IF_ADVANCED_OR_DISCARD to CHECKPOINT", () => {
  const committed = reduceRun(acting(defined()), { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, NOW).record;
  const result = reduceRun(committed, { type: "checkpoint" }, NOW);
  assert.equal(result.record.phase, "CHECKPOINT");
});

test("predicate_checked moves CHECKPOINT to CHECK_PREDICATE", () => {
  const committed = reduceRun(acting(defined()), { type: "iteration_verified", verification: "npm test", evidence: "exit 0" }, NOW).record;
  const checkpointed = reduceRun(committed, { type: "checkpoint" }, NOW).record;
  const result = reduceRun(checkpointed, { type: "predicate_checked" }, NOW);
  assert.equal(result.record.phase, "CHECK_PREDICATE");
});

test("predicate_met with evidence completes the run", () => {
  const checked = atPredicateCheck();
  assert.equal(checked.phase, "CHECK_PREDICATE");
  const result = reduceRun(checked, { type: "predicate_met", evidence: "ci green on shasum abc" }, NOW + 1);
  assert.equal(result.record.phase, "COMPLETE");
  assert.equal(result.record.completedAt, NOW + 1);
  assert.deepEqual(result.effects.at(-1), { type: "stop" });
});

test("predicate_met without evidence never completes", () => {
  const checked = atPredicateCheck();
  const result = reduceRun(checked, { type: "predicate_met", evidence: "   " }, NOW + 1);
  assert.equal(result.record.phase, "CHECK_PREDICATE");
  assert.equal(result.record.completedAt, undefined);
  const first = result.effects.at(0);
  const message = first && first.type === "notify" ? first.message : "";
  assert.match(message, /evidence required/);
});

test("predicate_unmet returns CHECK_PREDICATE to WAIT_FOR_EVENT_OR_HEARTBEAT", () => {
  const result = reduceRun(atPredicateCheck(), { type: "predicate_unmet" }, NOW + 1);
  assert.equal(result.record.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
});

test("three consecutive discards block the run on plateau", () => {
  const first = discard(defined(fresh({ plateauLimit: 3 })));
  assert.equal(first.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
  const second = discard(first);
  assert.equal(second.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
  const third = reduceRun(acting(second), { type: "iteration_discarded", reason: "flat", evidence: "no gain" }, NOW);
  assert.equal(third.record.phase, "BLOCKED");
  assert.equal(third.record.consecutiveDiscards, 3);
  assert.match(third.record.blockedReason ?? "", /plateau/);
  assert.match(third.record.blockedReason ?? "", /ci green/);
  assert.deepEqual(third.effects.at(-1), { type: "stop" });
});

test("inconclusive counts toward the plateau and is reported distinctly", () => {
  const first = reduceRun(acting(defined(fresh({ plateauLimit: 2 }))), { type: "iteration_inconclusive", reason: "no signal", evidence: "flat" }, NOW);
  assert.equal(first.record.phase, "COMMIT_IF_ADVANCED_OR_DISCARD");
  assert.equal(first.record.consecutiveDiscards, 1);
  const second = reduceRun(acting(first.record), { type: "iteration_inconclusive", reason: "no signal", evidence: "flat" }, NOW);
  assert.equal(second.record.phase, "BLOCKED");
  const messages = second.effects.filter((effect) => effect.type === "notify").map((effect) => effect.message);
  assert.equal(messages.some((message) => message.includes("inconclusive: no signal")), true);
  assert.equal(messages.some((message) => message.includes("BLOCKED on plateau")), true);
});

test("completed records ignore further events", () => {
  const completed = reduceRun(atPredicateCheck(), { type: "predicate_met", evidence: "ci green" }, NOW).record;
  assert.equal(completed.phase, "COMPLETE");
  const after = reduceRun(completed, { type: "heartbeat" }, NOW + 1);
  assert.equal(after.record, completed);
  assert.deepEqual(after.effects, []);
});

test("blocked records ignore further events except stop", () => {
  const blocked = reduceRun(defined(), { type: "mark_blocked", reason: "dependency gone" }, NOW).record;
  assert.equal(blocked.phase, "BLOCKED");
  const ignoredEvent = reduceRun(blocked, { type: "iteration_started", action: "more work" }, NOW + 1);
  assert.equal(ignoredEvent.record, blocked);
  const stop = reduceRun(blocked, { type: "stop" }, NOW + 2);
  assert.deepEqual(stop.effects, [{ type: "stop" }]);
});

test("hosted_unavailable blocks a remote-required run and never continues locally", () => {
  const remote = reduceRun(defined(fresh({ remoteRequired: true })), { type: "hosted_unavailable" }, NOW);
  assert.equal(remote.record.phase, "BLOCKED");
  assert.match(remote.record.blockedReason ?? "", /hosted/);
  const local = reduceRun(remote.record, { type: "iteration_started", action: "pretend locally" }, NOW + 1);
  assert.equal(local.record.phase, "BLOCKED");
  assert.deepEqual(local.effects, []);
});

test("hosted_unavailable leaves a local run waiting", () => {
  const waiting = defined();
  const result = reduceRun(waiting, { type: "hosted_unavailable" }, NOW);
  assert.equal(result.record.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
});

test("handoff_requested stores the endpoint and blocks the run locally", () => {
  const result = reduceRun(defined(), { type: "handoff_requested", endpoint: "https://worker.example/runs/1" }, NOW);
  assert.equal(result.record.phase, "BLOCKED");
  assert.equal(result.record.remote.handedOff, true);
  assert.equal(result.record.remote.endpoint, "https://worker.example/runs/1");
  assert.deepEqual(result.effects.at(0), { type: "handoff", endpoint: "https://worker.example/runs/1" });
});

test("reduceRun never mutates the input record", () => {
  const act: RunRecord = acting(defined());
  const snapshot = JSON.parse(JSON.stringify(act)) as RunRecord;
  const event: RunEvent = { type: "iteration_verified", verification: "npm test", evidence: "exit 0" };
  const result = reduceRun(act, event, NOW + 5);
  assert.deepEqual(act, snapshot);
  assert.equal(act.phase, "VERIFY");
  assert.equal(act.iterations.at(-1)?.verdict, "inconclusive");
  assert.notEqual(result.record, act);
  assert.equal(result.record.iterations.at(-1)?.verdict, "advanced");
});
