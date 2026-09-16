/**
 * SEC-11..SEC-14: hosted service hardening. Each predicate starts the real
 * server on an ephemeral loopback port, drives it over HTTP, and shuts it down.
 */
import { join } from "node:path";
import {
  fail,
  importExtension,
  pass,
  requestJson,
  verdict,
  withServer,
  withTempDir,
} from "./harness.mjs";

const TOKEN = "audit-harness-token";
const BURST = 200;
const WAVE = 20;
const IN_FLIGHT_PROBES = 8;
const LEAK_SENTINEL = "SENTINEL-LEAK-/private/secret/path";

function basePolicy() {
  return {
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "none",
    environment: "hosted",
    background: false,
    isolation: "remote",
  };
}

function taskBody(suffix, extra = {}) {
  return {
    runId: `audit-${suffix}`,
    idempotencyKey: `audit-key-${suffix}`,
    task: "audit predicate probe",
    role: "general",
    model: "inherit-parent",
    policy: basePolicy(),
    timeoutMs: 60_000,
    ...extra,
  };
}

async function importServers() {
  const worker = await import(new URL("../../../services/worker/server.mjs", import.meta.url));
  const benny = await import(new URL("../../../services/benny/server.mjs", import.meta.url));
  return { worker, benny };
}

async function safeRequest(port, path, options) {
  try {
    const response = await requestJson(port, path, options);
    return response.status;
  } catch {
    return 0;
  }
}

/** Waves keep the client socket pool inside its limits; the server still sees 200 rapid requests. */
async function burst(port, path, options) {
  const waves = Array.from({ length: BURST / WAVE }, (_unused, index) => index);
  return await waves.reduce(async (accPromise, _wave) => {
    const acc = await accPromise;
    const batch = await Promise.all(
      Array.from({ length: WAVE }, () => safeRequest(port, path, options)),
    );
    return [...acc, ...batch];
  }, Promise.resolve([]));
}

async function bennyRateLimit(createBennyServer, dir) {
  const server = createBennyServer({
    token: TOKEN,
    stateDir: join(dir, "benny-state"),
    wakeFile: join(dir, "wake.jsonl"),
  });
  return await withServer(server, async (port) => {
    const statuses = await burst(port, "/v1/benny/events", { token: TOKEN });
    return { throttled: statuses.filter((status) => status === 429).length, errors: statuses.filter((s) => s === 0).length };
  });
}

async function workerRateLimit(createWorkerServer, dir) {
  const server = createWorkerServer({
    token: TOKEN,
    stateDir: join(dir, "worker-state"),
    execute: async () => ({ exitCode: 0 }),
  });
  return await withServer(server, async (port) => {
    const statuses = await burst(port, "/v1/tasks/missing-run", { token: TOKEN });
    return { throttled: statuses.filter((status) => status === 429).length, errors: statuses.filter((s) => s === 0).length };
  });
}

async function secRateLimiting() {
  const { worker, benny } = await importServers();
  return await withTempDir("ratelimit", async (dir) => {
    const bennyResult = await bennyRateLimit(benny.createBennyServer, dir);
    const workerResult = await workerRateLimit(worker.createWorkerServer, dir);
    const missing = [
      ...(bennyResult.throttled === 0 ? ["services/benny/server.mjs"] : []),
      ...(workerResult.throttled === 0 ? ["services/worker/server.mjs"] : []),
    ];
    const transport = `transport errors benny ${bennyResult.errors}, worker ${workerResult.errors}`;
    return verdict(
      missing.length === 0,
      `both services throttled a ${BURST}-request burst (benny ${bennyResult.throttled} x429, worker ${workerResult.throttled} x429; ${transport})`,
      `no per-client request cap in ${missing.join(" and ")}: ${BURST} authenticated /v1 requests produced zero 429 responses (${transport})`,
    );
  });
}

