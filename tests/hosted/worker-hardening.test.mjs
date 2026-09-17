import { mkdirSync, symlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { main } from "../../services/worker/server.mjs";
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

const LEAK_SENTINEL = "SENTINEL-LEAK-/private/secret/path";
const DEFAULT_PORT = 8787;

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

/**
 * Sends a POST over an explicit http.request so a test controls whether the
 * body carries a content-length header at all, and can leave the socket open
 * when the declared length is deliberately larger than what it writes.
 */
function rawPost(base, options = {}) {
  const target = new URL(base);
  return new Promise((resolve) => {
    const req = httpRequest({
      host: target.hostname,
      port: target.port,
      path: options.path ?? "/v1/tasks",
      method: options.method ?? "POST",
      agent: false,
      headers: {
        ...(options.token === null ? {} : { authorization: `Bearer ${options.token ?? TEST_TOKEN}` }),
        ...(options.headers ?? {}),
      },
    });
    const state = { status: 0, text: "" };
    req.on("response", (res) => {
      state.status = res.statusCode;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        state.text += chunk;
      });
      res.on("end", () => resolve(state));
    });
    req.on("error", () => resolve(state));
    for (const chunk of options.chunks ?? []) req.write(chunk);
    if (!options.holdOpen) req.end();
  });
}

/** Cuts the client socket after the headers and part of the body are sent. */
async function abortMidBody(base) {
  const target = new URL(base);
  await new Promise((resolve) => {
    const socket = net.connect(Number(target.port), target.hostname, () => {
      socket.write(
        `POST /v1/tasks HTTP/1.1\r\nHost: ${target.host}\r\nAuthorization: Bearer ${TEST_TOKEN}\r\n` +
          "Content-Type: application/json\r\nContent-Length: 4096\r\n\r\n{\"runId\":\"cut",
      );
      setTimeout(() => socket.destroy(), 30);
    });
    socket.on("close", resolve);
    socket.on("error", resolve);
  });
}

function snapshotEnv(names) {
  return names.map((name) => ({ name, previous: process.env[name] }));
}

function restoreEnv(name, previous) {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }
  process.env[name] = previous;
}

function restoreEnvMap(entries) {
  for (const entry of entries) restoreEnv(entry.name, entry.previous);
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

test("a /v1 request without an Authorization header is rejected 401", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const missing = await request(worker.base, "/v1/tasks/missing-run");
  expect(missing.status).toBe(401);
  expect(missing.json.error).toMatch(/bearer token/);
});

test("idempotency keys replay the stored run and a conflicting key is rejected 409", async (t) => {
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
  const envelope = makeEnvelope();
  const first = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const replay = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const conflict = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope({ runId: envelope.runId, idempotencyKey: "conflicting-key" }),
    token: TEST_TOKEN,
  });
  expect(first.status).toBe(202);
  expect(replay.status).toBe(200);
  expect(replay.json.runId).toBe(envelope.runId);
  expect(replay.json.attempt).toBe(first.json.attempt);
  expect(conflict.status).toBe(409);
  expect(conflict.json.error).toMatch(/runId already exists/);
  await waitForState(worker, envelope.runId, TEST_TOKEN, "completed");
  expect(calls.count).toBe(1);
});

test("GET /v1/tasks/:runId returns the stored record", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const record = await waitForState(worker, envelope.runId, TEST_TOKEN, "completed");
  const fetched = await request(worker.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  expect(fetched.status).toBe(200);
  expect(fetched.json.runId).toBe(envelope.runId);
  expect(fetched.json.state).toBe("completed");
  expect(fetched.json.task).toBe(record.task);
});

test("GET and cancel reject an invalid runId 400 and an unknown run 404", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const invalidGet = await request(worker.base, "/v1/tasks/bad..id", { token: TEST_TOKEN });
  const invalidCancel = await request(worker.base, "/v1/tasks/bad..id/cancel", {
    method: "POST",
    token: TEST_TOKEN,
  });
  const missingCancel = await request(worker.base, "/v1/tasks/absent-run/cancel", {
    method: "POST",
    token: TEST_TOKEN,
  });
  expect(invalidGet.status).toBe(400);
  expect(invalidGet.json.error).toBe("invalid runId");
  expect(invalidCancel.status).toBe(400);
  expect(invalidCancel.json.error).toBe("invalid runId");
  expect(missingCancel.status).toBe(404);
  expect(missingCancel.json.error).toBe("run not found");
});

