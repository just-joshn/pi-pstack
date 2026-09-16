import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createRunStore } from "../../services/worker/store.mjs";
import {
  TEST_TOKEN,
  cleanupStateDir,
  makeEnvelope,
  request,
  startWorker,
  tempStateDir,
  waitFor,
  waitForState,
} from "./helpers.mjs";

test("cancel during a hung execution records cancelled and fires the abort signal", async (t) => {
  const stateDir = tempStateDir();
  const aborted = { fired: false };
  const executor = (context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          aborted.fired = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ timeoutMs: 60000 });
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const cancelled = await request(worker.base, `/v1/tasks/${envelope.runId}/cancel`, {
    method: "POST",
    token: TEST_TOKEN,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.state, "cancelled");
  assert.equal(cancelled.json.exitCode, 130);
  assert.equal(cancelled.json.stopReason, "cancelled");
  assert.equal(aborted.fired, true);
});

test("a completion from a stale attempt is rejected", async (t) => {
  const stateDir = tempStateDir();
  const gate = { release: () => {} };
  const pending = new Promise((resolve) => {
    gate.release = resolve;
  });
  const executor = async () => {
    await pending;
    return { exitCode: 0 };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ timeoutMs: 60000 });
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const store = createRunStore({ stateDir });
  const bumped = store.claimAttempt(envelope.runId);
  assert.equal(bumped.attempt, 2);
  gate.release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const response = await request(worker.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  assert.equal(response.json.attempt, 2);
  assert.equal(response.json.state, "running");
});

test("a run past timeoutMs is marked timed_out", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: () => new Promise(() => {}),
  });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ timeoutMs: 1000 });
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const record = await waitForState(worker, envelope.runId, TEST_TOKEN, "timed_out", 5000);
  assert.equal(record.state, "timed_out");
  assert.equal(record.exitCode, 124);
  assert.equal(record.stopReason, "timeout");
});

test("a restart reconciles a dead lease without losing the partial output", async (t) => {
  const stateDir = tempStateDir();
  const executor = (context) => {
    context.writeStdout("partial output");
    return new Promise(() => {});
  };
  const first = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor, leaseMs: 60000 });
  const envelope = makeEnvelope({ timeoutMs: 60000 });
  await request(first.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const store = createRunStore({ stateDir });
  await waitFor(() => existsSync(store.outputPath(envelope.runId, "stdout")));
  await first.close();
  const second = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => ({ exitCode: 0 }),
    leaseMs: 0,
  });
  t.after(async () => {
    await second.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(second.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  assert.equal(response.status, 200);
  assert.equal(response.json.state, "dead");
  assert.equal(response.json.stdout, "partial output");
  assert.equal(response.json.stopReason, "lease_expired");
  assert.equal(existsSync(store.outputPath(envelope.runId, "stdout")), true);
});

test("parent shutdown does not cancel a durable run", async (t) => {
  const stateDir = tempStateDir();
  const first = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: () => new Promise(() => {}),
    leaseMs: 60000,
  });
  const envelope = makeEnvelope({ timeoutMs: 60000 });
  await request(first.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const second = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => ({ exitCode: 0 }),
    leaseMs: 60000,
  });
  t.after(async () => {
    await first.close();
    await second.close();
    cleanupStateDir(stateDir);
  });
  const before = await request(first.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  const after = await request(second.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  assert.equal(before.json.state, "running");
  assert.equal(after.status, 200);
  assert.equal(after.json.runId, envelope.runId);
  assert.equal(after.json.state, "running");
});

test("a request without a token is rejected when a token is configured", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => {
      calls.count = calls.count + 1;
      return { exitCode: 0 };
    },
  });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const missing = await request(worker.base, "/v1/tasks", { method: "POST", body: makeEnvelope() });
  const wrong = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope(),
    token: "not-the-token",
  });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(calls.count, 0);
});

test("a worker with no configured token refuses /v1 with 503", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const worker = await startWorker({
    stateDir,
    token: "",
    execute: async () => {
      calls.count = calls.count + 1;
      return { exitCode: 0 };
    },
  });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope(),
    token: "anything",
  });
  assert.equal(response.status, 503);
  assert.equal(calls.count, 0);
});

test("a malformed body is rejected 400 without executing", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => {
      calls.count = calls.count + 1;
      return { exitCode: 0 };
    },
  });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const badJson = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: "{not json",
    token: TEST_TOKEN,
  });
  const badShape = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: { runId: "bad id", idempotencyKey: "k", task: "t", role: "r", model: "m" },
    token: TEST_TOKEN,
  });
  assert.equal(badJson.status, 400);
  assert.equal(badShape.status, 400);
  assert.equal(calls.count, 0);
});

test("an oversized body is rejected", async (t) => {
  const stateDir = tempStateDir();
  const calls = { count: 0 };
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => {
      calls.count = calls.count + 1;
      return { exitCode: 0 };
    },
  });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ task: "x".repeat(300 * 1024) });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: envelope,
    token: TEST_TOKEN,
  });
  assert.equal(response.status, 413);
  assert.equal(calls.count, 0);
});
