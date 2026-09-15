import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMergeGates,
  MERGE_GATE_FIXTURES,
} from "../../../extensions/shipping/gates.ts";

function fixture(id: string) {
  const found = MERGE_GATE_FIXTURES.find((f) => f.id === id);
  assert.ok(found, `fixture ${id} missing from MERGE_GATE_FIXTURES`);
  return found;
}

test("fixture matrix covers the named gate cases exactly once", () => {
  assert.deepEqual(
    MERGE_GATE_FIXTURES.map((f) => f.id),
    [
      "clean-approved-success",
      "dirty-blocks",
      "changes-requested",
      "check-failure",
      "already-merged",
      "draft-blocks",
      "pending-check-blocks",
      "review-required",
      "unstable-blocks",
      "closed-state",
    ],
  );
});

test("clean-approved-success passes with an empty problem list", () => {
  const f = fixture("clean-approved-success");
  assert.equal(f.expectPass, true);
  assert.equal(f.expectSubstrings, undefined);
  assert.deepEqual(evaluateMergeGates(f.view), []);
});

test("dirty-blocks fails on mergeStateStatus=DIRTY", () => {
  const f = fixture("dirty-blocks");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["DIRTY"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["mergeStateStatus=DIRTY"]);
});

test("changes-requested fails on reviewDecision=CHANGES_REQUESTED", () => {
  const f = fixture("changes-requested");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["CHANGES_REQUESTED"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["reviewDecision=CHANGES_REQUESTED"]);
});

test("check-failure fails on check ci=FAILURE", () => {
  const f = fixture("check-failure");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["FAILURE"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["check ci=FAILURE"]);
});

test("already-merged fails twice, already merged and state=MERGED", () => {
  const f = fixture("already-merged");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["already merged", "MERGED"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["already merged", "state=MERGED"]);
});

test("draft-blocks fails on mergeStateStatus=DRAFT", () => {
  const f = fixture("draft-blocks");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["DRAFT"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["mergeStateStatus=DRAFT"]);
});

test("pending-check-blocks fails closed on check ci=PENDING", () => {
  const f = fixture("pending-check-blocks");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["PENDING"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["check ci=PENDING"]);
});

test("review-required fails on reviewDecision=REVIEW_REQUIRED", () => {
  const f = fixture("review-required");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["REVIEW_REQUIRED"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["reviewDecision=REVIEW_REQUIRED"]);
});

test("unstable-blocks fails on mergeStateStatus=UNSTABLE", () => {
  const f = fixture("unstable-blocks");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["UNSTABLE"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["mergeStateStatus=UNSTABLE"]);
});

test("closed-state fails on state=CLOSED", () => {
  const f = fixture("closed-state");
  assert.equal(f.expectPass, false);
  assert.deepEqual(f.expectSubstrings, ["CLOSED"]);
  assert.deepEqual(evaluateMergeGates(f.view), ["state=CLOSED"]);
});

test("evaluateMergeGates treats an empty view as clean", () => {
  assert.deepEqual(evaluateMergeGates({}), []);
});

test("evaluateMergeGates fails closed on BLOCKED and BEHIND", () => {
  assert.deepEqual(evaluateMergeGates({ state: "OPEN", mergeStateStatus: "BLOCKED" }), [
    "mergeStateStatus=BLOCKED",
  ]);
  assert.deepEqual(evaluateMergeGates({ state: "OPEN", mergeStateStatus: "BEHIND" }), [
    "mergeStateStatus=BEHIND",
  ]);
});

test("evaluateMergeGates reports every problem in view order", () => {
  assert.deepEqual(
    evaluateMergeGates({
      state: "CLOSED",
      mergeStateStatus: "DIRTY",
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [
        { name: "ci", conclusion: "FAILURE" },
        { name: "lint", status: "IN_PROGRESS" },
      ],
    }),
    [
      "state=CLOSED",
      "mergeStateStatus=DIRTY",
      "check ci=FAILURE",
      "check lint=IN_PROGRESS",
      "reviewDecision=CHANGES_REQUESTED",
    ],
  );
});

test("evaluateMergeGates uppercases check conclusions and names unnamed checks", () => {
  assert.deepEqual(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ name: "ci", conclusion: "failure" }] }), [
    "check ci=FAILURE",
  ]);
  assert.deepEqual(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }] }), [
    "check ?=FAILURE",
  ]);
  assert.deepEqual(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ name: "lint", status: "queued" }] }), [
    "check lint=QUEUED",
  ]);
});

test("evaluateMergeGates leaves a non-OPEN state verbatim", () => {
  assert.deepEqual(evaluateMergeGates({ state: "open" }), ["state=open"]);
});