test("cancel aborts an in-flight run and cannot be overwritten by its rejection", async (t) => {
  const stateDir = tempStateDir();
  const aborted = { fired: false };
  const executor = (context) =>
    new Promise((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          aborted.fired = true;
          reject(new Error("executor observed the abort"));
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
  expect(aborted.fired).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = await request(worker.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
  expect(after.json.state).toBe("cancelled");
  expect(after.json.error).toBe(null);
});

test("cancel of an already-terminal run leaves its recorded outcome alone", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  await waitForState(worker, envelope.runId, TEST_TOKEN, "completed");
  const cancelled = await request(worker.base, `/v1/tasks/${envelope.runId}/cancel`, {
    method: "POST",
    token: TEST_TOKEN,
  });
  expect(cancelled.status).toBe(200);
  expect(cancelled.json.state).toBe("completed");
  expect(cancelled.json.exitCode).toBe(0);
  expect(cancelled.json.stopReason).toBe(null);
});

test("cancel of a run restored from disk records cancelled without a live controller", async (t) => {
  const stateDir = tempStateDir();
  const first = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: () => new Promise(() => {}),
    leaseMs: 60000,
  });
  const envelope = makeEnvelope({ timeoutMs: 60000 });
  await request(first.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  await first.close();
  const second = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await second.close();
    cleanupStateDir(stateDir);
  });
  const cancelled = await request(second.base, `/v1/tasks/${envelope.runId}/cancel`, {
    method: "POST",
    token: TEST_TOKEN,
  });
  expect(cancelled.status).toBe(200);
  expect(cancelled.json.state).toBe("cancelled");
  expect(cancelled.json.exitCode).toBe(130);
});

test("unmatched paths and methods return 404", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const responses = await Promise.all([
    request(worker.base, "/nope", { token: TEST_TOKEN }),
    request(worker.base, "/v1/unknown", { token: TEST_TOKEN }),
    request(worker.base, "/v1/tasks", { token: TEST_TOKEN }),
    request(worker.base, "/v1/tasks/route-run", { method: "PUT", token: TEST_TOKEN }),
    request(worker.base, "/v1/tasks/route-run", { method: "POST", token: TEST_TOKEN }),
    request(worker.base, "/v1/tasks/route-run/cancel", { token: TEST_TOKEN }),
  ]);
  expect(responses.map((entry) => entry.status)).toEqual([404, 404, 404, 404, 404, 404]);
  expect(responses.every((entry) => entry.json.error === "not found")).toBe(true);
});

test("a chunked body over the limit is rejected 413 without executing", async (t) => {
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
  const chunk = "x".repeat(96 * 1024);
  const response = await rawPost(worker.base, { chunks: [chunk, chunk, chunk, chunk, chunk] });
  expect(response.status).toBe(413);
  expect(JSON.parse(response.text)).toEqual({ error: "too_large" });
  expect(calls.count).toBe(0);
});

test("a declared content-length over the limit is rejected 413 before the body arrives", async (t) => {
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
  const response = await rawPost(worker.base, {
    headers: { "content-length": String(8 * 1024 * 1024), "content-type": "application/json" },
    chunks: ["{}"],
    holdOpen: true,
  });
  expect(response.status).toBe(413);
  expect(JSON.parse(response.text)).toEqual({ error: "too_large" });
  expect(calls.count).toBe(0);
});

test("a request body cut off mid-stream is discarded and the worker keeps serving", async (t) => {
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
  await abortMidBody(worker.base);
  const health = await request(worker.base, "/healthz");
  const followUp = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope(),
    token: TEST_TOKEN,
  });
  expect(health.status).toBe(200);
  expect(followUp.status).toBe(202);
  expect(calls.count).toBe(1);
});

test("an executor that throws is recorded as failed with its message", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => {
      throw new Error("executor exploded");
    },
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  const posted = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  expect(posted.status).toBe(202);
  const record = await waitForState(worker, envelope.runId, TEST_TOKEN, "failed");
  expect(record.exitCode).toBe(1);
  expect(record.error).toBe("executor exploded");
});

test("an executor that throws a non-Error is still recorded as failed", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async () => {
      throw "plain string failure";
    },
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope();
  await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  const record = await waitForState(worker, envelope.runId, TEST_TOKEN, "failed");
  expect(record.state).toBe("failed");
  expect(record.error).toBe("plain string failure");
});

test("executor results map to completed for 0 and failed for a non-zero exit code", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({
    stateDir,
    token: TEST_TOKEN,
    execute: async (context) => (context.envelope.task === "no exit code" ? {} : { exitCode: 2, stopReason: "end" }),
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const defaults = makeEnvelope({ task: "no exit code" });
  const failed = makeEnvelope({ task: "non-zero" });
  await request(worker.base, "/v1/tasks", { method: "POST", body: defaults, token: TEST_TOKEN });
  await request(worker.base, "/v1/tasks", { method: "POST", body: failed, token: TEST_TOKEN });
  const completed = await waitForState(worker, defaults.runId, TEST_TOKEN, "completed");
  const broken = await waitForState(worker, failed.runId, TEST_TOKEN, "failed");
  expect(completed.exitCode).toBe(0);
  expect(broken.exitCode).toBe(2);
  expect(broken.stopReason).toBe("end");
});

test("a malformed JSON body is rejected 400 with the parser detail", async (t) => {
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
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: '{"runId": ',
    token: TEST_TOKEN,
  });
  expect(response.status).toBe(400);
  expect(response.json.error).toMatch(/^invalid JSON: /);
  expect(calls.count).toBe(0);
});

