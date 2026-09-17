import { expect, test } from "vitest";
import { evaluateStack } from "../../../extensions/shipping/frontier.ts";

test("evaluateStack reports ADVANCE when the frontier is merge-ready", () => {
  const status = evaluateStack([
    { number: "3", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" },
    { number: "5", state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" },
    { number: "7", state: "OPEN", mergeStateStatus: "DIRTY" },
  ]);
  expect(status.verdict).toBe("ADVANCE");
  expect(status.frontier).toBe("5");
  expect(status.problems).toEqual([]);
});

test("evaluateStack waits on the frontier blockers", () => {
  const status = evaluateStack([
    { number: "3", state: "OPEN", mergeStateStatus: "BLOCKED" },
    { number: "5", state: "OPEN", mergeStateStatus: "CLEAN" },
  ]);
  expect(status.verdict).toBe("WAITING");
  expect(status.frontier).toBe("3");
  expect(status.problems).toEqual(["mergeStateStatus=BLOCKED"]);
});

test("evaluateStack reports COMPLETE when every PR merged", () => {
  const status = evaluateStack([
    { number: "3", state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" },
    { number: "5", state: "MERGED", mergedAt: "2026-01-02T00:00:00Z" },
  ]);
  expect(status.verdict).toBe("COMPLETE");
  expect(status.frontier).toBe(undefined);
  expect(status.problems).toEqual([]);
});

test("evaluateStack fails closed on an unfetchable row", () => {
  const status = evaluateStack([{ number: "3", state: "UNKNOWN" }]);
  expect(status.verdict).toBe("WAITING");
  expect(status.frontier).toBe("3");
  expect(status.problems).toEqual(["state=UNKNOWN"]);
});
