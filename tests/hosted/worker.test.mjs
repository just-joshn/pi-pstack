import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildWorkerPiArgs, createPiExecutor } from "../../services/worker/executor.mjs";
import {
  TEST_TOKEN,
  cleanupStateDir,
  makeEnvelope,
  request,
  startWorker,
  tempStateDir,
  waitForState,
} from "./helpers.mjs";

test("happy path records completed with the streamed stdout", async (t) => {
  const stateDir = tempStateDir();
  const executor = async (context) => {
    context.writeStdout("hello from worker");
    return { exitCode: 0, stopReason: "end" };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  const posted = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: envelope,
    token: TEST_TOKEN,
  });
  expect(posted.status).toBe(202);
  expect(posted.json.runId).toBe(envelope.runId);
  expect(posted.json.attempt).toBe(1);
  expect(posted.json.state).toBe("running");
  const record = await waitForState(worker, envelope.runId, TEST_TOKEN, "completed");
  expect(record.state).toBe("completed");
  expect(record.stdout).toBe("hello from worker");
  expect(record.exitCode).toBe(0);
  expect(record.attempt).toBe(1);
  expect(record.outputPath.endsWith(`${envelope.runId}.stdout.log`)).toBe(true);
  expect(existsSync(record.outputPath)).toBe(true);
});

test("a duplicate idempotency key returns the same attempt and executes once", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const executor = async () => {
    calls.count = calls.count + 1;
    return { exitCode: 0 };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  const first = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const second = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  expect(first.status).toBe(202);
  expect(second.status).toBe(200);
  expect(second.json.runId).toBe(envelope.runId);
  expect(second.json.attempt).toBe(first.json.attempt);
  await waitForState(worker, envelope.runId, TEST_TOKEN, "completed");
  expect(calls.count).toBe(1);
});

test("a different idempotency key for the same runId is rejected 409", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const executor = async () => {
    calls.count = calls.count + 1;
    return { exitCode: 0 };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const first = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope({ runId: "run-conflict", idempotencyKey: "key-a" }),
    token: TEST_TOKEN,
  });
  const second = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope({ runId: "run-conflict", idempotencyKey: "key-b" }),
    token: TEST_TOKEN,
  });
  expect(first.status).toBe(202);
  expect(second.status).toBe(409);
  await waitForState(worker, "run-conflict", TEST_TOKEN, "completed");
  expect(calls.count).toBe(1);
});

test("the default executor argv matches the local child-runner shape", () => {
  const args = buildWorkerPiArgs({
    model: "provider/model",
    sessionDir: "/tmp/session",
    thinkingLevel: "high",
    prompt: "do the work",
  });
  expect(args).toEqual([
    "--mode",
    "json",
    "-p",
    "--model",
    "provider/model",
    "--session-dir",
    "/tmp/session",
    "--thinking",
    "high",
    "do the work",
  ]);
  const withoutThinking = buildWorkerPiArgs({ model: "m", sessionDir: "/s", prompt: "p" });
  expect(withoutThinking).toEqual(["--mode", "json", "-p", "--model", "m", "--session-dir", "/s", "p"]);
});

function writeFakePi(dir, body, name = "fake-pi") {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function pinPiBin(piPath) {
  const saved = process.env.PSTACK_WORKER_PI_BIN;
  if (piPath === undefined) Reflect.deleteProperty(process.env, "PSTACK_WORKER_PI_BIN");
  else process.env.PSTACK_WORKER_PI_BIN = piPath;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "PSTACK_WORKER_PI_BIN");
    else process.env.PSTACK_WORKER_PI_BIN = saved;
  };
}

function executorHarness({ envelope, signal }) {
  const stateDir = tempStateDir();
  const sessionsDir = join(stateDir, "sessions");
  const stdout = { text: "" };
  const stderr = { text: "" };
  const execute = createPiExecutor({ store: { sessionsDir } });
  const promise = execute({
    envelope,
    signal,
    writeStdout: (chunk) => {
      stdout.text = stdout.text + chunk;
    },
    writeStderr: (chunk) => {
      stderr.text = stderr.text + chunk;
    },
  });
  return { stateDir, sessionsDir, stdout, stderr, promise };
}