test("a worker with no execute option still serves healthz", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const health = await request(worker.base, "/healthz");
  expect(health.status).toBe(200);
  expect(health.json).toEqual({ status: "ok" });
});

test("startWorker without a token option reads PSTACK_WORKER_TOKEN", async (t) => {
  const stateDir = tempStateDir();
  const previous = process.env.PSTACK_WORKER_TOKEN;
  process.env.PSTACK_WORKER_TOKEN = "env-worker-token";
  const worker = await startWorker({ stateDir, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
    restoreEnv("PSTACK_WORKER_TOKEN", previous);
  });
  const denied = await request(worker.base, "/v1/tasks/missing-run", { token: "not-the-env-token" });
  const allowed = await request(worker.base, "/v1/tasks/missing-run", { token: "env-worker-token" });
  expect(denied.status).toBe(401);
  expect(allowed.status).toBe(404);
});

test("a worker with no token in options or environment refuses /v1 with 503", async (t) => {
  const stateDir = tempStateDir();
  const previous = process.env.PSTACK_WORKER_TOKEN;
  Reflect.deleteProperty(process.env, "PSTACK_WORKER_TOKEN");
  const calls = { count: 0 };
  const worker = await startWorker({
    stateDir,
    execute: async () => {
      calls.count = calls.count + 1;
      return { exitCode: 0 };
    },
  });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
    restoreEnv("PSTACK_WORKER_TOKEN", previous);
  });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    body: makeEnvelope(),
    token: "anything",
  });
  expect(response.status).toBe(503);
  expect(response.json.error).toMatch(/token is not configured/);
  expect(calls.count).toBe(0);
});

test("main() falls back to the default port when PSTACK_WORKER_PORT is not numeric", async (t) => {
  const stateDir = tempStateDir();
  const env = snapshotEnv(["PSTACK_WORKER_PORT", "PSTACK_WORKER_TOKEN", "PSTACK_WORKER_STATE_DIR"]);
  process.env.PSTACK_WORKER_STATE_DIR = stateDir;
  process.env.PSTACK_WORKER_PORT = "not-a-number";
  Reflect.deleteProperty(process.env, "PSTACK_WORKER_TOKEN");
  const listenError = { value: null };
  const server = main();
  server.on("error", (error) => {
    listenError.value = error;
  });
  t.onTestFinished(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    restoreEnvMap(env);
    cleanupStateDir(stateDir);
  });
  await waitFor(() => server.listening);
  expect(listenError.value).toBe(null);
  expect(server.address().port).toBe(DEFAULT_PORT);
  const base = `http://127.0.0.1:${DEFAULT_PORT}`;
  const health = await rawPost(base, { method: "GET", path: "/healthz" });
  const denied = await rawPost(base, { method: "GET", path: "/v1/tasks/missing-run", token: "any" });
  expect(health.status).toBe(200);
  expect(JSON.parse(health.text)).toEqual({ status: "ok" });
  expect(denied.status).toBe(503);
});

test("main() takes the token and in-flight cap from the environment", async (t) => {
  const stateDir = tempStateDir();
  const env = snapshotEnv([
    "PSTACK_WORKER_PORT",
    "PSTACK_WORKER_TOKEN",
    "PSTACK_WORKER_MAX_IN_FLIGHT",
    "PSTACK_WORKER_STATE_DIR",
  ]);
  process.env.PSTACK_WORKER_STATE_DIR = stateDir;
  Reflect.deleteProperty(process.env, "PSTACK_WORKER_PORT");
  process.env.PSTACK_WORKER_TOKEN = "main-token";
  process.env.PSTACK_WORKER_MAX_IN_FLIGHT = "2";
  const listenError = { value: null };
  const server = main();
  server.on("error", (error) => {
    listenError.value = error;
  });
  t.onTestFinished(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    restoreEnvMap(env);
    cleanupStateDir(stateDir);
  });
  await waitFor(() => server.listening);
  expect(listenError.value).toBe(null);
  expect(server.address().port).toBe(DEFAULT_PORT);
  const base = `http://127.0.0.1:${DEFAULT_PORT}`;
  const denied = await rawPost(base, { method: "GET", path: "/v1/tasks/missing-run", token: null });
  const allowed = await rawPost(base, { method: "GET", path: "/v1/tasks/missing-run", token: "main-token" });
  expect(denied.status).toBe(401);
  expect(allowed.status).toBe(404);
});
