import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSwarmSelection,
  selectSwarmResults,
  swarmVerdict,
} from "../../../extensions/orchestration/swarm.ts";
import { MAX_CONCURRENCY } from "../../../extensions/subagents/child-runner.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const pass = { output: "verified\nPASS", exitCode: 0 };
const issues = { output: "ISSUES: one flake", exitCode: 0 };
const blocked = { output: "BLOCKED: cannot verify", exitCode: 1 };

test("swarmVerdict reads the last declared verdict token", () => {
  assert.equal(swarmVerdict("PASS then ISSUES", 0), "ISSUES");
  assert.equal(swarmVerdict("nothing declared", 0), "UNKNOWN");
  assert.equal(swarmVerdict("boom", 2), "BLOCKED");
});

test("selectSwarmResults ranks and picks per the declared rule", () => {
  const results = [blocked, issues, pass];
  const coverage = selectSwarmResults(results, "coverage");
  assert.deepEqual(coverage.ordered, [0, 1, 2]);
  assert.equal(coverage.winner, undefined);

  const ranked = selectSwarmResults(results, "rank-all");
  assert.deepEqual(ranked.ordered, [2, 1, 0]);
  assert.equal(ranked.winner, 2);

  const firstPass = selectSwarmResults([issues, pass, blocked], "first-pass");
  assert.equal(firstPass.winner, 1);

  const bestOf = selectSwarmResults(results, "best-of");
  assert.equal(bestOf.winner, 2);
});

test("selectSwarmResults reports no winner when nothing passed", () => {
  assert.equal(selectSwarmResults([blocked, issues], "first-pass").winner, undefined);
});

test("parseSwarmSelection defaults to coverage and refuses unknown rules", () => {
  assert.equal(parseSwarmSelection(undefined), "coverage");
  assert.equal(parseSwarmSelection("best-of"), "best-of");
  assert.throws(() => parseSwarmSelection("race"), /selection must be/);
});

test("the global concurrency cap is 8 and the routed skill does not restate it as a per-call cap", () => {
  assert.equal(MAX_CONCURRENCY, 8);
  const skill = readFileSync(resolve(ROOT, "skills/swarm/SKILL.md"), "utf8");
  assert.equal(
    skill.includes("at most 8 per call"),
    false,
    "N is the total worker count; the skill must not claim a per-call cap of 8",
  );
});
