import { afterAll, expect, test } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialRecord, reduceRun, type RunRecord } from "../../../extensions/loop/fsm.ts";
import { deleteRun, latestRun, listRuns, loadRun, runPath, saveRun } from "../../../extensions/loop/run-store.ts";

const dir = mkdtempSync(join(tmpdir(), "pstack-runs-"));
process.env.PSTACK_RUNS_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function cleanDir(): void {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
}

function record(runId: string, now = 1000): RunRecord {
  const base = initialRecord({ runId, now });
  return reduceRun(base, { type: "predicate_defined", predicate: "ci green" }, now).record;
}

test("saveRun and loadRun round trip a record", () => {
  cleanDir();
  const saved = record("run-alpha");
  saveRun(saved);
  const loaded = loadRun("run-alpha");
  expect(loaded).toEqual(saved);
});

test("saveRun writes atomically and leaves no temp file behind", () => {
  cleanDir();
  saveRun(record("run-atomic"));
  expect(readdirSync(dir)).toEqual(["run-atomic.json"]);
});

test("listRuns collects records and latestRun picks the most recently updated", () => {
  cleanDir();
  saveRun(record("run-old", 1000));
  saveRun(record("run-new", 2000));
  const runs = listRuns();
  expect(runs.map((run) => run.runId).toSorted()).toEqual(["run-new", "run-old"]);
  expect(latestRun()?.runId).toBe("run-new");
});

test("latestRun returns null when no run is stored", () => {
  cleanDir();
  expect(latestRun()).toBe(null);
});

test("deleteRun removes a record and reports a missing id", () => {
  cleanDir();
  saveRun(record("run-temp"));
  expect(deleteRun("run-temp")).toBe(true);
  expect(loadRun("run-temp")).toBe(null);
  expect(deleteRun("run-temp")).toBe(false);
});

test("corrupt JSON is reported instead of treated as a fresh run", () => {
  cleanDir();
  writeFileSync(join(dir, "run-broken.json"), "{ not json", "utf8");
  expect(() => loadRun("run-broken")).toThrow(/corrupt run record/);
  expect(() => listRuns()).toThrow(/corrupt run record/);
});

test("traversal and malformed run ids are rejected", () => {
  cleanDir();
  expect(() => loadRun("../escape")).toThrow(/invalid runId/);
  expect(() => loadRun("..")).toThrow(/invalid runId/);
  expect(() => loadRun("nested/run")).toThrow(/invalid runId/);
  expect(() => runPath("a b")).toThrow(/invalid runId/);
  expect(() => saveRun(record("run/escape"))).toThrow(/invalid runId/);
});
