import { expect, test } from "vitest";
import {
  evaluateMergeGates,
  MERGE_GATE_FIXTURES,
} from "../../../extensions/shipping/gates.ts";

function fixture(id: string) {
  const found = MERGE_GATE_FIXTURES.find((f) => f.id === id);
  expect(found, `fixture ${id} missing from MERGE_GATE_FIXTURES`).toBeTruthy();
  return found;
}

test("fixture matrix covers the named gate cases exactly once", () => {
  expect(MERGE_GATE_FIXTURES.map((f) => f.id)).toEqual([
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
    ]);
});

test("clean-approved-success passes with an empty problem list", () => {
  const f = fixture("clean-approved-success");
  expect(f.expectPass).toBe(true);
  expect(f.expectSubstrings).toBe(undefined);
  expect(evaluateMergeGates(f.view)).toEqual([]);
});

test("dirty-blocks fails on mergeStateStatus=DIRTY", () => {
  const f = fixture("dirty-blocks");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["DIRTY"]);
  expect(evaluateMergeGates(f.view)).toEqual(["mergeStateStatus=DIRTY"]);
});

test("changes-requested fails on reviewDecision=CHANGES_REQUESTED", () => {
  const f = fixture("changes-requested");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["CHANGES_REQUESTED"]);
  expect(evaluateMergeGates(f.view)).toEqual(["reviewDecision=CHANGES_REQUESTED"]);
});

test("check-failure fails on check ci=FAILURE", () => {
  const f = fixture("check-failure");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["FAILURE"]);
  expect(evaluateMergeGates(f.view)).toEqual(["check ci=FAILURE"]);
});

test("already-merged fails twice, already merged and state=MERGED", () => {
  const f = fixture("already-merged");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["already merged", "MERGED"]);
  expect(evaluateMergeGates(f.view)).toEqual(["already merged", "state=MERGED"]);
});

test("draft-blocks fails on mergeStateStatus=DRAFT", () => {
  const f = fixture("draft-blocks");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["DRAFT"]);
  expect(evaluateMergeGates(f.view)).toEqual(["mergeStateStatus=DRAFT"]);
});

test("pending-check-blocks fails closed on check ci=PENDING", () => {
  const f = fixture("pending-check-blocks");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["PENDING"]);
  expect(evaluateMergeGates(f.view)).toEqual(["check ci=PENDING"]);
});

test("review-required fails on reviewDecision=REVIEW_REQUIRED", () => {
  const f = fixture("review-required");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["REVIEW_REQUIRED"]);
  expect(evaluateMergeGates(f.view)).toEqual(["reviewDecision=REVIEW_REQUIRED"]);
});

test("unstable-blocks fails on mergeStateStatus=UNSTABLE", () => {
  const f = fixture("unstable-blocks");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["UNSTABLE"]);
  expect(evaluateMergeGates(f.view)).toEqual(["mergeStateStatus=UNSTABLE"]);
});

test("closed-state fails on state=CLOSED", () => {
  const f = fixture("closed-state");
  expect(f.expectPass).toBe(false);
  expect(f.expectSubstrings).toEqual(["CLOSED"]);
  expect(evaluateMergeGates(f.view)).toEqual(["state=CLOSED"]);
});

test("evaluateMergeGates treats an empty view as clean", () => {
  expect(evaluateMergeGates({})).toEqual([]);
});

test("evaluateMergeGates fails closed on BLOCKED and BEHIND", () => {
  expect(evaluateMergeGates({ state: "OPEN", mergeStateStatus: "BLOCKED" })).toEqual([
    "mergeStateStatus=BLOCKED",
  ]);
  expect(evaluateMergeGates({ state: "OPEN", mergeStateStatus: "BEHIND" })).toEqual([
    "mergeStateStatus=BEHIND",
  ]);
});

test("evaluateMergeGates reports every problem in view order", () => {
  expect(evaluateMergeGates({
      state: "CLOSED",
      mergeStateStatus: "DIRTY",
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [
        { name: "ci", conclusion: "FAILURE" },
        { name: "lint", status: "IN_PROGRESS" },
      ],
    })).toEqual([
      "state=CLOSED",
      "mergeStateStatus=DIRTY",
      "check ci=FAILURE",
      "check lint=IN_PROGRESS",
      "reviewDecision=CHANGES_REQUESTED",
    ]);
});

test("evaluateMergeGates uppercases check conclusions and names unnamed checks", () => {
  expect(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ name: "ci", conclusion: "failure" }] })).toEqual([
    "check ci=FAILURE",
  ]);
  expect(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ conclusion: "FAILURE" }] })).toEqual([
    "check ?=FAILURE",
  ]);
  expect(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ name: "lint", status: "queued" }] })).toEqual([
    "check lint=QUEUED",
  ]);
});

test("evaluateMergeGates leaves a non-OPEN state verbatim", () => {
  expect(evaluateMergeGates({ state: "open" })).toEqual(["state=open"]);
});
