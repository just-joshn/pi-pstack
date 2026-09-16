/**
 * Shared helpers for the hosted worker tests. Every helper boots a real
 * http.Server on an ephemeral port over a temp state dir, so the tests exercise
 * the wire protocol rather than an in-process shortcut.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerServer } from "../../services/worker/server.mjs";

export const TEST_TOKEN = "test-worker-token";

export function tempStateDir() {
  return mkdtempSync(join(tmpdir(), "pstack-worker-test-"));
}

export function cleanupStateDir(stateDir) {
  rmSync(stateDir, { recursive: true, force: true });
}

export async function startWorker(options) {
  const server = createWorkerServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function request(base, path, options = {}) {
  const method = options.method ?? "GET";
  const body = options.body;
  const headers = {
    accept: "application/json",
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
  };
  const encoded = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const response = await fetch(`${base}${path}`, { method, headers, body: encoded });
  const text = await response.text();
  return { status: response.status, text, json: parseJson(text) };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function makeEnvelope(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return {
    runId: `run-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    parentOwnership: { sessionId: "session-test", cwd: process.cwd() },
    parentSessionCwd: process.cwd(),
    upstreamRevision: "test-rev",
    pluginVersion: "test-plugin",
    task: "test task",
    role: "general",
    model: "test/model",
    thinkingLevel: null,
    policy: {
      filesystem: "workspace-write",
      shell: "full",
      git: "branch-write",
      network: "allowed",
      integrations: "inherit",
      environment: "hosted",
      background: false,
      isolation: "remote",
    },
    capabilities: [],
    secretRefs: [],
    isolation: "remote",
    timeoutMs: 5000,
    reportSchema: null,
    ...overrides,
  };
}

export async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function waitForState(worker, runId, token, state, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request(worker.base, `/v1/tasks/${runId}`, { token });
    if (response.status === 200 && response.json?.state === state) return response.json;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} did not reach ${state}; last=${response.status} ${response.text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
