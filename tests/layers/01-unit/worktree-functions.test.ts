import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PSTACK_WORKTREES,
  WorktreeSanitizeError,
  cleanupPstackWorktreesOnShutdown,
  countPstackWorktrees,
  createIsolatedWorktree,
  ensureAlwaysIsolated,
  ensureWriterIsolation,
  hasRecentChildActivity,
  pruneWorktrees,
  removeWorktree,
  sanitizeBaseRef,
  sanitizeWorktreeName,
  worktreeRoot,
} from "../../../extensions/worktree/helpers.ts";
import { registerWorktree } from "../../../extensions/worktree/index.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { cwd: string },
  ) => Promise<ToolResult>;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repo, encoding: "utf8" });
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pstack-wtfn-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
  return dir;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function rejection(run: () => unknown): string {
  const error = captureError(run);
  return error instanceof Error ? error.message : String(error);
}

async function asyncRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to reject");
}

function worktreeHarness(): {
  tool: () => CapturedTool;
  shutdown: (ctx: { cwd: string }) => Promise<void>;
} {
  let tool: CapturedTool | undefined;
  let shutdown: ((event: unknown, ctx: { cwd: string }) => Promise<void>) | undefined;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: { cwd: string }) => Promise<void>) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    async exec() {
      return { code: 0, stdout: "wt-list", stderr: "" };
    },
  };
  registerWorktree(pi as never);
  const handler = shutdown as (event: unknown, ctx: { cwd: string }) => Promise<void>;
  return { tool: () => tool as CapturedTool, shutdown: (ctx) => handler({}, ctx) };
}

test("worktree-functions-01 rejects path and option injection in names and refs", () => {
  expect(sanitizeWorktreeName("  feat-one  ")).toBe("feat-one");
  expect(sanitizeWorktreeName("a.b_c@d+e,f=g")).toBe("a.b_c@d+e,f=g");
  expect(captureError(() => sanitizeWorktreeName("-x")).name).toBe("WorktreeSanitizeError");

  const nameCases: Array<[string, string]> = [
    ["", "worktree name required"],
    ["   ", "worktree name required"],
    ["-rf", "worktree name must not start with '-'"],
    ["../escape", "worktree name must not contain '..', path separators, or NUL"],
    ["a/b", "worktree name must not contain '..', path separators, or NUL"],
    ["a\\b", "worktree name must not contain '..', path separators, or NUL"],
    ["a\u0000b", "worktree name must not contain '..', path separators, or NUL"],
    ["has space", "worktree name has unsupported characters"],
    ["semi;colon", "worktree name has unsupported characters"],
  ];
  for (const [value, message] of nameCases) {
    expect(rejection(() => sanitizeWorktreeName(value)), value).toBe(message);
  }

  expect(sanitizeBaseRef("  origin/main  ")).toBe("origin/main");
  expect(sanitizeBaseRef("main~1")).toBe("main~1");
  expect(sanitizeBaseRef("v1.0.0^")).toBe("v1.0.0^");
  const refCases: Array<[string, string]> = [
    ["", "base ref required"],
    ["   ", "base ref required"],
    ["-x", "base ref must not start with '-'"],
    ["a..b", "base ref must not contain '..', whitespace, or NUL"],
    ["a b", "base ref must not contain '..', whitespace, or NUL"],
    ["a\tb", "base ref must not contain '..', whitespace, or NUL"],
    ["a\u0000b", "base ref must not contain '..', whitespace, or NUL"],
    ["a:b", "base ref has unsupported characters"],
    ["a;b", "base ref has unsupported characters"],
  ];
  for (const [value, message] of refCases) {
    expect(rejection(() => sanitizeBaseRef(value)), value).toBe(message);
  }
});

