import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  TEST_TOKEN,
  cleanupStateDir,
  makeEnvelope,
  request,
  startWorker,
  tempStateDir,
} from "./helpers.mjs";

const LEAK_SENTINEL = "SENTINEL-LEAK-/private/secret/path";

async function probe(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, retryAfter: response.headers.get("retry-after"), text };
}

test("the worker caps per-client /v1 requests and sends Retry-After", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => ({ exitCode: 0 }),
    rateLimit: { maxRequests: 3, windowMs: 60_000 },
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const probes = await Promise.all(
    [0, 1, 2, 3, 4].map(() => probe(worker.base, "/v1/tasks/missing-run", { token: TEST_TOKEN })),
  );
  expect(probes.map((entry) => entry.status).toSorted()).toEqual([404, 404, 404, 429, 429]);
  const throttled = probes.filter((entry) => entry.status === 429);
  expect(throttled.every((entry) => Number(entry.retryAfter) >= 1)).toBe(true);
});

test("/healthz is exempt from the worker request cap", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => ({ exitCode: 0 }),
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const probes = await Promise.all(Array.from({ length: 6 }, () => probe(worker.base, "/healthz")));
  expect(probes.every((entry) => entry.status === 200)).toBe(true);
});

test("rotating an invalid token does not evade the worker client cap", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => ({ exitCode: 0 }),
    rateLimit: { maxRequests: 3, windowMs: 60_000 },
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const probes = await Promise.all(
    [0, 1, 2, 3, 4].map((index) =>
      probe(worker.base, "/v1/tasks/missing-run", { token: `bogus-${index}` }),
    ),
  );
  expect(probes.filter((entry) => entry.status === 401).length).toBe(3);
  expect(probes.filter((entry) => entry.status === 429).length).toBe(2);
});

test("an unexpected worker error returns an opaque 500", async (t) => {
  const stateDir = tempStateDir();
  let armed = false;
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    now: () => {
      if (armed) throw new Error(`state write failed at ${LEAK_SENTINEL}`);
      return Date.now();
    },
    execute: async () => ({ exitCode: 0 }),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  armed = true;
  const response = await probe(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: makeEnvelope({ runId: "leak-run", idempotencyKey: "leak-key" }),
  });
  expect(response.status).toBe(500);
  expect(response.text.includes(LEAK_SENTINEL)).toBe(false);
  expect(JSON.parse(response.text)).toEqual({ error: "internal error" });
});

test("parentOwnership.cwd outside the workspace root is rejected 400", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => ({ exitCode: 0 }),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: makeEnvelope({
      parentOwnership: { sessionId: "s", cwd: "/etc" },
      parentSessionCwd: "/etc",
    }),
  });
  expect(response.status).toBe(400);
  expect(response.json.error).toMatch(/workspace root/);
});

test("a symlink inside the workspace cannot escape it", async (t) => {
  const stateDir = tempStateDir();
  const workspace = tempStateDir();
  symlinkSync("/etc", join(workspace, "escape"));
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    workspaceRoot: workspace,
    execute: async () => ({ exitCode: 0 }),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
    cleanupStateDir(workspace);
  });
  const target = join(workspace, "escape");
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: makeEnvelope({
      parentOwnership: { sessionId: "s", cwd: target },
      parentSessionCwd: target,
    }),
  });
  expect(response.status).toBe(400);
});

test("a cwd inside the workspace root is accepted", async (t) => {
  const stateDir = tempStateDir();
  const workspace = tempStateDir();
  const inside = join(workspace, "subdir");
  mkdirSync(inside, { recursive: true });
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    workspaceRoot: workspace,
    execute: async () => ({ exitCode: 0 }),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
    cleanupStateDir(workspace);
  });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: makeEnvelope({
      parentOwnership: { sessionId: "s", cwd: inside },
      parentSessionCwd: inside,
    }),
  });
  expect(response.status).toBe(202);
});

test("the model must match a safe selector shape", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => ({ exitCode: 0 }),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const rejected = await request(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: makeEnvelope({ runId: "bad-model", idempotencyKey: "bad-model-key", model: "bad model; rm -rf /" }),
  });
  const accepted = await request(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: makeEnvelope({
      runId: "good-model",
      idempotencyKey: "good-model-key",
      model: "anthropic/claude-opus-4:high",
    }),
  });
  expect(rejected.status).toBe(400);
  expect(accepted.status).toBe(202);
});

test("tasks past maxInFlight are rejected with 503 and Retry-After", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    maxInFlight: 2,
    execute: (context) =>
      new Promise((resolvePromise) => {
        context.signal.addEventListener("abort", () => resolvePromise({ exitCode: 130 }), { once: true });
      }),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const probes = await Promise.all(
    Array.from({ length: 6 }, (_unused, index) =>
      probe(worker.base, "/v1/tasks", {
        method: "POST",
        token: TEST_TOKEN,
        body: makeEnvelope({ runId: `cap-run-${index}`, idempotencyKey: `cap-key-${index}` }),
      }),
    ),
  );
  const rejected = probes.filter((entry) => entry.status === 503);
  expect(probes.filter((entry) => entry.status === 202).length).toBe(2);
  expect(rejected.length).toBe(4);
  expect(rejected.every((entry) => Number(entry.retryAfter) >= 1)).toBe(true);
});
