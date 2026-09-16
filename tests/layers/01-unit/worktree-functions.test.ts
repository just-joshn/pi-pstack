import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(sanitizeWorktreeName("  feat-one  "), "feat-one");
  assert.equal(sanitizeWorktreeName("a.b_c@d+e,f=g"), "a.b_c@d+e,f=g");
  assert.equal(captureError(() => sanitizeWorktreeName("-x")).name, "WorktreeSanitizeError");

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
    assert.equal(rejection(() => sanitizeWorktreeName(value)), message, value);
  }

  assert.equal(sanitizeBaseRef("  origin/main  "), "origin/main");
  assert.equal(sanitizeBaseRef("main~1"), "main~1");
  assert.equal(sanitizeBaseRef("v1.0.0^"), "v1.0.0^");
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
    assert.equal(rejection(() => sanitizeBaseRef(value)), message, value);
  }
});

test("worktree-functions-02 counts only directories under the pstack root", () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    assert.equal(worktreeRoot(dir), join(dir, ".pstack-worktrees"));
    assert.equal(countPstackWorktrees(dir), 0);
    mkdirSync(join(dir, ".pstack-worktrees", "one"), { recursive: true });
    mkdirSync(join(dir, ".pstack-worktrees", "two"), { recursive: true });
    writeFileSync(join(dir, ".pstack-worktrees", "loose.txt"), "x", "utf8");
    assert.equal(countPstackWorktrees(dir), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-functions-03 creates a real worktree on a new branch", async () => {
  const repo = tempRepo();
  try {
    const created = await createIsolatedWorktree(repo, "feat-one");
    assert.equal(created.path, join(repo, ".pstack-worktrees", "feat-one"));
    assert.equal(created.branch, "pstack/feat-one");
    assert.equal(existsSync(created.path), true);
    assert.equal(existsSync(join(created.path, ".git")), true);
    assert.equal(git(repo, ["branch", "--list", "pstack/feat-one"]).includes("pstack/feat-one"), true);
    assert.equal(git(repo, ["worktree", "list", "--porcelain"]).includes(created.path), true);
    assert.deepEqual(readdirSync(join(repo, ".pstack-worktrees")), ["feat-one"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-04 refuses names that escape the worktree root", async () => {
  const repo = tempRepo();
  try {
    await createIsolatedWorktree(repo, "keeper");
    assert.equal(
      await asyncRejection(() => createIsolatedWorktree(repo, "../escape")),
      "worktree name must not contain '..', path separators, or NUL",
    );
    assert.equal(
      await asyncRejection(() => createIsolatedWorktree(repo, "-rf")),
      "worktree name must not start with '-'",
    );
    assert.equal(
      await asyncRejection(() => createIsolatedWorktree(repo, "ok", "--force")),
      "base ref must not start with '-'",
    );
    assert.deepEqual(readdirSync(join(repo, ".pstack-worktrees")), ["keeper"]);
    assert.equal(existsSync(join(repo, "escape")), false);
    assert.equal(existsSync(join(repo, "..", "escape")), false);
    assert.equal(readdirSync(join(repo, ".pstack-worktrees")).includes("-rf"), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-05 refuses to create past the 12-worktree cap", async () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    assert.equal(MAX_PSTACK_WORKTREES, 12);
    for (const index of Array.from({ length: MAX_PSTACK_WORKTREES }, (_, value) => value)) {
      mkdirSync(join(dir, ".pstack-worktrees", `slot-${index}`), { recursive: true });
    }
    assert.equal(countPstackWorktrees(dir), 12);
    assert.equal(
      await asyncRejection(() => createIsolatedWorktree(dir, "overflow")),
      "pstack worktree session cap (12) reached; remove/prune before creating more",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-functions-06 removes a real worktree and prunes", async () => {
  const repo = tempRepo();
  try {
    const created = await createIsolatedWorktree(repo, "gone");
    assert.equal(await removeWorktree(repo, "gone"), created.path);
    assert.equal(existsSync(created.path), false);
    assert.equal(git(repo, ["worktree", "list", "--porcelain"]).includes(created.path), false);
    assert.equal(await pruneWorktrees(repo), "pruned");
    assert.equal(
      await asyncRejection(() => removeWorktree(repo, "a/b")),
      "worktree name must not contain '..', path separators, or NUL",
    );
    assert.match(await asyncRejection(() => removeWorktree(repo, "never-made")), /git worktree remove/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-07 returns explicit cwds for one writer without spawning", async () => {
  const repo = tempRepo();
  try {
    assert.deepEqual(await ensureWriterIsolation(repo, []), []);
    assert.deepEqual(await ensureWriterIsolation(repo, [{ label: "solo" }]), [repo]);
    assert.deepEqual(await ensureWriterIsolation(repo, [{ label: "solo", cwd: "/tmp/explicit" }]), [
      "/tmp/explicit",
    ]);
    assert.equal(existsSync(join(repo, ".pstack-worktrees")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-08 auto-allocates a worktree per writer and rejects a shared cwd", async () => {
  const repo = tempRepo();
  try {
    const assigned = await ensureWriterIsolation(repo, [{ label: "a" }, { label: "b" }]);
    assert.equal(assigned.length, 2);
    assert.equal(assigned[0] !== assigned[1], true);
    assert.equal(assigned.includes(repo), false);
    assert.equal(assigned[0].startsWith(join(repo, ".pstack-worktrees")), true);
    assert.equal(assigned[1].startsWith(join(repo, ".pstack-worktrees")), true);
    assert.equal(existsSync(assigned[0]), true);
    assert.equal(existsSync(assigned[1]), true);
    assert.match(assigned[0].split("/").at(-1) ?? "", /^auto-\d+-\d+-[0-9a-z]{1,6}$/);
    assert.match(assigned[1].split("/").at(-1) ?? "", /^auto-\d+-\d+-[0-9a-z]{1,6}$/);

    const shared = join(repo, "shared");
    mkdirSync(shared, { recursive: true });
    const message = await asyncRejection(() =>
      ensureWriterIsolation(repo, [
        { label: "a", cwd: shared },
        { label: "b", cwd: shared },
      ]),
    );
    assert.equal(
      message,
      `multi-writer isolation: b and a share cwd ${shared}; pass unique cwd or omit cwd for auto worktree`,
    );
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
    assert.equal(mixed[1], join(repo, "elsewhere"));
    assert.equal(mixed[0] !== repo, true);
    assert.match(mixed[0].split("/").at(-1) ?? "", /^auto-\d+-\d+-[0-9a-z]{1,6}$/);

    assert.deepEqual(await ensureAlwaysIsolated(repo, []), []);
    const always = await ensureAlwaysIsolated(repo, [{ label: "only", cwd: repo }]);
    assert.equal(always.length, 1);
    assert.equal(always[0] !== repo, true);
    assert.equal(existsSync(always[0]), true);
    assert.deepEqual(await ensureAlwaysIsolated(repo, [{ label: "only", cwd: "/tmp/elsewhere" }]), [
      "/tmp/elsewhere",
    ]);
    const shared = join(repo, "shared-always");
    mkdirSync(shared, { recursive: true });
    assert.equal(
      await asyncRejection(() =>
        ensureAlwaysIsolated(repo, [
          { label: "a", cwd: shared },
          { label: "b", cwd: shared },
        ]),
      ),
      `multi-writer isolation: b and a share cwd ${shared}; pass unique cwd or omit cwd for auto worktree`,
    );
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
    assert.deepEqual(result.removed, ["clean"]);
    assert.equal(result.pruned, "pruned");
    const skipped = result.skipped.toSorted((left, right) => left.name.localeCompare(right.name));
    assert.deepEqual(skipped, [
      { name: "dirty", reason: "dirty working tree" },
      { name: "unmerged", reason: "has commits not merged into HEAD" },
    ]);
    assert.equal(existsSync(clean.path), false);
    assert.equal(existsSync(dirty.path), true);
    assert.equal(existsSync(unmerged.path), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-11 reports a missing root and a prune failure", async () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    const missing = await cleanupPstackWorktreesOnShutdown(dir);
    assert.deepEqual(missing, { removed: [], pruned: "n/a", skipped: [] });

    mkdirSync(join(dir, ".pstack-worktrees", "ghost"), { recursive: true });
    const broken = await cleanupPstackWorktreesOnShutdown(dir);
    assert.deepEqual(broken.removed, []);
    assert.equal(broken.skipped.length, 1);
    assert.equal(broken.skipped[0].name, "ghost");
    assert.match(broken.skipped[0].reason, /not a git repository/);
    assert.match(broken.pruned, /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-functions-12 flags recent child sessions inside a worktree", () => {
  const dir = tempDir("pstack-wtfn-");
  try {
    assert.equal(hasRecentChildActivity(dir), false);
    const sessions = join(dir, ".pi", "pstack-child-sessions", "nested");
    mkdirSync(sessions, { recursive: true });
    const jsonl = join(sessions, "child.jsonl");
    writeFileSync(jsonl, "{}\n");
    assert.equal(hasRecentChildActivity(dir), true);
    const stamp = Date.parse("2024-01-01T00:00:00.000Z");
    utimesSync(jsonl, new Date(stamp), new Date(stamp));
    assert.equal(hasRecentChildActivity(dir, stamp + 30 * 60 * 1000), true);
    assert.equal(hasRecentChildActivity(dir, stamp + 30 * 60 * 1000 + 1), false);
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
    assert.equal(cleaned.content[0].text, "cleanup removed=[tidy] skipped=0 prune=pruned");
    assert.deepEqual(cleaned.details, { removed: ["tidy"], pruned: "pruned", skipped: [] });
    assert.equal(existsSync(created.path), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-14 lists, prunes, removes, and creates through the tool", async () => {
  const repo = tempRepo();
  try {
    const harness = worktreeHarness();
    const listed = await harness.tool().execute("l", { action: "list" }, undefined, undefined, { cwd: repo });
    assert.equal(listed.content[0].text, "wt-list\n\npstack-managed under .pstack-worktrees: 0/12");
    assert.deepEqual(listed.details, { code: 0, count: 0 });

    const pruned = await harness.tool().execute("p", { action: "prune" }, undefined, undefined, { cwd: repo });
    assert.equal(pruned.content[0].text, "pruned");
    assert.deepEqual(pruned.details, {});

    const fresh = await createIsolatedWorktree(repo, "removable");
    const removed = await harness.tool().execute(
      "r",
      { action: "remove", name: "removable" },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.equal(removed.content[0].text, `Removed worktree ${fresh.path}`);
    assert.deepEqual(removed.details, { path: fresh.path });
    assert.equal(existsSync(fresh.path), false);

    const named = await harness.tool().execute(
      "n",
      { action: "create", name: "named", base: "main" },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.deepEqual(named.details, { path: join(repo, ".pstack-worktrees", "named"), branch: "pstack/named" });
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
    assert.match(slug, /^pstack-\d+$/);
    const stamp = Number(slug.slice("pstack-".length));
    assert.equal(stamp >= before && stamp <= after, true);
    assert.deepEqual(created.details, {
      path: join(repo, ".pstack-worktrees", slug),
      branch: `pstack/${slug}`,
    });

    await assert.rejects(
      () => harness.tool().execute("x", { action: "bogus" }, undefined, undefined, { cwd: repo }),
      /action must be create\|list\|remove\|prune\|cleanup/,
    );
    await assert.rejects(
      () => harness.tool().execute("x", { action: "remove" }, undefined, undefined, { cwd: repo }),
      /name required for remove/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree-functions-16 skips a directory that git will not remove", async () => {
  const repo = tempRepo();
  try {
    mkdirSync(join(repo, ".pstack-worktrees", "ghostdir"), { recursive: true });
    const result = await cleanupPstackWorktreesOnShutdown(repo);
    assert.deepEqual(result.removed, []);
    assert.equal(result.pruned, "pruned");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].name, "ghostdir");
    assert.match(result.skipped[0].reason, /git worktree remove/);
    assert.equal(existsSync(join(repo, ".pstack-worktrees", "ghostdir")), true);
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
    assert.equal(existsSync(created.path), false);

    await assert.doesNotReject(harness.shutdown({ cwd: join(gone, "nested") }));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(gone, { recursive: true, force: true });
  }
});
