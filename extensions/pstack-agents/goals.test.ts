import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  GOAL_ENTRY_TYPE,
  createGoal,
  goalEventsFromBranch,
  goalStateFromBranch,
  nextGoalContinuation,
  parseGoalEvent,
  parseGoalId,
  reduceGoal,
  updateGoal,
  type GoalEvent,
  type GoalState,
} from "./goals.ts";

function appendCustom(branch: SessionEntry[], customType: string, data: unknown): void {
  branch.push({
    type: "custom",
    id: `entry-${branch.length + 1}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  });
}

function testApi(branch: SessionEntry[]) {
  return {
    appendEntry(customType: string, data?: unknown) {
      appendCustom(branch, customType, data);
    },
  };
}

function appendToolResult(branch: SessionEntry[]): void {
  branch.push({
    type: "message",
    id: `entry-${branch.length + 1}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "tool-call-progress",
      toolName: "Task",
      content: [{ type: "text", text: "progress" }],
      isError: false,
      timestamp: Date.now(),
    },
  });
}

function appendContinuation(branch: SessionEntry[], event: Extract<GoalEvent, { kind: "continued" }>): void {
  appendCustom(branch, GOAL_ENTRY_TYPE, event);
}

describe("branch-local goal reducer", () => {
  test("creates one active goal, permits pause and resume, and allows replacement after completion", () => {
    const branch: SessionEntry[] = [];
    const pi = testApi(branch);
    const first = createGoal(pi, branch, "Ship the migration");
    expect(first).toMatchObject({ state: "ACTIVE", objective: "Ship the migration", consecutiveContinuations: 0 });
    expect(() => createGoal(pi, branch, "Competing goal")).toThrow("already active");

    const paused = updateGoal(pi, branch, "PAUSED");
    expect(paused).toMatchObject({ state: "PAUSED" });
    expect(updateGoal(pi, branch, "PAUSED")).toEqual(paused);
    expect(updateGoal(pi, branch, "ACTIVE")).toMatchObject({ state: "ACTIVE", consecutiveContinuations: 0 });
    expect(updateGoal(pi, branch, "COMPLETE")).toMatchObject({ state: "COMPLETE" });
    const next = createGoal(pi, branch, "Verify the release");
    expect(next).toMatchObject({ state: "ACTIVE", objective: "Verify the release" });
    expect(goalStateFromBranch(branch)).toEqual(next);
    expect(goalEventsFromBranch(branch)).toHaveLength(5);
  });

  test("keeps a continuation counter, resets it after tool progress, then pauses at the three-turn fuse", () => {
    const branch: SessionEntry[] = [];
    appendCustom(branch, "test/base", {});
    const pi = testApi(branch);
    const created = createGoal(pi, branch, "Use the tool to finish");
    let state: GoalState = created;
    let continuation = nextGoalContinuation(state, branch);
    expect(continuation.kind).toBe("continue");
    if (continuation.kind !== "continue") throw new Error("Expected a continuation");
    expect(continuation.event.count).toBe(1);
    appendContinuation(branch, continuation.event);
    state = reduceGoal([...goalEventsFromBranch(branch)]);

    appendToolResult(branch);
    continuation = nextGoalContinuation(state, branch);
    expect(continuation.kind).toBe("continue");
    if (continuation.kind !== "continue") throw new Error("Expected a continuation after progress");
    expect(continuation.event.count).toBe(1);
    appendContinuation(branch, continuation.event);
    state = reduceGoal(goalEventsFromBranch(branch));

    for (const expectedCount of [2, 3]) {
      continuation = nextGoalContinuation(state, branch);
      expect(continuation.kind).toBe("continue");
      if (continuation.kind !== "continue") throw new Error("Expected a continuation");
      expect(continuation.event.count).toBe(expectedCount);
      appendContinuation(branch, continuation.event);
      state = reduceGoal(goalEventsFromBranch(branch));
    }
    const fuse = nextGoalContinuation(state, branch);
    expect(fuse).toMatchObject({ kind: "paused", event: { kind: "status", status: "PAUSED" } });
    if (fuse.kind !== "paused") throw new Error("Expected the continuation fuse");
    appendCustom(branch, GOAL_ENTRY_TYPE, fuse.event);
    expect(goalStateFromBranch(branch)).toMatchObject({ state: "PAUSED" });
  });

  test("ignores malformed branch events and preserves completed goals", () => {
    const id = parseGoalId("33333333-3333-4333-8333-333333333333");
    if (!id) throw new Error("Test goal identifier must be a UUID");
    const event: GoalEvent = { kind: "created", id, objective: "Finish", at: 1 };
    expect(parseGoalEvent({ ...event, at: "now" })).toBeUndefined();
    const state = reduceGoal([event, { kind: "status", id: event.id, status: "COMPLETE", at: 2 }]);
    expect(state).toMatchObject({ state: "COMPLETE", objective: "Finish" });
  });
});
