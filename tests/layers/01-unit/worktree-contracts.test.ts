/**
 * Behavioral proofs for the worktree-01..worktree-15 rows in spec/contracts/shipping.tsv.
 * The git fixtures put a recording stand-in first on PATH because the worktree
 * helpers exec `git` directly instead of going through pi.exec.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PSTACK_WORKTREES,
  WorktreeSanitizeError,
  cleanupPstackWorktreesOnShutdown,
  createIsolatedWorktree,
  hasRecentChildActivity,
  pruneWorktrees,
  removeWorktree,
  sanitizeBaseRef,
  sanitizeWorktreeName,
} from "../../../extensions/worktree/helpers.ts";
import { registerWorktree } from "../../../extensions/worktree/index.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: { type: string; required: string[]; properties: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { cwd: string },
  ) => Promise<ToolResult>;
}

interface ExecCall {
  command: string;
  args: string[];
}

interface FakeExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function worktreeHarness(execResults: FakeExecResult[] = []) {
  let tool: CapturedTool | undefined;
  let shutdown: ((event: unknown, ctx: { cwd: string }) => Promise<void>) | undefined;
  let calls: ExecCall[] = [];
  let cursor = 0;
  const pi = {
    on(event: string, handler: (event: unknown, ctx: { cwd: string }) => Promise<void>) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    async exec(command: string, args: string[]) {
      calls = [...calls, { command, args }];
      const result = execResults[cursor] ?? { code: 0, stdout: "", stderr: "" };
      cursor += 1;
      return result;
    },
  };
  registerWorktree(pi as never);
  return {
    tool: () => tool as CapturedTool,
    shutdownHandler: () =>
      shutdown as ((event: unknown, ctx: { cwd: string }) => Promise<void>) | undefined,
    shutdown: (ctx: { cwd: string }) =>
      (shutdown as (event: unknown, ctx: { cwd: string }) => Promise<void>)({}, ctx),
    execCalls: () => calls,
  };
}

interface FakeGitRule {
  prefix: string[];
  stdout?: string;
  stderr?: string;
  code?: number;
}

interface FakeGitLogEntry {
  argv: string[];
  cwd: string;
}

function readGitLog(log: string): FakeGitLogEntry[] {
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeGitLogEntry);
}

function installFakeGit(root: string, rules: FakeGitRule[]) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "git-log.jsonl");
  writeFileSync(log, "");
  const script = [
    "#!/usr/bin/env node",
    'const { appendFileSync } = require("node:fs");',
    "const args = process.argv.slice(2);",
    "appendFileSync(" +
      JSON.stringify(log) +
      ', JSON.stringify({ argv: args, cwd: process.cwd() }) + "\\n");',
    "const rules = " + JSON.stringify(rules) + ";",
    "let best;",
    "for (const rule of rules) {",
    "  if (!rule.prefix.every((value, index) => args[index] === value)) continue;",
    "  if (!best || rule.prefix.length > best.prefix.length) best = rule;",
    "}",
    "if (best && best.stdout) process.stdout.write(best.stdout);",
    "if (best && best.stderr) process.stderr.write(best.stderr);",
    "process.exit(best && best.code ? best.code : 0);",
  ].join("\n");
  const gitPath = join(bin, "git");
  writeFileSync(gitPath, script + "\n");
  chmodSync(gitPath, 0o755);
  return {
    bin,
    log,
    readLog: () => readGitLog(log),
    argvLog: () => readGitLog(log).map((entry) => entry.argv),
  };
}

async function withFakeGit<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH ?? "";
  process.env.PATH = bin + ":" + saved;
  try {
    return await run();
  } finally {
    process.env.PATH = saved;
  }
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function throwsWithMessage(run: () => string, message: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof WorktreeSanitizeError, "expected WorktreeSanitizeError for: " + message);
  assert.equal((caught as Error).message, message);
}

async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

test("worktree-01 registers pstack_worktree with the documented schema", () => {
  const harness = worktreeHarness();
  const tool = harness.tool();
  assert.equal(tool.name, "pstack_worktree");
  assert.equal(tool.label, "Pstack Worktree");
  assert.equal(tool.promptSnippet, "Allocate an isolated git worktree path");
  assert.equal(
    tool.description,
    `Create/list/remove/prune git worktrees for isolated arena/swarm writes. Create rejects path/option injection and enforces a session cap of ${MAX_PSTACK_WORKTREES}. On session_shutdown, empty/merged pstack-owned trees under .pstack-worktrees are auto-removed (dirty/unmerged skipped).`,
  );
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.deepEqual(tool.parameters.properties, {
    action: {
      type: "string",
      enum: ["create", "list", "remove", "prune", "cleanup"],
      description: "create | list | remove | prune | cleanup",
    },
    name: { type: "string", description: "Worktree/branch slug for create/remove" },
    base: { type: "string", description: "Base ref (default HEAD)" },
  });
  assert.equal(typeof tool.execute, "function");
  assert.equal(typeof harness.shutdownHandler(), "function");
});

test("worktree-02 rejects unsafe worktree names", () => {
  const separators = "worktree name must not contain '..', path separators, or NUL";
  throwsWithMessage(() => sanitizeWorktreeName(""), "worktree name required");
  throwsWithMessage(() => sanitizeWorktreeName("   "), "worktree name required");
  throwsWithMessage(() => sanitizeWorktreeName("-escape"), "worktree name must not start with '-'");
  for (const unsafe of ["a..b", "a/b", "a\\b", "a\u0000b"]) {
    throwsWithMessage(() => sanitizeWorktreeName(unsafe), separators);
  }
  for (const unsupported of ["bad name", "foo;bar", "foo:bar", "caf\u00e9"]) {
    throwsWithMessage(() => sanitizeWorktreeName(unsupported), "worktree name has unsupported characters");
  }
  assert.equal(sanitizeWorktreeName("valid-1.2_3@x+=,y"), "valid-1.2_3@x+=,y");
  assert.equal(sanitizeWorktreeName("  spaced  "), "spaced");
});

test("worktree-03 rejects unsafe base refs", () => {
  const separators = "base ref must not contain '..', whitespace, or NUL";
  throwsWithMessage(() => sanitizeBaseRef(""), "base ref required");
  throwsWithMessage(() => sanitizeBaseRef("   "), "base ref required");
  throwsWithMessage(() => sanitizeBaseRef("-escape"), "base ref must not start with '-'");
  for (const unsafe of ["a..b", "feature branch", "a\tb", "a\u0000b"]) {
    throwsWithMessage(() => sanitizeBaseRef(unsafe), separators);
  }
  for (const unsupported of ["main:evil", "a;b", "main&x", "caf\u00e9"]) {
    throwsWithMessage(() => sanitizeBaseRef(unsupported), "base ref has unsupported characters");
  }
  assert.equal(sanitizeBaseRef("origin/main"), "origin/main");
  assert.equal(sanitizeBaseRef("main~1"), "main~1");
  assert.equal(sanitizeBaseRef("v1.0.0^"), "v1.0.0^");
  assert.equal(sanitizeBaseRef("a+b"), "a+b");
  assert.equal(sanitizeBaseRef("  main  "), "main");
});

test("worktree-04 creates .pstack-worktrees/<slug> on branch pstack/<slug>", async () => {
  const dir = tempDir("pstack-wt-04-");
  try {
    const git = installFakeGit(dir, [{ prefix: ["worktree", "add"] }]);
    const created = await withFakeGit(git.bin, () => createIsolatedWorktree(dir, "feat-one"));
    const root = join(dir, ".pstack-worktrees");
    assert.deepEqual(created, { path: join(root, "feat-one"), branch: "pstack/feat-one" });
    const based = await withFakeGit(git.bin, () =>
      createIsolatedWorktree(dir, "feat-two", "origin/main"),
    );
    assert.deepEqual(based, { path: join(root, "feat-two"), branch: "pstack/feat-two" });
    assert.deepEqual(git.argvLog(), [
      ["worktree", "add", "-b", "pstack/feat-one", join(root, "feat-one"), "HEAD"],
      ["worktree", "add", "-b", "pstack/feat-two", join(root, "feat-two"), "origin/main"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-05 refuses to create at the 12-worktree session cap", async () => {
  const dir = tempDir("pstack-wt-05-");
  try {
    assert.equal(MAX_PSTACK_WORKTREES, 12);
    const root = join(dir, ".pstack-worktrees");
    for (let index = 0; index < MAX_PSTACK_WORKTREES; index += 1) {
      mkdirSync(join(root, `slot-${index}`), { recursive: true });
    }
    const error = await captureRejection(() => createIsolatedWorktree(dir, "overflow"));
    assert.ok(error instanceof WorktreeSanitizeError);
    assert.equal(
      (error as Error).message,
      `pstack worktree session cap (${MAX_PSTACK_WORKTREES}) reached; remove/prune before creating more`,
    );
    rmSync(join(root, "slot-0"), { recursive: true, force: true });
    const git = installFakeGit(join(dir, "git-home"), [{ prefix: ["worktree", "add"] }]);
    const created = await withFakeGit(git.bin, () => createIsolatedWorktree(dir, "eleventh"));
    assert.equal(created.branch, "pstack/eleventh");
    assert.deepEqual(git.argvLog(), [
      ["worktree", "add", "-b", "pstack/eleventh", join(root, "eleventh"), "HEAD"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-06 defaults the create slug to pstack-<Date.now()>", async () => {
  const dir = tempDir("pstack-wt-06-");
  try {
    const git = installFakeGit(dir, [{ prefix: ["worktree", "add"] }]);
    const harness = worktreeHarness();
    const before = Date.now();
    const result = await withFakeGit(git.bin, () =>
      harness.tool().execute("call-create", { action: "create" }, undefined, undefined, { cwd: dir }),
    );
    const after = Date.now();
    const argv = git.argvLog()[0];
    const branch = argv[3];
    const slug = branch.slice("pstack/".length);
    assert.match(slug, /^pstack-\d+$/);
    const stamp = Number(slug.slice("pstack-".length));
    assert.ok(stamp >= before && stamp <= after, `default slug stamp ${stamp} outside [${before}, ${after}]`);
    const path = join(dir, ".pstack-worktrees", slug);
    assert.deepEqual(argv, ["worktree", "add", "-b", `pstack/${slug}`, path, "HEAD"]);
    assert.deepEqual(result.details, { path, branch });
    assert.equal(result.content[0].text, `Created worktree ${path} on ${branch}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-07 maps a git worktree add failure onto a prefixed Error", async () => {
  const dir = tempDir("pstack-wt-07-");
  try {
    const git = installFakeGit(dir, [
      { prefix: ["worktree", "add"], code: 3, stderr: "fatal: not a git repository" },
    ]);
    const error = await withFakeGit(git.bin, () =>
      captureRejection(() => createIsolatedWorktree(dir, "broken")),
    );
    assert.ok(error instanceof Error);
    assert.equal(error.constructor, Error);
    assert.ok(error.message.startsWith("git worktree add failed: "), error.message);
    assert.ok(error.message.includes("fatal: not a git repository"), error.message);
    const harness = worktreeHarness();
    const toolError = await withFakeGit(git.bin, () =>
      captureRejection(() =>
        harness
          .tool()
          .execute("call-create", { action: "create", name: "broken" }, undefined, undefined, {
            cwd: dir,
          }),
      ),
    );
    assert.ok(toolError instanceof Error);
    assert.ok(toolError.message.startsWith("git worktree add failed: "), toolError.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-08 lists via git worktree list --porcelain and reports the cap count", async () => {
  const dir = tempDir("pstack-wt-08-");
  try {
    mkdirSync(join(dir, ".pstack-worktrees", "one"), { recursive: true });
    mkdirSync(join(dir, ".pstack-worktrees", "two"), { recursive: true });
    const harness = worktreeHarness([
      { code: 0, stdout: "worktree /repo\nHEAD abc123\n", stderr: "" },
      { code: 1, stdout: "", stderr: "fatal: not a git repository" },
    ]);
    const ctx = { cwd: dir };
    const listed = await harness.tool().execute("call-list", { action: "list" }, undefined, undefined, ctx);
    assert.deepEqual(harness.execCalls(), [{ command: "git", args: ["worktree", "list", "--porcelain"] }]);
    assert.equal(
      listed.content[0].text,
      `worktree /repo\nHEAD abc123\n\n\npstack-managed under .pstack-worktrees: 2/${MAX_PSTACK_WORKTREES}`,
    );
    assert.deepEqual(listed.details, { code: 0, count: 2 });
    const fallback = await harness.tool().execute("call-list", { action: "list" }, undefined, undefined, ctx);
    assert.equal(
      fallback.content[0].text,
      `fatal: not a git repository\n\npstack-managed under .pstack-worktrees: 2/${MAX_PSTACK_WORKTREES}`,
    );
    assert.deepEqual(fallback.details, { code: 1, count: 2 });
    assert.deepEqual(harness.execCalls(), [
      { command: "git", args: ["worktree", "list", "--porcelain"] },
      { command: "git", args: ["worktree", "list", "--porcelain"] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-09 prunes with git worktree prune -v", async () => {
  const dir = tempDir("pstack-wt-09-");
  try {
    const git = installFakeGit(dir, [
      { prefix: ["worktree", "prune", "-v"], stdout: "pruning worktrees" },
    ]);
    const pruned = await withFakeGit(git.bin, () => pruneWorktrees(dir));
    assert.equal(pruned, "pruning worktrees");
    const harness = worktreeHarness();
    const result = await withFakeGit(git.bin, () =>
      harness.tool().execute("call-prune", { action: "prune" }, undefined, undefined, { cwd: dir }),
    );
    assert.equal(result.content[0].text, "pruning worktrees");
    assert.deepEqual(git.argvLog(), [
      ["worktree", "prune", "-v"],
      ["worktree", "prune", "-v"],
    ]);
    assert.deepEqual(harness.execCalls(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-10 removes with --force then falls back to a plain remove", async () => {
  const dir = tempDir("pstack-wt-10-");
  try {
    const root = join(dir, ".pstack-worktrees");
    const forceFails = installFakeGit(join(dir, "force-fails"), [
      { prefix: ["worktree", "remove", "--force"], code: 1, stderr: "fatal: cannot force remove" },
      { prefix: ["worktree", "remove"] },
    ]);
    const stuck = await withFakeGit(forceFails.bin, () => removeWorktree(dir, "stuck"));
    assert.equal(stuck, join(root, "stuck"));
    assert.deepEqual(forceFails.argvLog(), [
      ["worktree", "remove", "--force", join(root, "stuck")],
      ["worktree", "remove", join(root, "stuck")],
    ]);
    const forceWorks = installFakeGit(join(dir, "force-works"), [
      { prefix: ["worktree", "remove", "--force"] },
    ]);
    assert.equal(await withFakeGit(forceWorks.bin, () => removeWorktree(dir, "easy")), join(root, "easy"));
    assert.deepEqual(forceWorks.argvLog(), [["worktree", "remove", "--force", join(root, "easy")]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-11 requires a name for remove and rejects unknown actions", async () => {
  const harness = worktreeHarness();
  const ctx = { cwd: process.cwd() };
  const missingName = await captureRejection(() =>
    harness.tool().execute("call-remove", { action: "remove" }, undefined, undefined, ctx),
  );
  assert.ok(missingName instanceof Error);
  assert.equal(missingName.message, "name required for remove");
  const unknown = await captureRejection(() =>
    harness.tool().execute("call-bogus", { action: "bogus", name: "x" }, undefined, undefined, ctx),
  );
  assert.ok(unknown instanceof Error);
  assert.equal(unknown.message, "action must be create|list|remove|prune|cleanup");
  assert.deepEqual(harness.execCalls(), []);
});

test("worktree-12 skips cleanup for child sessions touched in the last 30 minutes", () => {
  const dir = tempDir("pstack-wt-12-");
  try {
    const sessions = join(dir, ".pi", "pstack-child-sessions", "nested");
    mkdirSync(sessions, { recursive: true });
    const jsonl = join(sessions, "child.jsonl");
    writeFileSync(jsonl, "{}\n");
    assert.equal(hasRecentChildActivity(dir), true);
    const stamp = Date.parse("2024-01-01T00:00:00.000Z");
    utimesSync(jsonl, new Date(stamp), new Date(stamp));
    assert.equal(hasRecentChildActivity(dir, stamp + 30 * 60 * 1000), true);
    assert.equal(hasRecentChildActivity(dir, stamp + 30 * 60 * 1000 + 1), false);
    const note = join(sessions, "notes.txt");
    writeFileSync(note, "not a session");
    utimesSync(note, new Date(stamp + 60 * 60 * 1000), new Date(stamp + 60 * 60 * 1000));
    assert.equal(hasRecentChildActivity(dir, stamp + 60 * 60 * 1000), false);
    assert.equal(hasRecentChildActivity(join(dir, "missing"), stamp), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-13 removes clean worktrees that are ancestors or branch-merged", async () => {
  const dir = tempDir("pstack-wt-13-");
  try {
    const root = join(dir, ".pstack-worktrees");
    const ancestor = join(root, "ancestor");
    const branchMerged = join(root, "branch-merged");
    const unmerged = join(root, "unmerged");
    for (const path of [ancestor, branchMerged, unmerged]) mkdirSync(path, { recursive: true });
    const git = installFakeGit(dir, [
      { prefix: ["-C", ancestor, "status", "--porcelain"] },
      { prefix: ["-C", branchMerged, "status", "--porcelain"] },
      { prefix: ["-C", unmerged, "status", "--porcelain"] },
      { prefix: ["-C", ancestor, "rev-parse", "HEAD"], stdout: "aaa111" },
      { prefix: ["-C", branchMerged, "rev-parse", "HEAD"], stdout: "bbb222" },
      { prefix: ["-C", unmerged, "rev-parse", "HEAD"], stdout: "ccc333" },
      { prefix: ["merge-base", "--is-ancestor", "aaa111", "HEAD"] },
      { prefix: ["merge-base", "--is-ancestor"], code: 1 },
      {
        prefix: ["branch", "--merged", "HEAD", "--list", "pstack/branch-merged"],
        stdout: "  pstack/branch-merged",
      },
      { prefix: ["branch", "--merged", "HEAD", "--list"] },
      { prefix: ["worktree", "remove", "--force"] },
      { prefix: ["worktree", "prune", "-v"], stdout: "pruned" },
    ]);
    const result = await withFakeGit(git.bin, () => cleanupPstackWorktreesOnShutdown(dir));
    assert.deepEqual(result.removed.toSorted(), ["ancestor", "branch-merged"]);
    assert.equal(result.pruned, "pruned");
    assert.deepEqual(result.skipped, [{ name: "unmerged", reason: "has commits not merged into HEAD" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-14 skips dirty, untracked-only, and recently active worktrees", async () => {
  const dir = tempDir("pstack-wt-14-");
  try {
    const root = join(dir, ".pstack-worktrees");
    const clean = join(root, "clean");
    const dirty = join(root, "dirty");
    const scratch = join(root, "untracked-only");
    const active = join(root, "child-active");
    for (const path of [clean, dirty, scratch, active]) mkdirSync(path, { recursive: true });
    mkdirSync(join(active, ".pi", "pstack-child-sessions"), { recursive: true });
    writeFileSync(join(active, ".pi", "pstack-child-sessions", "child.jsonl"), "{}\n");
    const git = installFakeGit(dir, [
      { prefix: ["-C", clean, "status", "--porcelain"] },
      { prefix: ["-C", dirty, "status", "--porcelain"], stdout: " M tracked.txt" },
      { prefix: ["-C", scratch, "status", "--porcelain"], stdout: "?? scratch.txt" },
      { prefix: ["-C", clean, "rev-parse", "HEAD"], stdout: "ddd444" },
      { prefix: ["merge-base", "--is-ancestor", "ddd444", "HEAD"] },
      { prefix: ["merge-base", "--is-ancestor"], code: 1 },
      { prefix: ["worktree", "remove", "--force"] },
      { prefix: ["worktree", "prune", "-v"], stdout: "pruned" },
    ]);
    const result = await withFakeGit(git.bin, () => cleanupPstackWorktreesOnShutdown(dir));
    assert.deepEqual(result.removed, ["clean"]);
    assert.equal(result.pruned, "pruned");
    const skipped = result.skipped.toSorted((left, right) => left.name.localeCompare(right.name));
    assert.deepEqual(skipped, [
      { name: "child-active", reason: "child session active in the last 30 minutes" },
      { name: "dirty", reason: "dirty working tree" },
      { name: "untracked-only", reason: "dirty working tree" },
    ]);
    assert.deepEqual(git.readLog().filter((entry) => entry.argv.includes(active)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worktree-15 runs shutdown cleanup in the project cwd and swallows errors", async () => {
  const repo = realpathSync(tempDir("pstack-wt-15-"));
  const savedCwd = process.cwd();
  try {
    const clean = join(repo, ".pstack-worktrees", "clean");
    mkdirSync(clean, { recursive: true });
    const git = installFakeGit(repo, [
      { prefix: ["-C", clean, "status", "--porcelain"] },
      { prefix: ["-C", clean, "rev-parse", "HEAD"], stdout: "eee555" },
      { prefix: ["merge-base", "--is-ancestor", "eee555", "HEAD"] },
      { prefix: ["merge-base", "--is-ancestor"], code: 1 },
      { prefix: ["worktree", "remove", "--force"] },
      { prefix: ["worktree", "prune", "-v"], stdout: "pruned" },
    ]);
    const harness = worktreeHarness();
    process.chdir(repo);
    await withFakeGit(git.bin, () => harness.shutdown({ cwd: repo }));
    const calls = git.readLog();
    assert.ok(calls.length > 0);
    assert.deepEqual([...new Set(calls.map((entry) => entry.cwd))], [repo]);
    assert.ok(calls.some((entry) => entry.argv.join(" ") === `-C ${clean} status --porcelain`));
    const gone = tempDir("pstack-wt-15-gone-");
    process.chdir(gone);
    rmSync(gone, { recursive: true, force: true });
    await assert.doesNotReject(harness.shutdown({ cwd: gone }));
    process.chdir(savedCwd);
  } finally {
    process.chdir(savedCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});
