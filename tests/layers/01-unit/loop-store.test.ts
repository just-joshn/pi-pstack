import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialRecord, reduceRun, type RunRecord } from "../../../extensions/loop/fsm.ts";
import { deleteRun, latestRun, listRuns, loadRun, runPath, saveRun } from "../../../extensions/loop/run-store.ts";

const dir = mkdtempSync(join(tmpdir(), "pstack-runs-"));
process.env.PSTACK_RUNS_DIR = dir;

after(() => {
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
  assert.deepEqual(loaded, saved);
});

test("saveRun writes atomically and leaves no temp file behind", () => {
  cleanDir();
  saveRun(record("run-atomic"));
  assert.deepEqual(readdirSync(dir), ["run-atomic.json"]);
});

test("listRuns collects records and latestRun picks the most recently updated", () => {
  cleanDir();
  saveRun(record("run-old", 1000));
  saveRun(record("run-new", 2000));
  const runs = listRuns();
  assert.deepEqual(runs.map((run) => run.runId).toSorted(), ["run-new", "run-old"]);
  assert.equal(latestRun()?.runId, "run-new");
});

test("latestRun returns null when no run is stored", () => {
  cleanDir();
  assert.equal(latestRun(), null);
});

test("deleteRun removes a record and reports a missing id", () => {
  cleanDir();
  saveRun(record("run-temp"));
  assert.equal(deleteRun("run-temp"), true);
  assert.equal(loadRun("run-temp"), null);
  assert.equal(deleteRun("run-temp"), false);
});

test("corrupt JSON is reported instead of treated as a fresh run", () => {
  cleanDir();
  writeFileSync(join(dir, "run-broken.json"), "{ not json", "utf8");
  assert.throws(() => loadRun("run-broken"), /corrupt run record/);
  assert.throws(() => listRuns(), /corrupt run record/);
});

test("traversal and malformed run ids are rejected", () => {
  cleanDir();
  assert.throws(() => loadRun("../escape"), /invalid runId/);
  assert.throws(() => loadRun(".."), /invalid runId/);
  assert.throws(() => loadRun("nested/run"), /invalid runId/);
  assert.throws(() => runPath("a b"), /invalid runId/);
  assert.throws(() => saveRun(record("run/escape")), /invalid runId/);
});
