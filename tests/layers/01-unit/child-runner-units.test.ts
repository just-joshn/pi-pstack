import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AUTO_READONLY_ROLES,
  MAX_TASKS,
  READONLY_TOOLS,
  __resetBackgroundJobsForTests,
  __seedBackgroundJobForTests,
  abortAllBackgroundJobs,
  abortBackgroundJob,
  argvHasContinueSemantics,
  argvIsDirOnlyResume,
  buildChildPiArgs,
  childConcurrencyStats,
  getBackgroundJob,
  listBackgroundJobs,
  mapConcurrent,
  persistOutputSummary,
  piInvocation,
  resolveChildSessionDir,
  resolveResumeSessionDirParam,
  resolveTools,
  shouldPersistOutput,
  truncate,
  wantsBackground,
} from "../../../extensions/subagents/child-runner.ts";

test("piInvocation runs the current node with this script", () => {
  const invocation = piInvocation(["--mode", "json"]);
  assert.deepEqual(invocation, {
    command: process.execPath,
    args: [process.argv[1], "--mode", "json"],
  });
});

test("argv helpers distinguish resume, dir-only, and interactive shapes", () => {
  assert.equal(argvHasContinueSemantics(["--session-dir", "/x", "--continue"]), true);
  assert.equal(argvHasContinueSemantics(["--session-dir", "/x", "-c"]), true);
  assert.equal(argvHasContinueSemantics(["--session-dir", "/x"]), false);
  assert.equal(argvIsDirOnlyResume(["--session-dir", "/x"]), true);
  assert.equal(argvIsDirOnlyResume(["--session-dir", "/x", "--continue"]), false);
  assert.equal(argvIsDirOnlyResume(["--session-dir", "/x", "--session", "s"]), false);
  assert.equal(argvIsDirOnlyResume(["--session-dir", "/x", "-r"]), false);
});

test("buildChildPiArgs marks resume with continue and leaves fresh isolated without it", () => {
  const base = {
    selectedModel: "test/model",
    sessionMode: "isolated" as const,
    sessionDir: "/tmp/child",
    inheritNote: "note",
    prompt: "task",
  };
  const resumed = buildChildPiArgs({ ...base, continueSession: true });
  assert.deepEqual(resumed.slice(0, 5), ["--mode", "json", "-p", "--model", "test/model"]);
  assert.deepEqual(resumed.slice(5, 7), ["--session-dir", "/tmp/child"]);
  assert.equal(resumed.includes("--continue"), true);
  const fresh = buildChildPiArgs({ ...base, continueSession: false });
  assert.equal(argvHasContinueSemantics(fresh), false);
  assert.throws(() => buildChildPiArgs({ ...base, sessionDir: undefined, continueSession: false }), /sessionDir/);
  const ephemeral = buildChildPiArgs({ ...base, sessionMode: "ephemeral", continueSession: false });
  assert.equal(ephemeral.includes("--no-session"), true);
});

