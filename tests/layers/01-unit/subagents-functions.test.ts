import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createJobRegistryCell } from "../../../extensions/subagents/job-registry.ts";

interface RecordedSpawn {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  killSignals: string[];
}

interface SpawnPlan {
  stdoutChunks: string[];
  stderrChunks: string[];
  exitCode: number;
  closes: boolean;
  throwOnSpawn: boolean;
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: (signal?: string) => boolean;
}

let spawnPlan: SpawnPlan = {
  stdoutChunks: [],
  stderrChunks: [],
  exitCode: 0,
  closes: true,
  throwOnSpawn: false,
};
let recordedSpawns: RecordedSpawn[] = [];

function setSpawnPlan(plan: Partial<SpawnPlan>): void {
  spawnPlan = {
    stdoutChunks: [],
    stderrChunks: [],
    exitCode: 0,
    closes: true,
    throwOnSpawn: false,
    ...plan,
  };
}

function messageLine(text: string, stopReason?: string): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text }],
  };
  if (stopReason !== undefined) message.stopReason = stopReason;
  return `${JSON.stringify({ type: "message_end", message })}\n`;
}

function makeFakeChild(plan: SpawnPlan, record: RecordedSpawn): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = (signal?: string) => {
    record.killSignals = [...record.killSignals, signal ?? "SIGTERM"];
    setImmediate(() => child.emit("close", plan.exitCode));
    return true;
  };
  setImmediate(() => {
    for (const text of plan.stdoutChunks) child.stdout.emit("data", Buffer.from(text, "utf8"));
    for (const text of plan.stderrChunks) child.stderr.emit("data", Buffer.from(text, "utf8"));
    if (plan.closes) child.emit("close", plan.exitCode);
  });
  return child;
}

function fakeSpawn(
  _command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
): FakeChild {
  if (spawnPlan.throwOnSpawn) throw new Error("spawn ENOENT");
  const record: RecordedSpawn = {
    args: [...args],
    cwd: options.cwd ?? "",
    env: options.env ?? {},
    killSignals: [],
  };
  recordedSpawns = [...recordedSpawns, record];
  return makeFakeChild(spawnPlan, record);
}

const nodeRequire = createRequire(import.meta.url);
const childProcessModule = nodeRequire("node:child_process") as { spawn: unknown };
childProcessModule.spawn = fakeSpawn as unknown;

const childProcessEsm = await import("node:child_process");
if (childProcessEsm.spawn !== (fakeSpawn as unknown)) {
  throw new Error("fake spawn did not reach the child_process ESM facade; refusing to run");
}

const outputPolicy = await import("../../../extensions/subagents/output-policy.ts");
const sessionDir = await import("../../../extensions/subagents/session-dir.ts");
const childRunner = await import("../../../extensions/subagents/child-runner.ts");
const subagents = await import("../../../extensions/subagents/index.ts");

const {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  appendCapped,
  parsePositiveInt,
  truncate,
} = outputPolicy;
const { resolveChildSessionDir, resolveSessionMode } = sessionDir;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pstack-subagents-functions-"));
}

function lastSpawn(): RecordedSpawn {
  const record = recordedSpawns.at(-1);
  if (!record) throw new Error("no child process was spawned");
  return record;
}

async function waitForJob(id: string, status: string) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const job = childRunner.getBackgroundJob(id);
    if (job?.status === status || Date.now() >= deadline) return job;
    await delay(10);
  }
}

test("parsePositiveInt falls back on empty and non-numeric input and clamps to the range", () => {
  assert.equal(parsePositiveInt(undefined, 7, 1, 10), 7);
  assert.equal(parsePositiveInt("", 7, 1, 10), 7);
  assert.equal(parsePositiveInt("abc", 7, 1, 10), 7);
  assert.equal(parsePositiveInt("3", 7, 1, 10), 3);
  assert.equal(parsePositiveInt("0", 7, 1, 10), 1);
  assert.equal(parsePositiveInt("999", 7, 1, 10), 10);
});

test("output caps expose the documented byte and timeout literals", () => {
  assert.equal(MAX_OUTPUT_BYTES, 51200);
  assert.equal(DEFAULT_TIMEOUT_MS, 600000);
  assert.equal(MAX_TIMEOUT_MS, 1800000);
});

