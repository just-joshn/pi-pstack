import { existsSync } from "node:fs";
import { expect, test } from "vitest";
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
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ timeoutMs: 60000 });
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const cancelled = await request(worker.base, `/v1/tasks/${envelope.runId}/cancel`, {
    method: "POST",
    token: TEST_TOKEN,
  });
  expect(cancelled.status).toBe(200);
  expect(cancelled.json.state).toBe("cancelled");
  expect(cancelled.json.exitCode).toBe(130);
  expect(cancelled.json.stopReason).toBe("cancelled");
  expect(aborted.fired).toBe(true);
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
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ timeoutMs: 60000 });
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const store = createRunStore({ stateDir });
  const bumped = store.claimAttempt(envelope.runId);
  expect(bumped.attempt).toBe(2);
  gate.release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const response = await request(worker.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  expect(response.json.attempt).toBe(2);
  expect(response.json.state).toBe("running");
});

test("a run past timeoutMs is marked timed_out", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: () => new Promise(() => {}),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ timeoutMs: 1000 });
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const record = await waitForState(worker, envelope.runId, TEST_TOKEN, "timed_out", 5000);
  expect(record.state).toBe("timed_out");
  expect(record.exitCode).toBe(124);
  expect(record.stopReason).toBe("timeout");
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
  t.onTestFinished(async () => {
    await second.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(second.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  expect(response.status).toBe(200);
  expect(response.json.state).toBe("dead");
  expect(response.json.stdout).toBe("partial output");
  expect(response.json.stopReason).toBe("lease_expired");
  expect(existsSync(store.outputPath(envelope.runId, "stdout"))).toBe(true);
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
  t.onTestFinished(async () => {
    await first.close();
    await second.close();
    cleanupStateDir(stateDir);
  });
  const before = await request(first.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  const after = await request(second.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  expect(before.json.state).toBe("running");
  expect(after.status).toBe(200);
  expect(after.json.runId).toBe(envelope.runId);
  expect(after.json.state).toBe("running");
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
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const missing = await request(worker.base, "/v1/tasks", { method: "POST", body: makeEnvelope() });
  const wrong = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope(),
    token: "not-the-token",
  });
  expect(missing.status).toBe(401);
  expect(wrong.status).toBe(401);
  expect(calls.count).toBe(0);
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
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope(),
    token: "anything",
  });
  expect(response.status).toBe(503);
  expect(calls.count).toBe(0);
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
  t.onTestFinished(async () => {
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
  expect(badJson.status).toBe(400);
  expect(badShape.status).toBe(400);
  expect(calls.count).toBe(0);
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
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ task: "x".repeat(300 * 1024) });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: envelope,
    token: TEST_TOKEN,
  });
  expect(response.status).toBe(413);
  expect(calls.count).toBe(0);
});
