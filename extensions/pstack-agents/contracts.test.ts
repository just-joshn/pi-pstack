import { describe, expect, test } from "bun:test";
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
    expect(parseRunId(id)).toBe(id);
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
    ).toEqual({ status: completed, lastSequence: 3, shellLines: [{ sequence: 1, stream: "stdout", line: "READY" }], messages: [] });
  });

  test("parses complete JSONL records while ignoring a torn tail", () => {
    const contents = [
      JSON.stringify({ sequence: 1, at: 100, type: "status", status: running }),
      "{\"sequence\":2",
      JSON.stringify({ sequence: 2, at: 200, type: "terminal", status: completed }),
      "",
    ].join("\n");
    expect(parseRunnerJsonl(contents)).toEqual({ status: completed, lastSequence: 2, shellLines: [], messages: [] });
  });

  test("classifies only terminal states as terminal", () => {
    expect(isTerminalStatus(running)).toBe(false);
    expect(isTerminalStatus(completed)).toBe(true);
    expect(isTerminalStatus(undefined)).toBe(false);
  });
});
