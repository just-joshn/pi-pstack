import { expect, test } from "vitest";
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
  expect(invocation).toEqual({
    command: process.execPath,
    args: [process.argv[1], "--mode", "json"],
  });
});

test("argv helpers distinguish resume, dir-only, and interactive shapes", () => {
  expect(argvHasContinueSemantics(["--session-dir", "/x", "--continue"])).toBe(true);
  expect(argvHasContinueSemantics(["--session-dir", "/x", "-c"])).toBe(true);
  expect(argvHasContinueSemantics(["--session-dir", "/x"])).toBe(false);
  expect(argvIsDirOnlyResume(["--session-dir", "/x"])).toBe(true);
  expect(argvIsDirOnlyResume(["--session-dir", "/x", "--continue"])).toBe(false);
  expect(argvIsDirOnlyResume(["--session-dir", "/x", "--session", "s"])).toBe(false);
  expect(argvIsDirOnlyResume(["--session-dir", "/x", "-r"])).toBe(false);
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
  expect(resumed.slice(0, 5)).toEqual(["--mode", "json", "-p", "--model", "test/model"]);
  expect(resumed.slice(5, 7)).toEqual(["--session-dir", "/tmp/child"]);
  expect(resumed.includes("--continue")).toBe(true);
  const fresh = buildChildPiArgs({ ...base, continueSession: false });
  expect(argvHasContinueSemantics(fresh)).toBe(false);
  expect(() => buildChildPiArgs({ ...base, sessionDir: undefined, continueSession: false })).toThrow(/sessionDir/);
  const ephemeral = buildChildPiArgs({ ...base, sessionMode: "ephemeral", continueSession: false });
  expect(ephemeral.includes("--no-session")).toBe(true);
});

