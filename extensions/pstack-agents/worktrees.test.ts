import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseRunId } from "./contracts.ts";
import { createWorktree, validateNamedBaseRef } from "./worktrees.ts";

const roots: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pstack-agents-git-test-"));
  roots.push(root);
  execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Test Agent"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"], { stdio: "ignore" });
  writeFileSync(path.join(root, "README.md"), "clean source\n");
  execFileSync("git", ["-C", root, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], { stdio: "ignore" });
  const origin = mkdtempSync(path.join(os.tmpdir(), "pstack-agents-git-origin-"));
  roots.push(origin);
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "remote", "add", "origin", origin], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "push", "--set-upstream", "origin", "main"], { stdio: "ignore" });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloud worktree admission", () => {
  test("admits a clean source and a named local branch", () => {
    const repository = createRepository();
    const admission = validateNamedBaseRef(repository, "main");
    const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(admission).toEqual({ repository: realpathSync(repository), baseRef: "main", baseCommit: head });
  });

  test("rejects a dirty source worktree, including untracked files", () => {
    const repository = createRepository();
    writeFileSync(path.join(repository, "untracked.txt"), "dirty\n");
    expect(() => validateNamedBaseRef(repository, "main")).toThrow("requires a clean source worktree");
  });

  test("rejects raw SHA selectors even when they resolve to a commit", () => {
    const repository = createRepository();
    const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(() => validateNamedBaseRef(repository, head)).toThrow("not a raw SHA");
  });

  test("creates one retained worktree on a new branch at the requested named base", async () => {
    const repository = createRepository();
    const runId = parseRunId("22222222-2222-4222-8222-222222222222");
    if (!runId) throw new Error("Test run identifier must be a UUID");
    const runDirectory = mkdtempSync(path.join(os.tmpdir(), "pstack-agents-run-test-"));
    roots.push(runDirectory);
    const result = await createWorktree({ repository, baseRef: "main", runId, runDirectory });
    expect(result.branch).toBe(`pstack-agents/${runId}`);
    expect(result.baseRef).toBe("origin/main");
    expect(execFileSync("git", ["-C", result.path, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe(result.branch);
    expect(execFileSync("git", ["-C", result.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(result.baseCommit);
  });

  test("reuses a cloud worktree's original base after origin advances", async () => {
    const repository = createRepository();
    const runId = parseRunId("55555555-5555-4555-8555-555555555555");
    if (!runId) throw new Error("Test run identifier must be a UUID");
    const runDirectory = mkdtempSync(path.join(os.tmpdir(), "pstack-agents-run-test-"));
    roots.push(runDirectory);
    const originalBase = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const created = await createWorktree({ repository, baseRef: "main", runId, runDirectory });
    writeFileSync(path.join(repository, "README.md"), "advanced remote base\n");
    execFileSync("git", ["-C", repository, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", repository, "commit", "-m", "advance origin"], { stdio: "ignore" });
    execFileSync("git", ["-C", repository, "push", "origin", "main"], { stdio: "ignore" });

    const resumed = await createWorktree({ repository, baseRef: "main", runId, runDirectory, expectedBaseCommit: originalBase });
    expect(resumed.baseCommit).toBe(originalBase);
    expect(execFileSync("git", ["-C", created.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(originalBase);
  });

  test("resolves only a fetched origin branch for cloud worktrees", async () => {
    const repository = createRepository();
    const runId = parseRunId("33333333-3333-4333-8333-333333333333");
    if (!runId) throw new Error("Test run identifier must be a UUID");
    const runDirectory = mkdtempSync(path.join(os.tmpdir(), "pstack-agents-run-test-"));
    roots.push(runDirectory);
    const head = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = await createWorktree({ repository, baseRef: "main", runId, runDirectory });
    expect(result).toMatchObject({ baseRef: "origin/main", baseCommit: head });
    const otherRunId = parseRunId("44444444-4444-4444-8444-444444444444");
    if (!otherRunId) throw new Error("Test run identifier must be a UUID");
    const otherRunDirectory = mkdtempSync(path.join(os.tmpdir(), "pstack-agents-run-test-"));
    roots.push(otherRunDirectory);
    await expect(createWorktree({ repository, baseRef: head, runId: otherRunId, runDirectory: otherRunDirectory })).rejects.toThrow("named Git branch");
  });
});
