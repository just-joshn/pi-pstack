/**
 * Hosted worker HTTP service. createWorkerServer is the whole contract:
 * POST /v1/tasks, GET /v1/tasks/:runId, POST /v1/tasks/:runId/cancel,
 * GET /healthz. See PROTOCOL.md for the wire shapes and lifecycle.
 *
 * The executor is injectable so tests drive completion, hangs, aborts, and
 * timeouts without spawning pi. The default executor spawns pi through the same
 * argv shape the local child runner uses.
 *
 * Auth is fail-closed: with no configured token every /v1 route returns 503
 * rather than running unauthenticated. /healthz stays open for liveness probes.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPiExecutor } from "./executor.mjs";
import { MAX_BODY_BYTES, validateTaskRequest } from "./protocol.mjs";
import { clientKeyOf, createRateLimiter, rateLimitFromEnv } from "./rate-limit.mjs";
import { createRunStore, isTerminalState, isValidRunId } from "./store.mjs";

const DEFAULT_PORT = 8787;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_IN_FLIGHT = 8;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text, "utf8"),
    ...headers,
  });
  res.end(text);
}

function safeEqual(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/**
 * Only an authenticated credential contributes its own bucket. Anything else
 * falls back to the address-only bucket, so an attacker cannot mint fresh
 * rate-limit keys by rotating invalid tokens.
 */
function limiterKey(runtime, req) {
  const presented = bearerToken(req);
  const authenticated = presented !== null && runtime.token !== "" && safeEqual(presented, runtime.token);
  return clientKeyOf(req, authenticated ? presented : "");
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      resolve({ ok: false, reason: "too_large" });
      return;
    }
    let size = 0;
    let chunks = [];
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size = size + chunk.length;
      if (size > maxBytes) {
        settle({ ok: false, reason: "too_large" });
        req.resume();
        return;
      }
      chunks = [...chunks, chunk];
    });
    req.on("end", () => settle({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => settle({ ok: false, reason: "read_error" }));
  });
}

/** The live controllers as an immutable cell: `drain` empties it by replacement. */
function createInFlightCell() {
  let controllers = new Map();
  return {
    size: () => controllers.size,
    get: (runId) => controllers.get(runId),
    add: (runId, controller) => {
      controllers = new Map(controllers).set(runId, controller);
    },
    remove: (runId) => {
      const next = new Map(controllers);
      next.delete(runId);
      controllers = next;
    },
    drain: () => {
      const open = [...controllers.values()];
      controllers = new Map();
      return open;
    },
  };
}

function createRuntime(options) {
  const now = options.now ?? (() => Date.now());
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const token = options.token ?? process.env.PSTACK_WORKER_TOKEN ?? "";
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const maxInFlight = positiveInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT);
  const store = createRunStore({ stateDir: options.stateDir, now, leaseMs });
  const execute = options.execute ?? createPiExecutor({ store });
  const limiter = createRateLimiter({ ...(options.rateLimit ?? {}), now });
  return { now, leaseMs, token, workspaceRoot, maxInFlight, store, execute, limiter, inFlight: createInFlightCell() };
}

function authorize(runtime, req) {
  if (!runtime.token) {
    return { status: 503, body: { error: "worker token is not configured; refusing to run unauthenticated" } };
  }
  const presented = bearerToken(req);
  if (presented === null || !safeEqual(presented, runtime.token)) {
    return { status: 401, body: { error: "invalid or missing bearer token" } };
  }
  return null;
}

function finalize(runtime, runId, attempt, state, extra = {}) {
  const current = runtime.store.loadRun(runId);
  if (!current || isTerminalState(current.state) || current.attempt !== attempt) return current;
  const stdout = runtime.store.readOutput(runId, "stdout");
  const stderr = runtime.store.readOutput(runId, "stderr");
  const at = runtime.now();
  return runtime.store.saveRun({
    ...current,
    state,
    stdout,
    stderr,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
    outputPath: extra.outputPath ?? runtime.store.outputPath(runId, "stdout"),
    exitCode: extra.exitCode ?? null,
    stopReason: extra.stopReason ?? current.stopReason ?? null,
    error: extra.error ?? null,
    finishedAt: at,
    updatedAt: at,
    leaseExpiresAt: null,
  });
}

function startExecution(runtime, record, envelope) {
  const controller = new AbortController();
  const runId = record.runId;
  const attempt = record.attempt;
  runtime.inFlight.add(runId, controller);
  const context = {
    runId,
    attempt,
    envelope,
    signal: controller.signal,
    outputPath: runtime.store.outputPath(runId, "stdout"),
    writeStdout: (text) => runtime.store.appendOutput(runId, "stdout", text),
    writeStderr: (text) => runtime.store.appendOutput(runId, "stderr", text),
  };
  let settled = false;
  const finish = (state, extra) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    runtime.inFlight.remove(runId);
    finalize(runtime, runId, attempt, state, extra);
  };
  const timer = setTimeout(() => {
    finish("timed_out", { exitCode: 124, stopReason: "timeout" });
    controller.abort();
  }, envelope.timeoutMs);
  timer.unref?.();
  Promise.resolve()
    .then(() => runtime.execute(context))
    .then((result) => {
      if (controller.signal.aborted) return;
      const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : 0;
      finish(exitCode === 0 ? "completed" : "failed", {
        exitCode,
        stopReason: result?.stopReason ?? null,
        outputPath: result?.outputPath,
      });
    })
    .catch((error) => {
      if (controller.signal.aborted) return;
      finish("failed", { exitCode: 1, error: error instanceof Error ? error.message : String(error) });
    });
}