test("resolveChildSessionDir rejects resume plus ephemeral and mints isolated dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-child-session-"));
  try {
    const existing = join(root, "resume-me");
    mkdirSync(existing);
    const base = { task: "t", sessionMode: "isolated" as const, cwd: undefined };
    const minted = resolveChildSessionDir(base as any, root);
    expect(minted.continueSession).toBe(false);
    expect(minted.sessionMode).toBe("isolated");
    expect(minted.sessionDir?.startsWith(join(root, ".pi", "pstack-child-sessions"))).toBe(true);
    const resumed = resolveChildSessionDir({ ...base, resumeSessionDir: existing } as any, root);
    expect(resumed).toEqual({ sessionMode: "isolated", sessionDir: existing, continueSession: true });
    expect(() => resolveChildSessionDir({ ...base, sessionMode: "ephemeral", resumeSessionDir: existing } as any, root)).toThrow(/ephemeral/);
    expect(() => resolveChildSessionDir({ ...base, resumeSessionDir: join(root, "missing") } as any, root)).toThrow(/missing or unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truncate returns short text untouched and caps long text with a trailer", () => {
  expect(truncate("short", { maxBytes: 100 })).toEqual({ text: "short" });
  const long = "abcdefghij".repeat(10);
  const capped = truncate(long, { maxBytes: 20 });
  expect(capped.text.startsWith(long.slice(0, 20))).toBe(true);
  expect(capped.text).toMatch(/\[Output truncated: 1 of 1 lines \(35B of 100B\)\./);
  expect(capped.outputPath).toBe(undefined);
});

test("truncate persists full text when a persist dir is given", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-truncate-"));
  try {
    const full = "x".repeat(5000);
    const capped = truncate(full, { maxBytes: 64, persistDir: dir, tag: "worker one" });
    expect(typeof capped.outputPath).toBe("string");
    expect(readFileSync(capped.outputPath!, "utf8")).toBe(full);
    expect(capped.text).toMatch(/Full output:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistOutputSummary mints distinct files for simultaneous writers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-persist-"));
  try {
    const first = persistOutputSummary("one", dir, "worker");
    const second = persistOutputSummary("two", dir, "worker");
    expect(first).not.toBe(second);
    expect([readFileSync(first, "utf8"), readFileSync(second, "utf8")]).toEqual(["one", "two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mapConcurrent keeps input order and handles empty input", async () => {
  const doubled = await mapConcurrent([1, 2, 3, 4], 2, async (value) => value * 2);
  expect(doubled).toEqual([2, 4, 6, 8]);
  expect(await mapConcurrent([], 3, async () => 0)).toEqual([]);
});

test("shouldPersistOutput resolves explicit, env, and timeout defaults", () => {
  const previous = process.env.PSTACK_PERSIST_OUTPUT;
  Reflect.deleteProperty(process.env, "PSTACK_PERSIST_OUTPUT");
  try {
    expect(shouldPersistOutput({ timeoutMs: 600_000 } as any)).toBe(true);
    expect(shouldPersistOutput({ timeoutMs: 1000 } as any)).toBe(false);
    expect(shouldPersistOutput({ persistOutput: true, timeoutMs: 1000 } as any)).toBe(true);
    expect(shouldPersistOutput({ persistOutput: false, timeoutMs: 600_000 } as any)).toBe(false);
    process.env.PSTACK_PERSIST_OUTPUT = "0";
    expect(shouldPersistOutput({ timeoutMs: 600_000 } as any)).toBe(false);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_PERSIST_OUTPUT");
    else process.env.PSTACK_PERSIST_OUTPUT = previous;
  }
});

test("wantsBackground is role-aware: only poteto-agent detaches by default", () => {
  expect(wantsBackground(undefined)).toBe(false);
  expect(wantsBackground()).toBe(false);
  expect(wantsBackground(undefined, false)).toBe(false);
  expect(wantsBackground(undefined, true)).toBe(true);
  expect(wantsBackground(true, false)).toBe(true);
  expect(wantsBackground(false, true)).toBe(false);
});

test("resolveTools follows explicit, readonly, auto-readonly, and inherit order", () => {
  expect(resolveTools("general", { tools: ["bash"] }, ["read"])).toEqual(["bash"]);
  expect(resolveTools("general", { readonly: true }, ["read"])).toEqual([...READONLY_TOOLS]);
  expect(resolveTools("investigator", {})).toEqual([...READONLY_TOOLS]);
  expect(resolveTools("general", { inheritParentTools: true }, ["read", "pstack_jobs"])).toEqual(["read", "pstack_jobs"]);
  expect(resolveTools("general", { inheritParentTools: true }, [])).toEqual(undefined);
  expect(resolveTools("general", { inheritParentTools: false }, ["read"])).toEqual(undefined);
  expect(AUTO_READONLY_ROLES.has("comment-sicko")).toBe(true);
  expect(AUTO_READONLY_ROLES.has("general")).toBe(false);
});

test("resolveResumeSessionDirParam fails closed on unknown and dir-less jobs", () => {
  __resetBackgroundJobsForTests();
  expect(resolveResumeSessionDirParam({ resumeSessionDir: "/tmp/child" })).toBe("/tmp/child");
  expect(() => resolveResumeSessionDirParam({ resumeSessionDir: "/tmp/child", sessionMode: "ephemeral" })).toThrow(/ephemeral/);
  expect(() => resolveResumeSessionDirParam({ resumeJobId: "bg-missing" })).toThrow(/resumeJobId unknown/);
  __seedBackgroundJobForTests({ id: "bg-seeded", sessionDir: undefined, status: "done" });
  expect(() => resolveResumeSessionDirParam({ resumeJobId: "bg-seeded" })).toThrow(/has no recorded sessionDir/);
  __seedBackgroundJobForTests({ id: "bg-resume", sessionDir: "/tmp/job-session", status: "running" });
  expect(resolveResumeSessionDirParam({ resumeJobId: "bg-resume" })).toBe("/tmp/job-session");
});

test("background job registry lists, aborts, and clears jobs", () => {
  __resetBackgroundJobsForTests();
  __seedBackgroundJobForTests({ id: "bg-2", status: "running", startedAt: 20, sessionDir: "/tmp/b" });
  __seedBackgroundJobForTests({ id: "bg-1", status: "done", startedAt: 10, sessionDir: "/tmp/a" });
  expect(listBackgroundJobs().map((job) => job.id)).toEqual(["bg-1", "bg-2"]);
  expect(getBackgroundJob("bg-2")?.status).toBe("running");
  expect(abortBackgroundJob("bg-2")).toEqual({
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
  expect(getBackgroundJob("bg-1")?.status).toBe("done");
  abortAllBackgroundJobs();
  __resetBackgroundJobsForTests();
  expect(listBackgroundJobs()).toEqual([]);
});

test("childConcurrencyStats reports the idle cap and task ceiling", () => {
  __resetBackgroundJobsForTests();
  const stats = childConcurrencyStats();
  expect(stats.active).toBe(0);
  expect(stats.waiting).toBe(0);
  expect(stats.cap > 0).toBe(true);
  expect(MAX_TASKS).toBe(8);
});
