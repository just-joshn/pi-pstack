import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/repo-root.mjs";

const ROOT = repoRoot(import.meta.url);

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

test("content-11 keeps the simulator reclaimers and the keep-guard in the ported playbook", () => {
  const text = read("skills/poteto-mode/playbooks/worktree-cleanup.md");
  for (const needle of [
    "xcrun simctl --set testing delete all",
    "xcrun simctl delete unavailable",
    "runtime delete",
    "Clear only caches the user has not said to keep",
    "~/.pi/agent",
  ]) {
    expect(text.includes(needle), `the reclaimed playbook must keep: ${needle}`).toBeTruthy();
  }
  expect(!text.includes("Application Support/Cursor"), "the Cursor app-support path must not survive porting").toBeTruthy();
  expect(!text.includes(".cursor/projects"), "the Cursor transcript path must not survive porting").toBeTruthy();
});

test("content-12 the audit lever classifies from git worktree list and never deletes", () => {
  const text = read("skills/poteto-mode/scripts/worktree-audit.sh");
  expect(text.includes("git worktree list --porcelain"), "paths must come from git worktree list rather than a hand-typed root").toBeTruthy();
  for (const bucket of ["hold-wip", "hold-open-pr", "verify-recent-chat", "safe", "review"]) {
    expect(text.includes(bucket), `the bucket ${bucket} must be classified`).toBeTruthy();
  }
  expect(text.includes('dirty="wip:'), "tracked edits must be classified as wip").toBeTruthy();
  expect(text.includes("scratch:"), "untracked-only trees must be classified as scratch").toBeTruthy();
  expect(text.includes("$HOME/.pi/agent/sessions"), "the transcript scan must read the Pi session store").toBeTruthy();
  expect(!text.includes("git worktree remove"), "the audit must not delete").toBeTruthy();
  expect(!text.includes("rm -rf"), "the audit must not delete").toBeTruthy();
});
