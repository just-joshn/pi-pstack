export type Brand<Name extends string> = string & { readonly __brand: Name };
export type RunId = Brand<"RunId">;
export type SessionFile = Brand<"SessionFile">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseRunId(value: unknown): RunId | undefined {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return undefined;
  return value as RunId;
}

export type RunStatus =
  | { state: "starting"; id: RunId; attempt: number; updatedAt: number }
  | { state: "running"; id: RunId; attempt: number; pid: number; startedAt: number; updatedAt: number }
  | { state: "completed"; id: RunId; attempt: number; exitCode: 0; stopReason: string; endedAt: number }
  | { state: "failed"; id: RunId; attempt: number; exitCode: number; stopReason: "error" | "aborted" | "signal"; endedAt: number; error?: string }
  | { state: "stopped"; id: RunId; attempt: number; endedAt: number; signal?: string };

export type TerminalRunStatus = Extract<RunStatus, { state: "completed" | "failed" | "stopped" }>;

export type ShellLine = {
  sequence: number;
  stream: "stdout" | "stderr";
  line: string;
};

export type RunnerRecord =
  | { sequence: number; at: number; type: "status"; status: RunStatus }
  | { sequence: number; at: number; type: "shell-line"; lineSequence: number; stream: "stdout" | "stderr"; line: string }
  | { sequence: number; at: number; type: "message"; event: Record<string, unknown> }
  | { sequence: number; at: number; type: "terminal"; status: TerminalRunStatus };

export type RunRecordSummary = {
  status?: RunStatus;
  lastSequence: number;
  shellLines: ShellLine[];
  messages: Record<string, unknown>[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseRunStatus(value: unknown): RunStatus | undefined {
  if (!isRecord(value)) return undefined;
  const id = parseRunId(value.id);
  const attempt = value.attempt;
  if (!id || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) return undefined;

  switch (value.state) {
    case "starting":
      if (!finiteNumber(value.updatedAt)) return undefined;
      return { state: "starting", id, attempt: Number(attempt), updatedAt: value.updatedAt };
    case "running":
      if (!finiteNumber(value.pid) || !finiteNumber(value.startedAt) || !finiteNumber(value.updatedAt)) return undefined;
      return { state: "running", id, attempt: Number(attempt), pid: value.pid, startedAt: value.startedAt, updatedAt: value.updatedAt };
    case "completed":
      if (value.exitCode !== 0 || typeof value.stopReason !== "string" || !finiteNumber(value.endedAt)) return undefined;
      return { state: "completed", id, attempt: Number(attempt), exitCode: 0, stopReason: value.stopReason, endedAt: value.endedAt };
    case "failed": {
      const stopReason = value.stopReason;
      if (!finiteNumber(value.exitCode) || (stopReason !== "error" && stopReason !== "aborted" && stopReason !== "signal") || !finiteNumber(value.endedAt)) return undefined;
      return {
        state: "failed",
        id,
        attempt,
        exitCode: value.exitCode,
        stopReason,
        endedAt: value.endedAt,
        ...(typeof value.error === "string" ? { error: value.error } : {}),
      };
    }
    case "stopped":
      if (!finiteNumber(value.endedAt)) return undefined;
      return {
        state: "stopped",
        id,
        attempt: Number(attempt),
        endedAt: value.endedAt,
        ...(typeof value.signal === "string" ? { signal: value.signal } : {}),
      };
    default:
      return undefined;
  }
}

function parseRunnerRecord(value: unknown): RunnerRecord | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !finiteNumber(value.at)) return undefined;
  switch (value.type) {
    case "status": {
      const status = parseRunStatus(value.status);
      return status ? { sequence: Number(value.sequence), at: value.at, type: "status", status } : undefined;
    }
    case "terminal": {
      const status = parseRunStatus(value.status);
      if (!isTerminalStatus(status)) return undefined;
      return { sequence: Number(value.sequence), at: value.at, type: "terminal", status };
    }
    case "shell-line":
      if (!Number.isSafeInteger(value.lineSequence) || Number(value.lineSequence) < 1) return undefined;
      if (value.stream !== "stdout" && value.stream !== "stderr") return undefined;
      if (typeof value.line !== "string") return undefined;
      return {
        sequence: Number(value.sequence),
        at: value.at,
        type: "shell-line",
        lineSequence: Number(value.lineSequence),
        stream: value.stream,
        line: value.line,
      };
    case "message":
      return isRecord(value.event) ? { sequence: Number(value.sequence), at: value.at, type: "message", event: value.event } : undefined;
    default:
      return undefined;
  }
}

export function reduceRunRecords(records: readonly unknown[]): RunRecordSummary {
  const parsed = records.map(parseRunnerRecord).filter((record): record is RunnerRecord => record !== undefined);
  parsed.sort((a, b) => a.sequence - b.sequence);

  let status: RunStatus | undefined;
  let lastSequence = 0;
  const shellLines: ShellLine[] = [];
  const messages: Record<string, unknown>[] = [];

  for (const record of parsed) {
    if (record.sequence <= lastSequence) continue;
    lastSequence = record.sequence;
    if (record.type === "status" || record.type === "terminal") status = record.status;
    if (record.type === "shell-line") shellLines.push({ sequence: record.lineSequence, stream: record.stream, line: record.line });
    if (record.type === "message") messages.push(record.event);
  }

  return { status, lastSequence, shellLines, messages };
}

export function parseRunnerJsonl(contents: string): RunRecordSummary {
  const records: unknown[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return reduceRunRecords(records);
}

export function isTerminalStatus(status: RunStatus | undefined): status is TerminalRunStatus {
  return status?.state === "completed" || status?.state === "failed" || status?.state === "stopped";
}