test("worktree-functions-02 counts only directories under the pstack root", () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    expect(worktreeRoot(dir)).toBe(join(dir, ".pstack-worktrees"));
    expect(countPstackWorktrees(dir)).toBe(0);
    mkdirSync(join(dir, ".pstack-worktrees", "one"), { recursive: true });
    mkdirSync(join(dir, ".pstack-worktrees", "two"), { recursive: true });
    writeFileSync(join(dir, ".pstack-worktrees", "loose.txt"), "x", "utf8");
    expect(countPstackWorktrees(dir)).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-functions-03 creates a real worktree on a new branch", async () => {
  const repo = tempRepo();
  try {
    const created = await createIsolatedWorktree(repo, "feat-one");
    expect(created.path).toBe(join(repo, ".pstack-worktrees", "feat-one"));
    expect(created.branch).toBe("pstack/feat-one");
    expect(existsSync(created.path)).toBe(true);
    expect(existsSync(join(created.path, ".git"))).toBe(true);
    expect(git(repo, ["branch", "--list", "pstack/feat-one"]).includes("pstack/feat-one")).toBe(true);
    expect(git(repo, ["worktree", "list", "--porcelain"]).includes(created.path)).toBe(true);
    expect(readdirSync(join(repo, ".pstack-worktrees"))).toEqual(["feat-one"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-04 refuses names that escape the worktree root", async () => {
  const repo = tempRepo();
  try {
    await createIsolatedWorktree(repo, "keeper");
    expect(await asyncRejection(() => createIsolatedWorktree(repo, "../escape"))).toBe("worktree name must not contain '..', path separators, or NUL");
    expect(await asyncRejection(() => createIsolatedWorktree(repo, "-rf"))).toBe("worktree name must not start with '-'");
    expect(await asyncRejection(() => createIsolatedWorktree(repo, "ok", "--force"))).toBe("base ref must not start with '-'");
    expect(readdirSync(join(repo, ".pstack-worktrees"))).toEqual(["keeper"]);
    expect(existsSync(join(repo, "escape"))).toBe(false);
    expect(existsSync(join(repo, "..", "escape"))).toBe(false);
    expect(readdirSync(join(repo, ".pstack-worktrees")).includes("-rf")).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-05 refuses to create past the 12-worktree cap", async () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    expect(MAX_PSTACK_WORKTREES).toBe(12);
    for (const index of Array.from({ length: MAX_PSTACK_WORKTREES }, (_, value) => value)) {
      mkdirSync(join(dir, ".pstack-worktrees", `slot-${index}`), { recursive: true });
    }
    expect(countPstackWorktrees(dir)).toBe(12);
    expect(await asyncRejection(() => createIsolatedWorktree(dir, "overflow"))).toBe("pstack worktree session cap (12) reached; remove/prune before creating more");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-functions-06 removes a real worktree and prunes", async () => {
  const repo = tempRepo();
  try {
    const created = await createIsolatedWorktree(repo, "gone");
    expect(await removeWorktree(repo, "gone")).toBe(created.path);
    expect(existsSync(created.path)).toBe(false);
    expect(git(repo, ["worktree", "list", "--porcelain"]).includes(created.path)).toBe(false);
    expect(await pruneWorktrees(repo)).toBe("pruned");
    expect(await asyncRejection(() => removeWorktree(repo, "a/b"))).toBe("worktree name must not contain '..', path separators, or NUL");
    expect(await asyncRejection(() => removeWorktree(repo, "never-made"))).toMatch(/git worktree remove/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-07 returns explicit cwds for one writer without spawning", async () => {
  const repo = tempRepo();
  try {
    expect(await ensureWriterIsolation(repo, [])).toEqual([]);
    expect(await ensureWriterIsolation(repo, [{ label: "solo" }])).toEqual([repo]);
    expect(await ensureWriterIsolation(repo, [{ label: "solo", cwd: "/tmp/explicit" }])).toEqual([
      "/tmp/explicit",
    ]);
    expect(existsSync(join(repo, ".pstack-worktrees"))).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-08 auto-allocates a worktree per writer and rejects a shared cwd", async () => {
  const repo = tempRepo();
  try {
    const assigned = await ensureWriterIsolation(repo, [{ label: "a" }, { label: "b" }]);
    expect(assigned.length).toBe(2);
    expect(assigned[0] !== assigned[1]).toBe(true);
    expect(assigned.includes(repo)).toBe(false);
    expect(assigned[0].startsWith(join(repo, ".pstack-worktrees"))).toBe(true);
    expect(assigned[1].startsWith(join(repo, ".pstack-worktrees"))).toBe(true);
    expect(existsSync(assigned[0])).toBe(true);
    expect(existsSync(assigned[1])).toBe(true);
    expect(assigned[0].split("/").at(-1) ?? "").toMatch(/^auto-\d+-\d+-[0-9a-z]{1,6}$/);
    expect(assigned[1].split("/").at(-1) ?? "").toMatch(/^auto-\d+-\d+-[0-9a-z]{1,6}$/);

    const shared = join(repo, "shared");
    mkdirSync(shared, { recursive: true });
    const message = await asyncRejection(() =>
      ensureWriterIsolation(repo, [
        { label: "a", cwd: shared },
        { label: "b", cwd: shared },
      ]),
    );
    expect(message).toBe(`multi-writer isolation: b and a share cwd ${shared}; pass unique cwd or omit cwd for auto worktree`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-09 isolates the parent cwd even for a single writer", async () => {
  const repo = tempRepo();
  try {
    const mixed = await ensureWriterIsolation(repo, [
      { label: "parent", cwd: repo },
      { label: "elsewhere", cwd: join(repo, "elsewhere") },
    ]);
    expect(mixed[1]).toBe(join(repo, "elsewhere"));
    expect(mixed[0] !== repo).toBe(true);
    expect(mixed[0].split("/").at(-1) ?? "").toMatch(/^auto-\d+-\d+-[0-9a-z]{1,6}$/);

    expect(await ensureAlwaysIsolated(repo, [])).toEqual([]);
    const always = await ensureAlwaysIsolated(repo, [{ label: "only", cwd: repo }]);
    expect(always.length).toBe(1);
    expect(always[0] !== repo).toBe(true);
    expect(existsSync(always[0])).toBe(true);
    expect(await ensureAlwaysIsolated(repo, [{ label: "only", cwd: "/tmp/elsewhere" }])).toEqual([
      "/tmp/elsewhere",
    ]);
    const shared = join(repo, "shared-always");
    mkdirSync(shared, { recursive: true });
    expect(await asyncRejection(() =>
        ensureAlwaysIsolated(repo, [
          { label: "a", cwd: shared },
          { label: "b", cwd: shared },
        ]),
      )).toBe(`multi-writer isolation: b and a share cwd ${shared}; pass unique cwd or omit cwd for auto worktree`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-10 cleans merged worktrees and skips dirty or unmerged ones", async () => {
  const repo = tempRepo();
  try {
    const clean = await createIsolatedWorktree(repo, "clean");
    const dirty = await createIsolatedWorktree(repo, "dirty");
    const unmerged = await createIsolatedWorktree(repo, "unmerged");
    writeFileSync(join(dirty.path, "scratch.txt"), "x", "utf8");
    git(unmerged.path, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "unique"]);

    const result = await cleanupPstackWorktreesOnShutdown(repo);
    expect(result.removed).toEqual(["clean"]);
    expect(result.pruned).toBe("pruned");
    const skipped = result.skipped.toSorted((left, right) => left.name.localeCompare(right.name));
    expect(skipped).toEqual([
      { name: "dirty", reason: "dirty working tree" },
      { name: "unmerged", reason: "has commits not merged into HEAD" },
    ]);
    expect(existsSync(clean.path)).toBe(false);
    expect(existsSync(dirty.path)).toBe(true);
    expect(existsSync(unmerged.path)).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-11 reports a missing root and a prune failure", async () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    const missing = await cleanupPstackWorktreesOnShutdown(dir);
    expect(missing).toEqual({ removed: [], pruned: "n/a", skipped: [] });

    mkdirSync(join(dir, ".pstack-worktrees", "ghost"), { recursive: true });
    const broken = await cleanupPstackWorktreesOnShutdown(dir);
    expect(broken.removed).toEqual([]);
    expect(broken.skipped.length).toBe(1);
    expect(broken.skipped[0].name).toBe("ghost");
    expect(broken.skipped[0].reason).toMatch(/not a git repository/);
    expect(broken.pruned).toMatch(/not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-functions-12 flags recent child sessions inside a worktree", () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    expect(hasRecentChildActivity(dir)).toBe(false);
    const sessions = join(dir, ".pi", "pstack-child-sessions", "nested");
    mkdirSync(sessions, { recursive: true });
    const jsonl = join(sessions, "child.jsonl");
    writeFileSync(jsonl, "{}\n");
    expect(hasRecentChildActivity(dir)).toBe(true);
    const stamp = Date.parse("2024-01-01T00:00:00.000Z");
    utimesSync(jsonl, new Date(stamp), new Date(stamp));
    expect(hasRecentChildActivity(dir, stamp + 30 * 60 * 1000)).toBe(true);
    expect(hasRecentChildActivity(dir, stamp + 30 * 60 * 1000 + 1)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-functions-13 runs the cleanup action through the registered tool", async () => {
  const repo = tempRepo();
  try {
    const created = await createIsolatedWorktree(repo, "tidy");
    const harness = worktreeHarness();
    const cleaned = await harness.tool().execute("c", { action: "cleanup" }, undefined, undefined, { cwd: repo });
    expect(cleaned.content[0].text).toBe("cleanup removed=[tidy] skipped=0 prune=pruned");
    expect(cleaned.details).toEqual({ removed: ["tidy"], pruned: "pruned", skipped: [] });
    expect(existsSync(created.path)).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-14 lists, prunes, removes, and creates through the tool", async () => {
  const repo = tempRepo();
  try {
    const harness = worktreeHarness();
    const listed = await harness.tool().execute("l", { action: "list" }, undefined, undefined, { cwd: repo });
    expect(listed.content[0].text).toBe("wt-list\n\npstack-managed under .pstack-worktrees: 0/12");
    expect(listed.details).toEqual({ code: 0, count: 0 });

    const pruned = await harness.tool().execute("p", { action: "prune" }, undefined, undefined, { cwd: repo });
    expect(pruned.content[0].text).toBe("pruned");
    expect(pruned.details).toEqual({});

    const fresh = await createIsolatedWorktree(repo, "removable");
    const removed = await harness.tool().execute(
      "r",
      { action: "remove", name: "removable" },
      undefined,
      undefined,
      { cwd: repo },
    );
    expect(removed.content[0].text).toBe(`Removed worktree ${fresh.path}`);
    expect(removed.details).toEqual({ path: fresh.path });
    expect(existsSync(fresh.path)).toBe(false);

    const named = await harness.tool().execute(
      "n",
      { action: "create", name: "named", base: "main" },
      undefined,
      undefined,
      { cwd: repo },
    );
    expect(named.details).toEqual({ path: join(repo, ".pstack-worktrees", "named"), branch: "pstack/named" });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-15 defaults the create slug and rejects bad tool input", async () => {
  const repo = tempRepo();
  try {
    const harness = worktreeHarness();
    const before = Date.now();
    const created = await harness.tool().execute("c", { action: "create" }, undefined, undefined, { cwd: repo });
    const after = Date.now();
    const slug = String(created.details.branch).slice("pstack/".length);
    expect(slug).toMatch(/^pstack-\d+$/);
    const stamp = Number(slug.slice("pstack-".length));
    expect(stamp >= before && stamp <= after).toBe(true);
    expect(created.details).toEqual({
      path: join(repo, ".pstack-worktrees", slug),
      branch: `pstack/${slug}`,
    });

    await expect(() => harness.tool().execute("x", { action: "bogus" }, undefined, undefined, { cwd: repo })).rejects.toThrow(/action must be create\|list\|remove\|prune\|cleanup/);
    await expect(() => harness.tool().execute("x", { action: "remove" }, undefined, undefined, { cwd: repo })).rejects.toThrow(/name required for remove/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-16 skips a directory that git will not remove", async () => {
  const repo = tempRepo();
  try {
    mkdirSync(join(repo, ".pstack-worktrees", "ghostdir"), { recursive: true });
    const result = await cleanupPstackWorktreesOnShutdown(repo);
    expect(result.removed).toEqual([]);
    expect(result.pruned).toBe("pruned");
    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].name).toBe("ghostdir");
    expect(result.skipped[0].reason).toMatch(/git worktree remove/);
    expect(existsSync(join(repo, ".pstack-worktrees", "ghostdir"))).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-17 runs shutdown cleanup in the project cwd", async () => {
  const repo = tempRepo();
  const gone = tempDir("pstack-wtfn-gone-");
  try {
    const created = await createIsolatedWorktree(repo, "shutdown-clean");
    const harness = worktreeHarness();
    await harness.shutdown({ cwd: repo });
    expect(existsSync(created.path)).toBe(false);

    await expect(harness.shutdown({ cwd: join(gone, "nested") })).resolves.toSatisfy(() => true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(gone, { recursive: true, force: true });
  }
});