/** `now` throws once the server is live, so the failure surfaces inside the request handler. */
function makeLeakingClock() {
  let armed = false;
  const clock = () => {
    if (armed) throw new Error(`state write failed at ${LEAK_SENTINEL}`);
    return Date.now();
  };
  return { clock, arm: () => { armed = true; } };
}

async function secErrorDoesNotLeak() {
  const { worker } = await importServers();
  const { clock, arm } = makeLeakingClock();
  return await withTempDir("leak", async (dir) => {
    const server = worker.createWorkerServer({
      token: TOKEN,
      stateDir: join(dir, "state"),
      now: clock,
      execute: async () => ({ exitCode: 0 }),
    });
    return await withServer(server, async (port) => {
      arm();
      const response = await requestJson(port, "/v1/tasks", {
        method: "POST",
        token: TOKEN,
        body: taskBody("leak"),
      });
      if (response.status !== 500) {
        return fail(`expected a 500 from the failing handler, got ${response.status}: ${response.text.slice(0, 200)}`);
      }
      return verdict(
        !response.text.includes(LEAK_SENTINEL),
        "the 500 body carries an opaque error and no internal detail",
        `the 500 body echoes the raw handler error, leaking ${LEAK_SENTINEL}: ${response.text.slice(0, 200)}`,
      );
    });
  });
}

async function secParentOwnershipCwd() {
  const { worker } = await importServers();
  return await withTempDir("ownership", async (dir) => {
    const server = worker.createWorkerServer({
      token: TOKEN,
      stateDir: join(dir, "state"),
      execute: async () => ({ exitCode: 0 }),
    });
    return await withServer(server, async (port) => {
      const response = await requestJson(port, "/v1/tasks", {
        method: "POST",
        token: TOKEN,
        body: taskBody("ownership", { parentOwnership: { cwd: "/etc" } }),
      });
      return verdict(
        response.status === 400,
        "parentOwnership.cwd '/etc' is rejected with 400",
        `parentOwnership.cwd '/etc' was accepted with ${response.status}: ${response.text.slice(0, 200)}`,
      );
    });
  });
}

function hangingExecutor() {
  return (context) =>
    new Promise((resolvePromise) => {
      context.signal.addEventListener("abort", () => resolvePromise({ exitCode: 130 }), { once: true });
    });
}

async function secInFlightCap() {
  const { worker } = await importServers();
  return await withTempDir("inflight", async (dir) => {
    const server = worker.createWorkerServer({
      token: TOKEN,
      stateDir: join(dir, "state"),
      maxInFlight: 2,
      execute: hangingExecutor(),
    });
    return await withServer(server, async (port) => {
      const results = await Promise.all(
        Array.from({ length: IN_FLIGHT_PROBES }, (_unused, index) =>
          requestJson(port, "/v1/tasks", {
            method: "POST",
            token: TOKEN,
            body: taskBody(`inflight-${index}`),
          }),
        ),
      );
      const codes = results.map((result) => result.status);
      const rejected = codes.filter((status) => status === 429 || status === 503).length;
      return verdict(
        rejected > 0,
        `the configured max-in-flight rejected ${rejected}/${IN_FLIGHT_PROBES} tasks past the cap`,
        `maxInFlight:2 was ignored; all ${IN_FLIGHT_PROBES} concurrent tasks were accepted (${codes.join(",")})`,
      );
    });
  });
}

export const SEC_SERVICE_PREDICATES = Object.freeze([
  {
    id: "SEC-11",
    description: "benny and worker enforce a per-client request cap on /v1 routes",
    run: secRateLimiting,
  },
  {
    id: "SEC-12",
    description: "a worker 500 response does not echo internal error detail",
    run: secErrorDoesNotLeak,
  },
  {
    id: "SEC-13",
    description: "the worker rejects parentOwnership.cwd outside its own workspace with 400",
    run: secParentOwnershipCwd,
  },
  {
    id: "SEC-14",
    description: "the worker caps concurrent in-flight tasks and rejects past the cap",
    run: secInFlightCap,
  },
]);
