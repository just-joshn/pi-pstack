/**
 * Durable run store for the hosted worker service.
 *
 * One JSON file per run under <stateDir>/runs/<runId>.json. Writes are atomic
 * (temp file in the same directory, then rename) so a crash never replaces a
 * good record with a half-written one. A corrupt record throws with its file
 * path instead of being silently recreated, so an operator sees the damage.
 *
 * Streamed output lives beside the records under <stateDir>/output/<runId>.*.log.
 * Partial output written before a worker dies survives on disk; the record is
 * the only thing that flips to a terminal state.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const RUN_STATES = Object.freeze([
  "accepted",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "dead",
]);
export const TERMINAL_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "dead",
]);
export const DEFAULT_LEASE_MS = 60_000;

export function defaultStateDir() {
  return process.env.PSTACK_WORKER_STATE_DIR ?? join(homedir(), ".pi", "agent", "pstack", "hosted");
}

export function isValidRunId(runId) {
  if (typeof runId !== "string") return false;
  if (runId === "." || runId === ".." || runId.includes("..")) return false;
  return RUN_ID_PATTERN.test(runId);
}

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

function assertRunId(runId) {
  if (!isValidRunId(runId)) throw new Error(`invalid runId: ${String(runId)}`);
}

function parseRunRecord(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`corrupt run record at ${source}: ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`corrupt run record at ${source}: expected a JSON object`);
  }
  const record = parsed;
  if (!isValidRunId(record.runId)) {
    throw new Error(`corrupt run record at ${source}: invalid runId`);
  }
  if (!RUN_STATES.includes(record.state)) {
    throw new Error(`corrupt run record at ${source}: unknown state ${String(record.state)}`);
  }
  if (!Number.isInteger(record.attempt) || record.attempt < 0) {
    throw new Error(`corrupt run record at ${source}: attempt must be a non-negative integer`);
  }
  if (typeof record.task !== "string") {
    throw new Error(`corrupt run record at ${source}: task must be a string`);
  }
  if (typeof record.idempotencyKey !== "string" || record.idempotencyKey.length === 0) {
    throw new Error(`corrupt run record at ${source}: missing idempotencyKey`);
  }
  return record;
}

function outputFileName(runId, stream) {
  if (stream !== "stdout" && stream !== "stderr") {
    throw new Error(`unknown output stream: ${String(stream)}`);
  }
  assertRunId(runId);
  return `${runId}.${stream}.log`;
}

function storeContext(options) {
  const stateDir = resolve(options.stateDir ?? defaultStateDir());
  return {
    stateDir,
    runsDir: join(stateDir, "runs"),
    outputDir: join(stateDir, "output"),
    sessionsDir: join(stateDir, "sessions"),
    now: options.now ?? (() => Date.now()),
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
  };
}

function runPathOf(ctx, runId) {
  assertRunId(runId);
  const file = resolve(ctx.runsDir, `${runId}.json`);
  if (!file.startsWith(ctx.runsDir + sep)) {
    throw new Error(`runId escapes the runs directory: ${runId}`);
  }
  return file;
}

function outputPathOf(ctx, runId, stream) {
  const file = resolve(ctx.outputDir, outputFileName(runId, stream));
  if (!file.startsWith(ctx.outputDir + sep)) {
    throw new Error(`runId escapes the output directory: ${runId}`);
  }
  return file;
}

function saveRunOf(ctx, record) {
  if (!isValidRunId(record?.runId)) throw new Error("saveRun requires a valid runId");
  const file = runPathOf(ctx, record.runId);
  mkdirSync(dirname(file), { recursive: true });
  const noise = randomBytes(4).toString("hex");
  const temp = join(dirname(file), `.${record.runId}.${process.pid}.${noise}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`atomic save failed for run ${record.runId}: ${detail}`);
  }
  return record;
}

function loadRunOf(ctx, runId) {
  const file = runPathOf(ctx, runId);
  if (!existsSync(file)) return null;
  return parseRunRecord(readFileSync(file, "utf8"), file);
}

function listRunsOf(ctx) {
  if (!existsSync(ctx.runsDir)) return [];
  const names = readdirSync(ctx.runsDir).filter((name) => name.endsWith(".json"));
  return names
    .map((name) => parseRunRecord(readFileSync(join(ctx.runsDir, name), "utf8"), join(ctx.runsDir, name)))
    .toSorted((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

function deleteRunOf(ctx, runId) {
  const file = runPathOf(ctx, runId);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

function appendOutputOf(ctx, runId, stream, text) {
  if (!text) return 0;
  const file = outputPathOf(ctx, runId, stream);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text, "utf8");
  return Buffer.byteLength(text, "utf8");
}

function readOutputOf(ctx, runId, stream) {
  const file = outputPathOf(ctx, runId, stream);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** Increment the attempt and mark the run running before the executor starts. */
function claimAttemptOf(ctx, runId) {
  const current = loadRunOf(ctx, runId);
  if (!current) throw new Error(`cannot claim an attempt for unknown run: ${runId}`);
  const at = ctx.now();
  return saveRunOf(ctx, {
    ...current,
    attempt: current.attempt + 1,
    state: "running",
    startedAt: at,
    updatedAt: at,
    leaseExpiresAt: at + ctx.leaseMs,
    finishedAt: null,
  });
}

/**
 * Mark every non-terminal run whose lease has lapsed as dead and fold its
 * partial output into the record. A restarted worker calls this so a record
 * left running by a dead worker cannot masquerade as live work.
 */
function expireStaleLeasesOf(ctx, at = ctx.now(), lease = ctx.leaseMs) {
  return listRunsOf(ctx).reduce((dead, record) => {
    if (isTerminalState(record.state)) return dead;
    if (at - record.updatedAt < lease) return dead;
    const expired = saveRunOf(ctx, {
      ...record,
      state: "dead",
      stdout: readOutputOf(ctx, record.runId, "stdout"),
      stderr: readOutputOf(ctx, record.runId, "stderr"),
      outputPath: outputPathOf(ctx, record.runId, "stdout"),
      stopReason: record.stopReason ?? "lease_expired",
      finishedAt: at,
      updatedAt: at,
      leaseExpiresAt: null,
    });
    return [...dead, expired];
  }, []);
}

/**
 * Bind a store to one state directory. Every method is synchronous, so the
 * check-then-write in claimAttempt cannot interleave with another request in
 * the same process.
 */
export function createRunStore(options = {}) {
  const ctx = storeContext(options);
  return {
    stateDir: ctx.stateDir,
    runsDir: ctx.runsDir,
    outputDir: ctx.outputDir,
    sessionsDir: ctx.sessionsDir,
    runPath: (runId) => runPathOf(ctx, runId),
    outputPath: (runId, stream) => outputPathOf(ctx, runId, stream),
    saveRun: (record) => saveRunOf(ctx, record),
    loadRun: (runId) => loadRunOf(ctx, runId),
    listRuns: () => listRunsOf(ctx),
    deleteRun: (runId) => deleteRunOf(ctx, runId),
    appendOutput: (runId, stream, text) => appendOutputOf(ctx, runId, stream, text),
    readOutput: (runId, stream) => readOutputOf(ctx, runId, stream),
    claimAttempt: (runId) => claimAttemptOf(ctx, runId),
    expireStaleLeases: (at, lease) => expireStaleLeasesOf(ctx, at, lease),
  };
}
