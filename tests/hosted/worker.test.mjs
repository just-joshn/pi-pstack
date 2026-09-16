import { existsSync } from "node:fs";
import { expect, test } from "vitest";
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
