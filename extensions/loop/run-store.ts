/**
 * Durable store for /loop run records. One JSON file per run under
 * PSTACK_RUNS_DIR (default ~/.pi/agent/pstack/runs). Writes are atomic
 * (temp file in the same directory, then rename) so a crash never leaves a
 * half-written record in place of a good one.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isRunPhase, type RunRecord } from "./fsm.ts";

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function runsDir(): string {
  return process.env.PSTACK_RUNS_DIR ?? join(homedir(), ".pi", "agent", "pstack", "runs");
}

export function isValidRunId(runId: string): boolean {
  if (runId === "." || runId === ".." || runId.includes("..")) return false;
  return RUN_ID_RE.test(runId);
}

export function runPath(runId: string): string {
  if (!isValidRunId(runId)) throw new Error(`invalid runId: ${runId}`);
  const dir = resolve(runsDir());
  const file = resolve(dir, `${runId}.json`);
  if (!file.startsWith(dir + sep)) throw new Error(`runId escapes the runs directory: ${runId}`);
  return file;
}

export function parseRun(text: string, source: string): RunRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`corrupt run record at ${source}: ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`corrupt run record at ${source}: expected a JSON object`);
  }
  const record = parsed as Partial<RunRecord>;
  if (typeof record.runId !== "string" || !isValidRunId(record.runId)) {
    throw new Error(`corrupt run record at ${source}: invalid runId`);
  }
  if (!isRunPhase(record.phase)) {
    throw new Error(`corrupt run record at ${source}: unknown phase ${String(record.phase)}`);
  }
  if (!Array.isArray(record.iterations) || !Array.isArray(record.eventIds)) {
    throw new Error(`corrupt run record at ${source}: iterations and eventIds must be arrays`);
  }
  return record as RunRecord;
}

function tempName(runId: string): string {
  const noise = Math.random().toString(36).slice(2, 10);
  return `.${runId}.${process.pid}.${noise}.tmp`;
}

export function saveRun(record: RunRecord): RunRecord {
  const file = runPath(record.runId);
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), tempName(record.runId));
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

export function loadRun(runId: string): RunRecord | null {
  const file = runPath(runId);
  if (!existsSync(file)) return null;
  return parseRun(readFileSync(file, "utf8"), file);
}

function runIdsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter(isValidRunId)
    .toSorted();
}

export function listRuns(): RunRecord[] {
  const dir = runsDir();
  if (!existsSync(dir)) return [];
  return runIdsIn(dir)
    .map((runId) => loadRun(runId))
    .filter((record): record is RunRecord => record !== null);
}

export function latestRun(): RunRecord | null {
  const runs = listRuns();
  if (runs.length === 0) return null;
  return runs.reduce((latest, record) => (record.updatedAt > latest.updatedAt ? record : latest));
}

export function deleteRun(runId: string): boolean {
  const file = runPath(runId);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