test("resolveChildSessionDir rejects resume plus ephemeral and mints isolated dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-child-session-"));
  try {
    const existing = join(root, "resume-me");
    mkdirSync(existing);
    const base = { task: "t", sessionMode: "isolated" as const, cwd: undefined };
    const minted = resolveChildSessionDir(base as any, root);
    assert.equal(minted.continueSession, false);
    assert.equal(minted.sessionMode, "isolated");
    assert.equal(minted.sessionDir?.startsWith(join(root, ".pi", "pstack-child-sessions")), true);
    const resumed = resolveChildSessionDir({ ...base, resumeSessionDir: existing } as any, root);
    assert.deepEqual(resumed, { sessionMode: "isolated", sessionDir: existing, continueSession: true });
    assert.throws(
      () => resolveChildSessionDir({ ...base, sessionMode: "ephemeral", resumeSessionDir: existing } as any, root),
      /ephemeral/,
    );
    assert.throws(
      () => resolveChildSessionDir({ ...base, resumeSessionDir: join(root, "missing") } as any, root),
      /missing or unreadable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truncate returns short text untouched and caps long text with a trailer", () => {
  assert.deepEqual(truncate("short", { maxBytes: 100 }), { text: "short" });
  const long = "abcdefghij".repeat(10);
  const capped = truncate(long, { maxBytes: 20 });
  assert.equal(capped.text.startsWith(long.slice(0, 20)), true);
  assert.match(capped.text, /\[Output truncated: 1 of 1 lines \(35B of 100B\)\./);
  assert.equal(capped.outputPath, undefined);
});

test("truncate persists full text when a persist dir is given", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-truncate-"));
  try {
    const full = "x".repeat(5000);
    const capped = truncate(full, { maxBytes: 64, persistDir: dir, tag: "worker one" });
    assert.equal(typeof capped.outputPath, "string");
    assert.equal(readFileSync(capped.outputPath!, "utf8"), full);
    assert.match(capped.text, /Full output:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistOutputSummary mints distinct files for simultaneous writers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-persist-"));
  try {
    const first = persistOutputSummary("one", dir, "worker");
    const second = persistOutputSummary("two", dir, "worker");
    assert.notEqual(first, second);
    assert.deepEqual([readFileSync(first, "utf8"), readFileSync(second, "utf8")], ["one", "two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapConcurrent keeps input order and handles empty input", async () => {
  const doubled = await mapConcurrent([1, 2, 3, 4], 2, async (value) => value * 2);
  assert.deepEqual(doubled, [2, 4, 6, 8]);
  assert.deepEqual(await mapConcurrent([], 3, async () => 0), []);
});

test("shouldPersistOutput resolves explicit, env, and timeout defaults", () => {
  const previous = process.env.PSTACK_PERSIST_OUTPUT;
  Reflect.deleteProperty(process.env, "PSTACK_PERSIST_OUTPUT");
  try {
    assert.equal(shouldPersistOutput({ timeoutMs: 600_000 } as any), true);
    assert.equal(shouldPersistOutput({ timeoutMs: 1000 } as any), false);
    assert.equal(shouldPersistOutput({ persistOutput: true, timeoutMs: 1000 } as any), true);
    assert.equal(shouldPersistOutput({ persistOutput: false, timeoutMs: 600_000 } as any), false);
    process.env.PSTACK_PERSIST_OUTPUT = "0";
    assert.equal(shouldPersistOutput({ timeoutMs: 600_000 } as any), false);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_PERSIST_OUTPUT");
    else process.env.PSTACK_PERSIST_OUTPUT = previous;
  }
});

test("wantsBackground is role-aware: only poteto-agent detaches by default", () => {
  assert.equal(wantsBackground(undefined), false);
  assert.equal(wantsBackground(), false);
  assert.equal(wantsBackground(undefined, false), false);
  assert.equal(wantsBackground(undefined, true), true);
  assert.equal(wantsBackground(true, false), true);
  assert.equal(wantsBackground(false, true), false);
});

test("resolveTools follows explicit, readonly, auto-readonly, and inherit order", () => {
  assert.deepEqual(resolveTools("general", { tools: ["bash"] }, ["read"]), ["bash"]);
  assert.deepEqual(resolveTools("general", { readonly: true }, ["read"]), [...READONLY_TOOLS]);
  assert.deepEqual(resolveTools("investigator", {}), [...READONLY_TOOLS]);
  assert.deepEqual(resolveTools("general", { inheritParentTools: true }, ["read", "pstack_jobs"]), ["read", "pstack_jobs"]);
  assert.deepEqual(resolveTools("general", { inheritParentTools: true }, []), undefined);
  assert.deepEqual(resolveTools("general", { inheritParentTools: false }, ["read"]), undefined);
  assert.equal(AUTO_READONLY_ROLES.has("comment-sicko"), true);
  assert.equal(AUTO_READONLY_ROLES.has("general"), false);
});

test("resolveResumeSessionDirParam fails closed on unknown and dir-less jobs", () => {
  __resetBackgroundJobsForTests();
  assert.equal(resolveResumeSessionDirParam({ resumeSessionDir: "/tmp/child" }), "/tmp/child");
  assert.throws(() => resolveResumeSessionDirParam({ resumeSessionDir: "/tmp/child", sessionMode: "ephemeral" }), /ephemeral/);
  assert.throws(() => resolveResumeSessionDirParam({ resumeJobId: "bg-missing" }), /resumeJobId unknown/);
  __seedBackgroundJobForTests({ id: "bg-seeded", sessionDir: undefined, status: "done" });
  assert.throws(() => resolveResumeSessionDirParam({ resumeJobId: "bg-seeded" }), /has no recorded sessionDir/);
  __seedBackgroundJobForTests({ id: "bg-resume", sessionDir: "/tmp/job-session", status: "running" });
  assert.equal(resolveResumeSessionDirParam({ resumeJobId: "bg-resume" }), "/tmp/job-session");
});

test("background job registry lists, aborts, and clears jobs", () => {
  __resetBackgroundJobsForTests();
  __seedBackgroundJobForTests({ id: "bg-2", status: "running", startedAt: 20, sessionDir: "/tmp/b" });
  __seedBackgroundJobForTests({ id: "bg-1", status: "done", startedAt: 10, sessionDir: "/tmp/a" });
  assert.deepEqual(listBackgroundJobs().map((job) => job.id), ["bg-1", "bg-2"]);
  assert.equal(getBackgroundJob("bg-2")?.status, "running");
  assert.deepEqual(abortBackgroundJob("bg-2"), {
    id: "bg-2",
    status: "aborted",
    role: undefined,
    model: "test/model",
    taskPreview: "",
    startedAt: 20,
    finishedAt: getBackgroundJob("bg-2")?.finishedAt,
    sessionDir: "/tmp/b",
    result: undefined,
    error: undefined,
  });
  assert.equal(getBackgroundJob("bg-1")?.status, "done");
  abortAllBackgroundJobs();
  __resetBackgroundJobsForTests();
  assert.deepEqual(listBackgroundJobs(), []);
});

test("childConcurrencyStats reports the idle cap and task ceiling", () => {
  __resetBackgroundJobsForTests();
  const stats = childConcurrencyStats();
  assert.equal(stats.active, 0);
  assert.equal(stats.waiting, 0);
  assert.equal(stats.cap > 0, true);
  assert.equal(MAX_TASKS, 8);
});