test("truncate keeps a long single line visible and ignores a failing persist dir", () => {
  const single = truncate("x".repeat(200), { maxBytes: 32 });
  assert.match(single.text, /^x+\.\.\. \[truncated\]/);
  assert.match(single.text, /\[Output truncated: 1 of 1 lines \(\d+B of 200B\)\. Set persistOutput:true/);
  assert.equal(single.outputPath, undefined);

  const dir = tempDir();
  try {
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const capped = truncate("y".repeat(400), { maxBytes: 16, persistDir: blocker, tag: "t" });
    assert.equal(capped.outputPath, undefined);
    assert.match(capped.text, /Set persistOutput:true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendCapped appends under the cap, holds at the cap, and truncates past it", () => {
  assert.equal(appendCapped("abc", "def", 10), "abcdef");
  assert.equal(appendCapped("0123456789", "xyz", 10), "0123456789");
  const over = appendCapped("abc", "defgh", 5);
  assert.equal(over.includes("fgh"), false);
  assert.match(over, /^abcde/);
  assert.match(over, /\[Output truncated: 1 of 1 lines \(\d+B of 8B\)\./);
});

test("resolveSessionMode prefers the input, then the env, then isolated", () => {
  const previous = process.env.PSTACK_CHILD_SESSION;
  Reflect.deleteProperty(process.env, "PSTACK_CHILD_SESSION");
  try {
    assert.equal(resolveSessionMode({ task: "t" }), "isolated");
    assert.equal(resolveSessionMode({ task: "t", sessionMode: "ephemeral" }), "ephemeral");
    process.env.PSTACK_CHILD_SESSION = "ephemeral";
    assert.equal(resolveSessionMode({ task: "t" }), "ephemeral");
    assert.equal(resolveSessionMode({ task: "t", sessionMode: "isolated" }), "isolated");
    process.env.PSTACK_CHILD_SESSION = "bogus";
    assert.equal(resolveSessionMode({ task: "t" }), "isolated");
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_CHILD_SESSION");
    else process.env.PSTACK_CHILD_SESSION = previous;
  }
});

test("resolveChildSessionDir mints, reuses, resumes, and rejects unsafe session paths", () => {
  const root = tempDir();
  try {
    mkdirSync(join(root, "prior"));
    writeFileSync(join(root, "afile"), "x", "utf8");
    const minted = resolveChildSessionDir({ task: "t", sessionMode: "isolated" }, root);
    assert.equal(minted.sessionMode, "isolated");
    assert.equal(minted.continueSession, false);
    assert.equal(minted.sessionDir?.startsWith(join(root, ".pi", "pstack-child-sessions")), true);

    const reused = resolveChildSessionDir({ task: "t", sessionMode: "isolated", sessionDir: "given" }, root);
    assert.equal(reused.sessionDir, join(root, "given"));
    assert.equal(reused.continueSession, false);

    const resumed = resolveChildSessionDir({ task: "t", resumeSessionDir: "prior" }, root);
    assert.deepEqual(resumed, { sessionMode: "isolated", sessionDir: join(root, "prior"), continueSession: true });

    const ephemeral = resolveChildSessionDir({ task: "t", sessionMode: "ephemeral" }, root);
    assert.deepEqual(ephemeral, { sessionMode: "ephemeral", continueSession: false });
    assert.equal(ephemeral.sessionDir, undefined);

    assert.throws(
      () => resolveChildSessionDir({ task: "t", sessionMode: "ephemeral", resumeSessionDir: "prior" }, root),
      /resumeSessionDir conflicts with sessionMode=ephemeral/,
    );
    assert.throws(
      () => resolveChildSessionDir({ task: "t", resumeSessionDir: "afile" }, root),
      /resumeSessionDir is not a directory/,
    );
    assert.throws(
      () => resolveChildSessionDir({ task: "t", resumeSessionDir: "missing" }, root),
      /resumeSessionDir missing or unreadable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveChildSessionDir mints a distinct directory for each simultaneous spawn", () => {
  const root = tempDir();
  try {
    const first = resolveChildSessionDir({ task: "a", sessionMode: "isolated" }, root);
    const second = resolveChildSessionDir({ task: "b", sessionMode: "isolated" }, root);
    assert.equal(typeof first.sessionDir, "string");
    assert.notEqual(first.sessionDir, second.sessionDir);
    assert.equal(first.sessionDir?.includes("pstack-child-sessions"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createJobRegistryCell replaces the whole cell on every write", () => {
  const cell = createJobRegistryCell<{ id: string }>();
  cell.putJob({ id: "a" });
  cell.putJob({ id: "b" });
  assert.deepEqual(cell.jobs().map((job) => job.id), ["a", "b"]);
  cell.putJob({ id: "b", replaced: true } as { id: string });
  assert.deepEqual(cell.job("b"), { id: "b", replaced: true });
  assert.equal(cell.job("missing"), undefined);
  const controller = new AbortController();
  cell.putController("b", controller);
  assert.deepEqual(cell.controllerIds(), ["b"]);
  assert.equal(cell.controller("b"), controller);
  cell.dropController("b");
  assert.equal(cell.controller("b"), undefined);
  assert.deepEqual(cell.controllerIds(), []);
  cell.reset();
  assert.deepEqual(cell.jobs(), []);
});

test("runChildTask picks the last assistant text, forwards stopReason, and maps the exit code", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({
    stdoutChunks: [
      `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "plain" } })}\n`,
      `${JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } })}\n`,
      messageLine("first", "max_tokens"),
    ],
    exitCode: 5,
  });
  try {
    const result = await childRunner.runChildTask(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
      undefined,
    );
    assert.equal(result.output, "first");
    assert.equal(result.stopReason, "max_tokens");
    assert.equal(result.exitCode, 5);
    assert.equal(result.model, "test/parent");
    assert.equal(result.task, "brief");
    assert.equal(result.role, undefined);
    assert.equal(result.sessionDir, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChildTask ignores malformed stdout lines and keeps the parseable ones", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ stdoutChunks: ["{not json}\n", messageLine("after-garbage")] });
  try {
    const result = await childRunner.runChildTask(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
      undefined,
    );
    assert.equal(result.output, "after-garbage");
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChildTask reports (no output) when the child emits nothing", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ stdoutChunks: [], stderrChunks: [] });
  try {
    const result = await childRunner.runChildTask(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
      undefined,
    );
    assert.equal(result.output, "(no output)");
    assert.equal(result.stderr, "");
    assert.equal(result.stopReason, undefined);
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChildTask caps a mid-stream stdout flood and marks the trailer", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ stdoutChunks: ["a".repeat(110000), messageLine("after-cap")] });
  try {
    const result = await childRunner.runChildTask(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
      undefined,
    );
    assert.equal(result.output, "after-cap\n\n[Mid-stream output capped at 51200 bytes.]");
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChildTask caps the stderr stream and reports the truncated trailer", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({
    stdoutChunks: [messageLine("stderr-cap-ok")],
    stderrChunks: ["e".repeat(60000), "tail"],
  });
  try {
    const result = await childRunner.runChildTask(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
      undefined,
    );
    assert.equal(result.output, "stderr-cap-ok\n\n[Mid-stream output capped at 51200 bytes.]");
    assert.match(result.stderr, /\[Output truncated:/);
    assert.equal(result.stderr.includes("tail"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChildTask maps a timeout to exit 124 and the timeout stopReason", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ closes: false, exitCode: 0 });
  try {
    const result = await childRunner.runChildTask(
      { task: "brief", sessionMode: "ephemeral", timeoutMs: 30 },
      root,
      "test/parent",
      undefined,
    );
    assert.equal(result.exitCode, 124);
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.output, "(timed out)");
    assert.deepEqual(lastSpawn().killSignals, ["SIGTERM"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChildTask maps a pre-aborted signal to exit 130 and the aborted stopReason", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ closes: false, exitCode: 0 });
  const controller = new AbortController();
  controller.abort();
  try {
    const result = await childRunner.runChildTask(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
      controller.signal,
    );
    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.deepEqual(lastSpawn().killSignals, ["SIGTERM"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withChildSlot queues past the cap and releases the waiter in order", async () => {
  childRunner.__resetBackgroundJobsForTests();
  const cap = childRunner.MAX_CONCURRENCY;
  let release: Array<() => void> = [];
  const gate = () => new Promise<void>((resolve) => {
    release = [...release, resolve];
  });
  const held = Array.from({ length: cap }, () =>
    childRunner.withChildSlot(async () => {
      await gate();
      return "held";
    }),
  );
  const queued = childRunner.withChildSlot(async () => "queued");
  const busy = childRunner.childConcurrencyStats();
  assert.equal(busy.active, cap);
  assert.equal(busy.cap, cap);
  assert.equal(busy.waiting, 1);
  for (const open of release) open();
  const results = await Promise.all([...held, queued]);
  assert.deepEqual(results, [...Array.from({ length: cap }, () => "held"), "queued"]);
  const idle = childRunner.childConcurrencyStats();
  assert.equal(idle.active, 0);
  assert.equal(idle.waiting, 0);
});

test("piInvocation falls back to the pi binary when running from a bunfs bundle", () => {
  const script = process.argv[1];
  process.argv[1] = "/$bunfs/root/pi";
  try {
    assert.deepEqual(childRunner.piInvocation(["--mode", "json"]), {
      command: "pi",
      args: ["--mode", "json"],
    });
  } finally {
    if (script === undefined) Reflect.deleteProperty(process.argv, 1);
    else process.argv[1] = script;
  }
});

test("enqueueBackgroundChild records a literal job id and a failed job when the spawn throws", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ throwOnSpawn: true });
  try {
    const job = childRunner.enqueueBackgroundChild(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
    );
    assert.match(job.id, /^bg-1-[0-9a-z]+$/);
    assert.equal(job.status, "queued");
    assert.equal(job.model, "test/parent");
    assert.equal(job.taskPreview, "brief");
    const failed = await waitForJob(job.id, "failed");
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "spawn ENOENT");
    assert.equal(failed?.result, undefined);
  } finally {
    childRunner.__resetBackgroundJobsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("enqueueBackgroundChild keeps a finished job when the completion callback throws", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ stdoutChunks: [messageLine("done-output")] });
  try {
    const job = childRunner.enqueueBackgroundChild(
      { task: "brief", sessionMode: "ephemeral" },
      root,
      "test/parent",
      () => {
        throw new Error("boom");
      },
    );
    const done = await waitForJob(job.id, "done");
    assert.equal(done?.status, "done");
    assert.equal(done?.error, "completion callback failed: boom");
    assert.equal(done?.result?.output, "done-output");
    assert.equal(done?.result?.exitCode, 0);
  } finally {
    childRunner.__resetBackgroundJobsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareChildInput survives a throwing getActiveTools and honors inheritParentTools", () => {
  const root = tempDir();
  try {
    const ctx = { model: { provider: "test", id: "model" }, cwd: root, isProjectTrusted: () => true };
    const throwing = {
      getActiveTools() {
        throw new Error("no active tools");
      },
    };
    const withoutTools = subagents.prepareChildInput(
      { task: "brief", sessionMode: "ephemeral", model: "inherit-parent" },
      ctx,
      throwing as never,
    );
    assert.equal(withoutTools.model, "test/model");
    assert.equal(withoutTools.role, "general");
    assert.equal(withoutTools.background, false);
    assert.equal(withoutTools.childInput.tools, undefined);

    const inheriting = subagents.prepareChildInput(
      { task: "brief", sessionMode: "ephemeral", model: "inherit-parent" },
      ctx,
      { getActiveTools: () => ["read", "pstack_jobs"] } as never,
    );
    assert.deepEqual(inheriting.childInput.tools, ["read", "pstack_jobs"]);

    const disabled = subagents.prepareChildInput(
      { task: "brief", sessionMode: "ephemeral", model: "inherit-parent", inheritParentTools: false },
      ctx,
      { getActiveTools: () => ["read", "pstack_jobs"] } as never,
    );
    assert.equal(disabled.childInput.tools, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPreparedChild emits the background spawn onUpdate before returning the job", async () => {
  const root = tempDir();
  childRunner.__resetBackgroundJobsForTests();
  setSpawnPlan({ stdoutChunks: [messageLine("bg-done")] });
  let updates: string[] = [];
  try {
    const reply = await subagents.runPreparedChild({
      prepared: {
        childInput: { task: "brief", sessionMode: "ephemeral" },
        model: "test/model",
        role: "general",
        readonlyApplied: false,
        background: true,
      },
      ctx: { cwd: root },
      parentModel: "test/parent",
      onUpdate: (update: { content: Array<{ text: string }> }) => {
        updates = [...updates, update.content[0]?.text ?? ""];
      },
      pi: { sendUserMessage() {} } as never,
    });
    assert.deepEqual(updates, ["Spawning general on test/model in background…"]);
    assert.equal(reply.details.background, true);
    assert.match(reply.details.jobId as string, /^bg-1-[0-9a-z]+$/);
    await delay(30);
  } finally {
    childRunner.__resetBackgroundJobsForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