async function handlePostTask(runtime, req, res) {
  const body = await readBody(req, MAX_BODY_BYTES);
  if (!body.ok) {
    return sendJson(res, body.reason === "too_large" ? 413 : 400, { error: body.reason });
  }
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return sendJson(res, 400, { error: `invalid JSON: ${detail}` });
  }
  const validated = validateTaskRequest(parsed, { workspaceRoot: runtime.workspaceRoot });
  if (!validated.ok) return sendJson(res, 400, { error: validated.message });
  const envelope = validated.value;
  const existing = runtime.store.listRuns().find((run) => run.idempotencyKey === envelope.idempotencyKey);
  if (existing) {
    return sendJson(res, 200, { runId: existing.runId, attempt: existing.attempt, state: existing.state });
  }
  if (runtime.store.loadRun(envelope.runId)) {
    return sendJson(res, 409, { error: "runId already exists with a different idempotencyKey" });
  }
  if (runtime.inFlight.size() >= runtime.maxInFlight) {
    return sendJson(res, 503, { error: "worker is at capacity" }, { "retry-after": "1" });
  }
  const at = runtime.now();
  const created = runtime.store.saveRun({
    ...envelope,
    attempt: 0,
    state: "accepted",
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    outputPath: null,
    exitCode: null,
    stopReason: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
  });
  const claimed = runtime.store.claimAttempt(created.runId);
  startExecution(runtime, claimed, envelope);
  return sendJson(res, 202, { runId: claimed.runId, attempt: claimed.attempt, state: claimed.state });
}

function handleGetTask(runtime, res, runId) {
  if (!isValidRunId(runId)) return sendJson(res, 400, { error: "invalid runId" });
  const record = runtime.store.loadRun(runId);
  if (!record) return sendJson(res, 404, { error: "run not found" });
  return sendJson(res, 200, record);
}

function handleCancel(runtime, res, runId) {
  if (!isValidRunId(runId)) return sendJson(res, 400, { error: "invalid runId" });
  const record = runtime.store.loadRun(runId);
  if (!record) return sendJson(res, 404, { error: "run not found" });
  if (!isTerminalState(record.state)) {
    const controller = runtime.inFlight.get(runId);
    finalize(runtime, runId, record.attempt, "cancelled", { exitCode: 130, stopReason: "cancelled" });
    if (controller) controller.abort();
  }
  return sendJson(res, 200, runtime.store.loadRun(runId));
}

async function handle(runtime, req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz" && req.method === "GET") {
    return sendJson(res, 200, { status: "ok" });
  }
  if (url.pathname.startsWith("/v1")) {
    const decision = runtime.limiter.check(limiterKey(runtime, req));
    if (!decision.allowed) {
      return sendJson(
        res,
        429,
        { error: "rate limit exceeded" },
        { "retry-after": String(decision.retryAfterSeconds) },
      );
    }
  }
  const denied = authorize(runtime, req);
  if (denied) return sendJson(res, denied.status, denied.body);
  if (url.pathname === "/v1/tasks" && req.method === "POST") return handlePostTask(runtime, req, res);
  const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)(\/cancel)?$/);
  if (match && !match[2] && req.method === "GET") return handleGetTask(runtime, res, match[1]);
  if (match && match[2] === "/cancel" && req.method === "POST") return handleCancel(runtime, res, match[1]);
  return sendJson(res, 404, { error: "not found" });
}

export function createWorkerServer(options = {}) {
  const runtime = createRuntime(options);
  runtime.store.expireStaleLeases(runtime.now(), runtime.leaseMs);
  const server = createServer((req, res) => {
    handle(runtime, req, res).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[pstack worker] request failed: ${detail}\n`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "internal error" });
    });
  });
  server.on("close", () => {
    for (const controller of runtime.inFlight.drain()) controller.abort();
  });
  return server;
}

export function main() {
  const rawPort = Number.parseInt(process.env.PSTACK_WORKER_PORT ?? String(DEFAULT_PORT), 10);
  const port = Number.isFinite(rawPort) ? rawPort : DEFAULT_PORT;
  const token = process.env.PSTACK_WORKER_TOKEN ?? "";
  const maxInFlight = positiveInteger(Number.parseInt(process.env.PSTACK_WORKER_MAX_IN_FLIGHT ?? "", 10), DEFAULT_MAX_IN_FLIGHT);
  const rateLimit = rateLimitFromEnv(process.env, {
    maxRequests: "PSTACK_WORKER_RATE_LIMIT_MAX",
    windowMs: "PSTACK_WORKER_RATE_LIMIT_WINDOW_MS",
  });
  const server = createWorkerServer({ token, maxInFlight, rateLimit });
  if (!token) {
    process.stderr.write(
      "[pstack worker] PSTACK_WORKER_TOKEN is not set; /v1 routes return 503 until it is configured.\n",
    );
  }
  server.listen(port, () => {
    process.stdout.write(`[pstack worker] listening on port ${port}\n`);
  });
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
