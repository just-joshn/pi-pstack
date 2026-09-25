import { describe, expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
  isTerminalStatus,
  parseRunId,
  parseRunStatus,
  parseRunnerJsonl,
  reduceRunRecords,
  type RunStatus,
} from "./contracts.ts";

const id = "11111111-1111-4111-8111-111111111111";
const runId = parseRunId(id);
if (!runId) throw new Error("Test run identifier must be a UUID");

const running: RunStatus = {
  state: "running",
  id: runId,
  attempt: 1,
  pid: 42,
  startedAt: 100,
  updatedAt: 100,
};

const completed: RunStatus = {
  state: "completed",
  id: runId,
  attempt: 1,
  exitCode: 0,
  stopReason: "stop",
  endedAt: 200,
};

describe("run contract parsing", () => {
  test("brands valid UUIDs and rejects malformed run identifiers", () => {
    expect(String(parseRunId(id))).toBe(id);
    expect(parseRunId("run-1")).toBeUndefined();
    expect(parseRunId("11111111-1111-4111-8111-11111111111z")).toBeUndefined();
  });

  test("accepts each well-formed lifecycle state and rejects contradictory payloads", () => {
    expect(parseRunStatus({ state: "running", id, attempt: 1, pid: 42, startedAt: 100, updatedAt: 100 })).toEqual(running);
    expect(parseRunStatus({ state: "completed", id, attempt: 1, exitCode: 0, stopReason: "stop", endedAt: 200 })).toEqual(completed);
    expect(parseRunStatus({ state: "failed", id, attempt: 1, exitCode: 1, stopReason: "error", endedAt: 200 })).toMatchObject({ state: "failed", exitCode: 1 });
    expect(parseRunStatus({ state: "stopped", id, attempt: 1, endedAt: 200 })).toMatchObject({ state: "stopped" });
    expect(parseRunStatus({ state: "completed", id, attempt: 1, exitCode: 1, stopReason: "stop", endedAt: 200 })).toBeUndefined();
    expect(parseRunStatus({ state: "running", id, attempt: 0, pid: 42, startedAt: 100, updatedAt: 100 })).toBeUndefined();
  });

  test("reduces ordered runner records and ignores duplicate or malformed sequence values", () => {
    expect(
      reduceRunRecords([
        { sequence: 2, at: 200, type: "shell-line", lineSequence: 1, stream: "stdout", line: "READY" },
        { sequence: 1, at: 100, type: "status", status: running },
        { sequence: 3, at: 300, type: "terminal", status: completed },
        { sequence: 3, at: 301, type: "message", event: { type: "ignored-duplicate" } },
        { sequence: 4, at: 400, type: "status", status: { state: "completed", id, attempt: 1, exitCode: 3 } },
      ]),
    ).toEqual({ status: completed, lastSequence: 3, shellLines: [{ sequence: 1, stream: "stdout", line: "READY" }], messages: [], usageByAttempt: new Map() });
  });

  test("parses complete JSONL records while ignoring a torn tail", () => {
    const contents = [
      JSON.stringify({ sequence: 1, at: 100, type: "status", status: running }),
      "{\"sequence\":2",
      JSON.stringify({ sequence: 2, at: 200, type: "terminal", status: completed }),
      "",
    ].join("\n");
    expect(parseRunnerJsonl(contents)).toEqual({ status: completed, lastSequence: 2, shellLines: [], messages: [], usageByAttempt: new Map() });
  });

  test("sums only valid assistant usage under the active attempt and keeps messages unchanged", () => {
    const secondRunning: RunStatus = { ...running, attempt: 2, pid: 43, startedAt: 300, updatedAt: 300 };
    const secondCompleted: RunStatus = { ...completed, attempt: 2, endedAt: 500 };
    const usageOne: Usage = {
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 5,
      cacheWrite1h: 1,
      reasoning: 2,
      totalTokens: 9,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
    };
    const usageTwo: Usage = {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 1,
      reasoning: 3,
      totalTokens: 3,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0.01, total: 0.04 },
    };
    const usageThree: Usage = {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 60,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
    const firstMessage = { role: "assistant", content: [], usage: usageOne };
    const secondMessage = { role: "assistant", content: [], usage: usageTwo };
    const ignoredUserMessage = { role: "user", content: "ignored", usage: usageThree };
    const ignoredInvalidMessage = { role: "assistant", content: [], usage: { ...usageThree, input: -1 } };
    const result = reduceRunRecords([
      { sequence: 1, at: 100, type: "status", status: running },
      { sequence: 2, at: 110, type: "message", event: firstMessage },
      { sequence: 3, at: 120, type: "message", event: secondMessage },
      { sequence: 4, at: 130, type: "message", event: ignoredUserMessage },
      { sequence: 5, at: 200, type: "terminal", status: completed },
      { sequence: 6, at: 300, type: "status", status: secondRunning },
      { sequence: 7, at: 310, type: "message", event: { role: "assistant", content: [], usage: usageThree } },
      { sequence: 8, at: 320, type: "message", event: ignoredInvalidMessage },
      { sequence: 9, at: 500, type: "terminal", status: secondCompleted },
    ]);

    expect([...result.usageByAttempt]).toEqual([
      [1, {
        input: 3,
        output: 5,
        cacheRead: 4,
        cacheWrite: 6,
        cacheWrite1h: 1,
        reasoning: 5,
        totalTokens: 12,
        cost: { input: 0.11, output: 0.22, cacheRead: 0.3, cacheWrite: 0.41000000000000003, total: 1.04 },
      }],
      [2, usageThree],
    ]);
    expect(result.messages).toEqual([firstMessage, secondMessage, ignoredUserMessage, { role: "assistant", content: [], usage: usageThree }, ignoredInvalidMessage]);
  });

  test("classifies only terminal states as terminal", () => {
    expect(isTerminalStatus(running)).toBe(false);
    expect(isTerminalStatus(completed)).toBe(true);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});
