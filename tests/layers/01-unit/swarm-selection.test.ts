import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";
import {
  parseSwarmSelection,
  selectSwarmResults,
  swarmVerdict,
} from "../../../extensions/orchestration/swarm.ts";
import { MAX_CONCURRENCY } from "../../../extensions/subagents/child-runner.ts";

const ROOT = repoRoot(import.meta.url);

const pass = { output: "verified\nPASS", exitCode: 0 };
const issues = { output: "ISSUES: one flake", exitCode: 0 };
const blocked = { output: "BLOCKED: cannot verify", exitCode: 1 };

test("swarmVerdict reads the last declared verdict token", () => {
  expect(swarmVerdict("PASS then ISSUES", 0)).toBe("ISSUES");
  expect(swarmVerdict("nothing declared", 0)).toBe("UNKNOWN");
  expect(swarmVerdict("boom", 2)).toBe("BLOCKED");
});

test("selectSwarmResults ranks and picks per the declared rule", () => {
  const results = [blocked, issues, pass];
  const coverage = selectSwarmResults(results, "coverage");
  expect(coverage.ordered).toEqual([0, 1, 2]);
  expect(coverage.winner).toBe(undefined);

  const ranked = selectSwarmResults(results, "rank-all");
  expect(ranked.ordered).toEqual([2, 1, 0]);
  expect(ranked.winner).toBe(2);

  const firstPass = selectSwarmResults([issues, pass, blocked], "first-pass");
  expect(firstPass.winner).toBe(1);

  const bestOf = selectSwarmResults(results, "best-of");
  expect(bestOf.winner).toBe(2);
});

test("selectSwarmResults reports no winner when nothing passed", () => {
  expect(selectSwarmResults([blocked, issues], "first-pass").winner).toBe(undefined);
});

test("parseSwarmSelection defaults to coverage and refuses unknown rules", () => {
  expect(parseSwarmSelection(undefined)).toBe("coverage");
  expect(parseSwarmSelection("best-of")).toBe("best-of");
  expect(() => parseSwarmSelection("race")).toThrow(/selection must be/);
});

test("the global concurrency cap is 8 and the routed skill does not restate it as a per-call cap", () => {
  expect(MAX_CONCURRENCY).toBe(8);
  const skill = readFileSync(resolve(ROOT, "skills/swarm/SKILL.md"), "utf8");
  expect(skill.includes("at most 8 per call"), "N is the total worker count; the skill must not claim a per-call cap of 8").toBe(false);
});
