import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStack } from "../../../extensions/shipping/frontier.ts";

test("evaluateStack reports ADVANCE when the frontier is merge-ready", () => {
  const status = evaluateStack([
    { number: "3", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" },
    { number: "5", state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" },
    { number: "7", state: "OPEN", mergeStateStatus: "DIRTY" },
  ]);
  assert.equal(status.verdict, "ADVANCE");
  assert.equal(status.frontier, "5");
  assert.deepEqual(status.problems, []);
});

test("evaluateStack waits on the frontier blockers", () => {
  const status = evaluateStack([
    { number: "3", state: "OPEN", mergeStateStatus: "BLOCKED" },
    { number: "5", state: "OPEN", mergeStateStatus: "CLEAN" },
  ]);
  assert.equal(status.verdict, "WAITING");
  assert.equal(status.frontier, "3");
  assert.deepEqual(status.problems, ["mergeStateStatus=BLOCKED"]);
});

test("evaluateStack reports COMPLETE when every PR merged", () => {
  const status = evaluateStack([
    { number: "3", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" },
    { number: "5", state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" },
  ]);
  assert.equal(status.verdict, "COMPLETE");
  assert.equal(status.frontier, undefined);
  assert.deepEqual(status.problems, []);
});

test("evaluateStack fails closed on an unfetchable row", () => {
  const status = evaluateStack([{ number: "3", state: "UNKNOWN" }]);
  assert.equal(status.verdict, "WAITING");
  assert.equal(status.frontier, "3");
  assert.deepEqual(status.problems, ["state=UNKNOWN"]);
});
