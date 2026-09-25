import { randomUUID } from "node:crypto";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseRunId } from "./contracts.ts";

export const GOAL_ENTRY_TYPE = "pstack-agents/goal";
export const GOAL_NOTICE_TYPE = "pstack-agents/goal-notice";
export const MAX_IDLE_CONTINUATIONS = 3;

export type GoalId = string & { readonly __brand: "GoalId" };
export type GoalStatus = "ACTIVE" | "PAUSED" | "COMPLETE" | "CLEARED";

export type GoalEvent =
  | { kind: "created"; id: GoalId; objective: string; at: number }
  | { kind: "status"; id: GoalId; status: GoalStatus; at: number }
  | { kind: "continued"; id: GoalId; count: number; afterEntryId: string | null; at: number };

export type GoalState =
  | { state: "none" }
  | {
      state: GoalStatus;
      id: GoalId;
      objective: string;
      consecutiveContinuations: number;
      lastContinuationAfterEntryId: string | null;
    };

export type GoalContinuation =
  | { kind: "none" }
  | { kind: "continue"; event: Extract<GoalEvent, { kind: "continued" }>; notificationId: string; content: string }
  | { kind: "paused"; event: Extract<GoalEvent, { kind: "status" }>; notificationId: string; content: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "ACTIVE" || value === "PAUSED" || value === "COMPLETE" || value === "CLEARED";
}

export function parseGoalId(value: unknown): GoalId | undefined {
  return parseRunId(value) as GoalId | undefined;
}

export function parseGoalEvent(value: unknown): GoalEvent | undefined {
  if (!isRecord(value) || !finiteNumber(value.at)) return undefined;
  const id = parseGoalId(value.id);
  if (!id) return undefined;
  switch (value.kind) {
    case "created":
      if (typeof value.objective !== "string" || value.objective.trim() === "") return undefined;
      return { kind: "created", id, objective: value.objective, at: value.at };
    case "status":
      return isGoalStatus(value.status) ? { kind: "status", id, status: value.status, at: value.at } : undefined;
    case "continued":
      if (!Number.isSafeInteger(value.count) || Number(value.count) < 1 || Number(value.count) > MAX_IDLE_CONTINUATIONS) return undefined;
      if (value.afterEntryId !== null && typeof value.afterEntryId !== "string") return undefined;
      return { kind: "continued", id, count: Number(value.count), afterEntryId: value.afterEntryId, at: value.at };
    default:
      return undefined;
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function goalEventsFromBranch(branch: readonly SessionEntry[]): GoalEvent[] {
  const events: GoalEvent[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
    const event = parseGoalEvent(entry.data);
    if (event) events.push(event);
  }
  return events;
}

export function reduceGoal(events: readonly GoalEvent[]): GoalState {
  let state: GoalState = { state: "none" };
  for (const event of events) {
    if (event.kind === "created") {
      if (state.state === "none" || state.state === "COMPLETE" || state.state === "CLEARED") {
        state = {
          state: "ACTIVE",
          id: event.id,
          objective: event.objective,
          consecutiveContinuations: 0,
          lastContinuationAfterEntryId: null,
        };
      }
      continue;
    }
    if (state.state === "none" || state.id !== event.id) continue;
    if (event.kind === "status") {
      state = {
        ...state,
        state: event.status,
        ...(event.status === "ACTIVE" ? { consecutiveContinuations: 0, lastContinuationAfterEntryId: null } : {}),
      };
    } else if (state.state === "ACTIVE") {
      state = { ...state, consecutiveContinuations: event.count, lastContinuationAfterEntryId: event.afterEntryId };
    }
  }
  return state;
}

export function goalStateFromBranch(branch: readonly SessionEntry[]): GoalState {
  return reduceGoal(goalEventsFromBranch(branch));
}

export function goalNoticeIdsFromBranch(branch: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom_message" || entry.customType !== GOAL_NOTICE_TYPE || !isRecord(entry.details)) continue;
    if (typeof entry.details.notificationId === "string") ids.add(entry.details.notificationId);
  }
  return ids;
}

export function createGoal(pi: Pick<ExtensionAPI, "appendEntry">, branch: readonly SessionEntry[], objective: string): GoalState {
  const normalizedObjective = objective.trim();
  if (!normalizedObjective) throw new Error("CreateGoal requires a non-empty objective");
  const current = goalStateFromBranch(branch);
  if (current.state === "ACTIVE" || current.state === "PAUSED") throw new Error(`Goal ${current.id} is already ${current.state.toLowerCase()}`);
  const id = parseGoalId(randomUUID());
  if (!id) throw new Error("Crypto generated an invalid goal ID");
  const event: GoalEvent = { kind: "created", id, objective: normalizedObjective, at: Date.now() };
  pi.appendEntry(GOAL_ENTRY_TYPE, event);
  return reduceGoal([...goalEventsFromBranch(branch), event]);
}

export function updateGoal(pi: Pick<ExtensionAPI, "appendEntry">, branch: readonly SessionEntry[], status: GoalStatus): GoalState {
  if (!isGoalStatus(status)) throw new Error("UpdateGoal status must be ACTIVE, PAUSED, COMPLETE, or CLEARED");
  const current = goalStateFromBranch(branch);
  if (current.state === "none") throw new Error("There is no current goal to update");
  if (current.state === status) return current;
  if (current.state === "COMPLETE" || current.state === "CLEARED") throw new Error(`Goal ${current.id} is already ${current.state.toLowerCase()}`);
  const event: GoalEvent = { kind: "status", id: current.id, status, at: Date.now() };
  pi.appendEntry(GOAL_ENTRY_TYPE, event);
  return reduceGoal([...goalEventsFromBranch(branch), event]);
}

function hasToolCallSince(branch: readonly SessionEntry[], entryId: string | null): boolean {
  if (entryId === null) return false;
  const anchor = branch.findIndex((entry) => entry.id === entryId);
  if (anchor < 0) return false;
  return branch.slice(anchor + 1).some((entry) => entry.type === "message" && entry.message.role === "toolResult");
}

export function nextGoalContinuation(state: GoalState, branch: readonly SessionEntry[]): GoalContinuation {
  if (state.state !== "ACTIVE") return { kind: "none" };
  const progressed = hasToolCallSince(branch, state.lastContinuationAfterEntryId);
  const previousCount = progressed ? 0 : state.consecutiveContinuations;
  const at = Date.now();
  const anchor = branch.at(-1)?.id ?? null;
  if (previousCount >= MAX_IDLE_CONTINUATIONS) {
    return {
      kind: "paused",
      event: { kind: "status", id: state.id, status: "PAUSED", at },
      notificationId: `${state.id}:fuse:${anchor ?? "root"}`,
      content: `Paused goal ${state.id} after ${MAX_IDLE_CONTINUATIONS} consecutive continuations without a tool call. Resume with UpdateGoal({ status: "ACTIVE" }) or choose a new goal.`,
    };
  }
  const count = previousCount + 1;
  return {
    kind: "continue",
    event: { kind: "continued", id: state.id, count, afterEntryId: anchor, at },
    notificationId: `${state.id}:continuation:${count}:${anchor ?? "root"}`,
    content: `Continue the active goal: ${state.objective}\nAudit the result before calling UpdateGoal({ status: "COMPLETE" }).`,
  };
}
