import assert from "node:assert/strict";

import { test } from "vitest";

import {
  initialState,
  planComplete,
  restore,
  startPlan,
  updateTask,
  wakeConfig,
} from "../lib/state.ts";
import { tsvRow } from "../src/support.ts";

function completedPlan() {
  const plan = startPlan("bug-fix", "repair");
  const [first, ...rest] = plan.tasks;
  assert(first);
  return rest.reduce(
    (p, task) => updateTask(p, task.id, "skipped", "not applicable"),
    updateTask(plan, first.id, "done", "red test output"),
  );
}
const savedState = (data: unknown) => ({ type: "custom", customType: "pstack-state", data });

test("a plan needs a goal and known or custom steps", () => {
  assert.throws(() => startPlan("unknown", "goal"));
  assert.throws(() => startPlan("bug-fix", " "));
  assert.throws(() => startPlan("figure-it-out", "goal", []));
  assert.equal(startPlan("figure-it-out", "goal", ["custom"]).tasks.length, 1);
});

test("closing a task requires evidence and a known task", () => {
  const plan = startPlan("bug-fix", "repair");
  assert(!planComplete(plan));
  assert.throws(() => updateTask(plan, 1, "done"));
  assert.throws(() => updateTask(plan, 100, "done", "proof"));
  assert.throws(() => updateTask(null, 1, "done", "proof"));
  assert(planComplete(completedPlan()));
});

test("final evidence survives re-recording a task but not a changed status", () => {
  const finished = { ...completedPlan(), finishedEvidence: "green" };
  assert.equal(updateTask(finished, 1, "done", "rerun").finishedEvidence, "green");
  assert.equal(updateTask(finished, 1, "skipped", "never ran").finishedEvidence, undefined);
  const reopened = updateTask(finished, 1, "active");
  assert(!planComplete(reopened));
  assert.equal(reopened.finishedEvidence, undefined);
});

test("restore takes the latest saved state and pauses its wake loop", () => {
  const state = {
    ...initialState(),
    mode: true,
    plan: completedPlan(),
    wake: wakeConfig(5, 3, "green"),
  };
  const saved = savedState(state);
  assert.equal(restore([saved]).mode, true);
  assert.equal(restore([saved]).wake?.running, false);
  assert.equal(state.wake.running, true);
  assert.equal(restore([]).plan, null);
  const unrelated = { type: "custom", customType: "other", data: { version: 1 } };
  assert.equal(restore([saved, null, unrelated]).plan?.goal, "repair");
});

test("restore keeps recorded stop evidence and rejects a malformed one", () => {
  const state = { ...initialState(), plan: completedPlan(), wake: wakeConfig(5, 3, "green") };
  const withEvidence = (stopEvidence: unknown) =>
    savedState({ ...state, wake: { ...state.wake, stopEvidence } });
  assert.equal(restore([withEvidence("green")]).wake?.stopEvidence, "green");
  assert.equal(restore([withEvidence(1)]).plan, null);
});

test("an invalid latest state cannot resurrect an earlier shipping plan", () => {
  const data = { ...initialState(), plan: startPlan("shipping", "previous plan") };
  for (const invalid of [{ ...data, plan: {} }, { ...data, version: 2 }, null]) {
    assert.deepEqual(restore([savedState(data), savedState(invalid)]), initialState());
  }
});

test("bounded wakes and TSV escaping", () => {
  assert.equal(wakeConfig(5, 1, "done").count, 0);
  for (const v of [0, 4, 86401, NaN]) assert.throws(() => wakeConfig(v, 1, "done"));
  assert.throws(() => wakeConfig(5, 101, "done"));
  assert.equal(tsvRow(["a\tb", "c\nd", "e\rf"]), "a b\tc d\te f\n");
});
