import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { buildWorkerPiArgs } from "../../services/worker/executor.mjs";
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
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  const posted = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: envelope,
    token: TEST_TOKEN,
  });
  assert.equal(posted.status, 202);
  assert.equal(posted.json.runId, envelope.runId);
  assert.equal(posted.json.attempt, 1);
  assert.equal(posted.json.state, "running");
  const record = await waitForState(worker, envelope.runId, TEST_TOKEN, "completed");
  assert.equal(record.state, "completed");
  assert.equal(record.stdout, "hello from worker");
  assert.equal(record.exitCode, 0);
  assert.equal(record.attempt, 1);
  assert.equal(record.outputPath.endsWith(`${envelope.runId}.stdout.log`), true);
  assert.equal(existsSync(record.outputPath), true);
});

test("a duplicate idempotency key returns the same attempt and executes once", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const executor = async () => {
    calls.count = calls.count + 1;
    return { exitCode: 0 };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  const first = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const second = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.json.runId, envelope.runId);
  assert.equal(second.json.attempt, first.json.attempt);
  await waitForState(worker, envelope.runId, TEST_TOKEN, "completed");
  assert.equal(calls.count, 1);
});

test("a different idempotency key for the same runId is rejected 409", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const executor = async () => {
    calls.count = calls.count + 1;
    return { exitCode: 0 };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.after(async () => {
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
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  await waitForState(worker, "run-conflict", TEST_TOKEN, "completed");
  assert.equal(calls.count, 1);
});

test("the default executor argv matches the local child-runner shape", () => {
  const args = buildWorkerPiArgs({
    model: "provider/model",
    sessionDir: "/tmp/session",
    thinkingLevel: "high",
    prompt: "do the work",
  });
  assert.deepEqual(args, [
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
  assert.deepEqual(withoutThinking, ["--mode", "json", "-p", "--model", "m", "--session-dir", "/s", "p"]);
});

test("GET /healthz returns ok without a token", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(worker.base, "/healthz");
  assert.equal(response.status, 200);
  assert.equal(response.json.status, "ok");
});