async function runExecutor({ piPath, envelope, signal }) {
  const restore = pinPiBin(piPath);
  const harness = executorHarness({ envelope, signal });
  let result;
  try {
    result = await harness.promise;
  } finally {
    restore();
  }
  return {
    result,
    stateDir: harness.stateDir,
    sessionsDir: harness.sessionsDir,
    stdout: harness.stdout.text,
    stderr: harness.stderr.text,
  };
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the executor runs the pinned pi binary, streams both pipes, and ends on exit zero", async () => {
  const dir = tempStateDir();
  const pi = writeFakePi(
    dir,
    'process.stdout.write("cwd=" + process.cwd() + "\\n");\nprocess.stderr.write("pi-err\\n");',
  );
  const envelope = makeEnvelope();
  const run = await runExecutor({ piPath: pi, envelope, signal: new AbortController().signal });
  try {
    expect(run.result).toEqual({ exitCode: 0, stopReason: "end" });
    expect(run.stdout).toBe(`cwd=${process.cwd()}\n`);
    expect(run.stderr).toBe("pi-err\n");
    expect(existsSync(join(run.sessionsDir, envelope.runId))).toBe(true);
  } finally {
    cleanupStateDir(run.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor falls back to the worker process cwd when the envelope has no parent cwd", async () => {
  const dir = tempStateDir();
  const pi = writeFakePi(dir, 'process.stdout.write("cwd=" + process.cwd() + "\\n");');
  const envelope = makeEnvelope({ parentOwnership: { sessionId: "session-test" } });
  const run = await runExecutor({ piPath: pi, envelope, signal: new AbortController().signal });
  try {
    expect(run.result).toEqual({ exitCode: 0, stopReason: "end" });
    expect(run.stdout).toBe(`cwd=${process.cwd()}\n`);
  } finally {
    cleanupStateDir(run.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor reports a nonzero exit code with the error stop reason", async () => {
  const dir = tempStateDir();
  const pi = writeFakePi(dir, 'process.stderr.write("boom\\n");\nprocess.exit(7);');
  const run = await runExecutor({ piPath: pi, envelope: makeEnvelope(), signal: new AbortController().signal });
  try {
    expect(run.result).toEqual({ exitCode: 7, stopReason: "error" });
    expect(run.stderr).toBe("boom\n");
  } finally {
    cleanupStateDir(run.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor kills the child for a signal that is already aborted", async () => {
  const dir = tempStateDir();
  const pi = writeFakePi(dir, "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  controller.abort();
  const run = await runExecutor({ piPath: pi, envelope: makeEnvelope(), signal: controller.signal });
  try {
    expect(run.result).toEqual({ exitCode: 1, stopReason: "error" });
  } finally {
    cleanupStateDir(run.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor kills a running child when the signal aborts mid-run", async () => {
  const dir = tempStateDir();
  const ready = join(dir, "ready");
  const pi = writeFakePi(
    dir,
    [
      'const { writeFileSync } = require("node:fs");',
      'process.stdout.write("ready\\n");',
      `writeFileSync(${JSON.stringify(ready)}, "1");`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const controller = new AbortController();
  const restore = pinPiBin(pi);
  const harness = executorHarness({ envelope: makeEnvelope(), signal: controller.signal });
  try {
    await waitForFile(ready);
    await settle(50);
    controller.abort();
    expect(await harness.promise).toEqual({ exitCode: 1, stopReason: "error" });
    expect(harness.stdout.text).toContain("ready");
  } finally {
    restore();
    cleanupStateDir(harness.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const dir = tempStateDir();
  const ready = join(dir, "ready");
  const pi = writeFakePi(
    dir,
    [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGTERM", () => { process.stdout.write("ignored\\n"); });',
      `writeFileSync(${JSON.stringify(ready)}, "1");`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const controller = new AbortController();
  const restore = pinPiBin(pi);
  const harness = executorHarness({ envelope: makeEnvelope(), signal: controller.signal });
  try {
    await waitForFile(ready);
    const startedAt = Date.now();
    controller.abort();
    expect(await harness.promise).toEqual({ exitCode: 1, stopReason: "error" });
    expect(harness.stdout.text).toContain("ignored");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4000);
  } finally {
    restore();
    cleanupStateDir(harness.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor reuses the node entry when argv[1] is the pi entry script", async () => {
  const dir = tempStateDir();
  const pi = writeFakePi(dir, 'process.stdout.write("entry\\n");', "pi");
  const savedArgv = process.argv[1];
  process.argv[1] = pi;
  let run;
  try {
    run = await runExecutor({
      piPath: undefined,
      envelope: makeEnvelope(),
      signal: new AbortController().signal,
    });
    expect(run.result).toEqual({ exitCode: 0, stopReason: "end" });
    expect(run.stdout).toBe("entry\n");
  } finally {
    process.argv[1] = savedArgv;
    if (run) cleanupStateDir(run.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor falls back to pi on PATH for a standalone worker process", async () => {
  const dir = tempStateDir();
  writeFakePi(dir, 'process.stdout.write("via-path\\n");', "pi");
  const savedArgv = process.argv[1];
  const savedPath = process.env.PATH;
  process.argv[1] = join(dir, "server.mjs");
  process.env.PATH = `${dir}:${savedPath}`;
  let run;
  try {
    run = await runExecutor({
      piPath: undefined,
      envelope: makeEnvelope(),
      signal: new AbortController().signal,
    });
    expect(run.result).toEqual({ exitCode: 0, stopReason: "end" });
    expect(run.stdout).toBe("via-path\n");
  } finally {
    process.argv[1] = savedArgv;
    process.env.PATH = savedPath;
    if (run) cleanupStateDir(run.stateDir);
    cleanupStateDir(dir);
  }
});

test("the executor reports exit code 1 when the pi binary cannot be spawned", async () => {
  const dir = tempStateDir();
  const run = await runExecutor({
    piPath: join(dir, "absent-pi"),
    envelope: makeEnvelope(),
    signal: new AbortController().signal,
  });
  try {
    expect(run.result).toEqual({ exitCode: 1, stopReason: "error" });
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  } finally {
    cleanupStateDir(run.stateDir);
    cleanupStateDir(dir);
  }
});

test("GET /healthz returns ok without a token", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(worker.base, "/healthz");
  expect(response.status).toBe(200);
  expect(response.json.status).toBe("ok");
});
