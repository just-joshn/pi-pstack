/**
 * Benny event receiver. createBennyServer is the whole contract:
 * POST /v1/benny/events (Slack-shaped), POST /v1/hooks/:source (generic),
 * POST /v1/benny/test-event, GET /v1/benny/events, POST /v1/benny/events/:id/ack,
 * GET /healthz.
 *
 * Auth is fail-closed. With neither PSTACK_BENNY_SIGNING_SECRET nor
 * PSTACK_BENNY_TOKEN configured every non-health route returns 503 and nothing
 * runs. The Slack route verifies the v0 HMAC and the request timestamp when a
 * signing secret is set, and falls back to the bearer token otherwise. Reads and
 * acknowledgements require the bearer token.
 *
 * The body is untrusted. It is read as bytes, capped, JSON-parsed, and shape
 * checked before anything is persisted, and the bytes used for the HMAC are the
 * exact bytes read. Neither credential is ever echoed, logged, or stored.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  isPlainObject,
  loadConfig,
  normalizeSlackEvent,
  normalizeWebhookEvent,
} from "./routing.mjs";
import { createEventStore, isValidEventId } from "./store.mjs";

const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 256 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const SOURCE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const AUTH_UNCONFIGURED = "benny auth is not configured; refusing to accept events";

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text, "utf8"),
  });
  res.end(text);
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
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

function headerText(req, name) {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      resolve({ ok: false, reason: "body_too_large" });
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
        settle({ ok: false, reason: "body_too_large" });
        req.resume();
        return;
      }
      chunks = [...chunks, chunk];
    });
    req.on("end", () => settle({ ok: true, buffer: Buffer.concat(chunks) }));
    req.on("error", () => settle({ ok: false, reason: "body_read_error" }));
  });
}

function parseJsonBuffer(buffer) {
  try {
    return { ok: true, value: JSON.parse(buffer.toString("utf8")) };
  } catch {
    return { ok: false, message: "invalid JSON body" };
  }
}

/** Slack v0 signature over the exact bytes read, within a 300s clock window. */
function verifySlackSignature(runtime, req, rawBuffer) {
  if (!runtime.signingSecret) return false;
  const timestamp = headerText(req, "x-slack-request-timestamp");
  const signature = headerText(req, "x-slack-signature");
  if (timestamp === null || signature === null) return false;
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isInteger(seconds)) return false;
  const skew = Math.abs(Math.floor(runtime.now() / 1000) - seconds);
  if (skew > SIGNATURE_TOLERANCE_SECONDS) return false;
  const digest = createHmac("sha256", runtime.signingSecret)
    .update(`v0:${timestamp}:${rawBuffer.toString("utf8")}`)
    .digest("hex");
  return safeEqual(`v0=${digest}`, signature);
}

/** Inbound events accept a valid Slack signature or a valid bearer token. */
function authorizeInbound(runtime, req, rawBuffer) {
  if (runtime.signingSecret && verifySlackSignature(runtime, req, rawBuffer)) return null;
  const presented = bearerToken(req);
  if (runtime.token && presented !== null && safeEqual(presented, runtime.token)) return null;
  return { status: 401, body: { error: "invalid or missing credentials" } };
}

/** Reads and acknowledgements require the bearer token. */
function authorizeRead(runtime, req) {
  if (!runtime.token) {
    return { status: 401, body: { error: "PSTACK_BENNY_TOKEN is required for this route" } };
  }
  const presented = bearerToken(req);
  if (presented === null || !safeEqual(presented, runtime.token)) {
    return { status: 401, body: { error: "invalid or missing bearer token" } };
  }
  return null;
}

function ackBody(record) {
  return { eventId: record.eventId, state: record.state, intent: record.intent };
}

function deliverIfNeeded(runtime, record) {
  if (record.wakeAppendedAt) return record;
  return runtime.store.deliverEvent(record.eventId) ?? record;
}

/**
 * Persist first, then append the wake line. A failed append leaves the record
 * pending with wakeAppendedAt null, so a redelivery of the same source event
 * retries delivery instead of losing the event.
 */
function enqueue(runtime, res, record) {
  const existing = runtime.store.findDuplicate(record.sourceEventKey);
  if (existing) return sendJson(res, 200, ackBody(deliverIfNeeded(runtime, existing)));
  const at = new Date(runtime.now()).toISOString();
  const created = runtime.store.saveEvent({
    ...record,
    state: "pending",
    wakeAttempts: 0,
    wakeAppendedAt: null,
    lastWakeError: null,
    processedAt: null,
    result: null,
    createdAt: at,
    updatedAt: at,
  });
  return sendJson(res, 202, ackBody(deliverIfNeeded(runtime, created)));
}

function normalizeFor(kind, source, body, options) {
  if (kind === "slack") return normalizeSlackEvent(body, options);
  return normalizeWebhookEvent(source, body, options);
}

/** Slack's URL verification handshake, answered before any record is written. */
function urlVerificationChallenge(body) {
  if (!isPlainObject(body) || body.type !== "url_verification") return { kind: "absent" };
  if (typeof body.challenge !== "string" || body.challenge.length === 0) return { kind: "invalid" };
  return { kind: "challenge", value: body.challenge };
}

async function handleInbound(runtime, req, res, request) {
  const raw = await readRawBody(req, MAX_BODY_BYTES);
  if (!raw.ok) {
    return sendJson(res, raw.reason === "body_too_large" ? 413 : 400, { error: raw.reason });
  }
  const denied = authorizeInbound(runtime, req, raw.buffer);
  if (denied) return sendJson(res, denied.status, denied.body);
  const parsed = parseJsonBuffer(raw.buffer);
  if (!parsed.ok) return sendJson(res, 400, { error: parsed.message });
  const handshake = request.kind === "webhook" ? { kind: "absent" } : urlVerificationChallenge(parsed.value);
  if (handshake.kind === "invalid") {
    return sendJson(res, 400, { error: "url_verification requires a challenge" });
  }
  if (handshake.kind === "challenge") return sendJson(res, 200, { challenge: handshake.value });
  const options = { now: runtime.now, config: runtime.config };
  if (request.kind === "test") {
    const kind = isPlainObject(parsed.value?.event) ? "slack" : "webhook";
    const normalized = normalizeFor(kind, parsed.value?.source ?? "webhook", parsed.value, options);
    if (!normalized.ok) return sendJson(res, 400, { error: normalized.message });
    return sendJson(res, 200, { enqueued: false, record: normalized.value });
  }
  const normalized = normalizeFor(request.kind, request.source, parsed.value, options);
  if (!normalized.ok) return sendJson(res, 400, { error: normalized.message });
  return enqueue(runtime, res, normalized.value);
}

function handleList(runtime, res, url) {
  const state = url.searchParams.get("state") ?? undefined;
  let events;
  try {
    events = runtime.store.listEvents(state);
  } catch {
    return sendJson(res, 400, { error: "invalid state filter" });
  }
  return sendJson(res, 200, { state: state ?? null, count: events.length, events });
}

function handleAck(runtime, res, eventId) {
  if (!isValidEventId(eventId)) return sendJson(res, 400, { error: "invalid eventId" });
  const record = runtime.store.loadEvent(eventId);
  if (!record) return sendJson(res, 404, { error: "event not found" });
  const processed = runtime.store.markProcessed(eventId, {
    acknowledgedAt: new Date(runtime.now()).toISOString(),
  });
  return sendJson(res, 200, ackBody(processed));
}

function routeRequest(runtime, req, res, url) {
  if (url.pathname === "/healthz" && req.method === "GET") {
    return sendJson(res, 200, { status: "ok" });
  }
  if (!runtime.token && !runtime.signingSecret) {
    return sendJson(res, 503, { error: AUTH_UNCONFIGURED });
  }
  if (url.pathname === "/v1/benny/events" && req.method === "POST") {
    return handleInbound(runtime, req, res, { kind: "slack" });
  }
  if (url.pathname === "/v1/benny/test-event" && req.method === "POST") {
    return handleInbound(runtime, req, res, { kind: "test" });
  }
  if (url.pathname === "/v1/benny/events" && req.method === "GET") {
    const denied = authorizeRead(runtime, req);
    if (denied) return sendJson(res, denied.status, denied.body);
    return handleList(runtime, res, url);
  }
  const hook = url.pathname.match(/^\/v1\/hooks\/([^/]+)$/);
  if (hook && req.method === "POST") {
    if (!SOURCE_PATTERN.test(hook[1])) return sendJson(res, 400, { error: "invalid source slug" });
    return handleInbound(runtime, req, res, { kind: "webhook", source: hook[1] });
  }
  const ack = url.pathname.match(/^\/v1\/benny\/events\/([^/]+)\/ack$/);
  if (ack && req.method === "POST") {
    const denied = authorizeRead(runtime, req);
    if (denied) return sendJson(res, denied.status, denied.body);
    return handleAck(runtime, res, ack[1]);
  }
  return sendJson(res, 404, { error: "not found" });
}

function createRuntime(options) {
  const now = options.now ?? (() => Date.now());
  const store =
    options.store ??
    createEventStore({
      stateDir: options.stateDir,
      wakeFile: options.wakeFile,
      appendLine: options.appendLine,
      now,
    });
  const config = options.config ?? loadConfig({ dir: options.configDir }).config;
  return {
    now,
    store,
    config,
    token: options.token ?? process.env.PSTACK_BENNY_TOKEN ?? "",
    signingSecret: options.signingSecret ?? process.env.PSTACK_BENNY_SIGNING_SECRET ?? "",
  };
}

export function createBennyServer(options = {}) {
  const runtime = createRuntime(options);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    Promise.resolve()
      .then(() => routeRequest(runtime, req, res, url))
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[pstack benny] request failed: ${detail}\n`);
        if (res.headersSent) {
          res.end();
          return;
        }
        sendJson(res, 500, { error: "internal error" });
      });
  });
  server.on("close", () => {
    server.closeIdleConnections?.();
  });
  return server;
}

export function main() {
  const rawPort = Number.parseInt(process.env.PSTACK_BENNY_PORT ?? String(DEFAULT_PORT), 10);
  const port = Number.isFinite(rawPort) ? rawPort : DEFAULT_PORT;
  const server = createBennyServer({});
  if (!process.env.PSTACK_BENNY_TOKEN && !process.env.PSTACK_BENNY_SIGNING_SECRET) {
    process.stderr.write(
      "[pstack benny] neither PSTACK_BENNY_TOKEN nor PSTACK_BENNY_SIGNING_SECRET is set; non-health routes return 503.\n",
    );
  }
  server.listen(port, () => {
    process.stdout.write(`[pstack benny] listening on port ${port}\n`);
  });
  const stop = () => {
    server.close();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
