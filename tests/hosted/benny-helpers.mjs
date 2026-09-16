/**
 * Shared helpers for the benny receiver tests. Every helper boots a real
 * http.Server on an ephemeral port over a temp state dir and a temp config dir,
 * so the tests exercise the wire protocol rather than an in-process shortcut.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBennyServer } from "../../services/benny/server.mjs";
import { defaultConfig } from "../../services/benny/routing.mjs";
import { createEventStore } from "../../services/benny/store.mjs";

export const TEST_TOKEN = "test-benny-token";
export const TEST_SIGNING_SECRET = "test-benny-signing-secret";

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanupDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export async function startBenny(options) {
  const server = createBennyServer(options);
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
    ...(options.headers ?? {}),
  };
  const encoded = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const response = await fetch(`${base}${path}`, { method, headers, body: encoded, redirect: "manual" });
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

export function slackBody(overrides = {}) {
  const suffix = Math.random().toString(36).slice(2, 10);
  const { event: eventOverrides, ...topLevel } = overrides;
  return {
    type: "event_callback",
    event_id: `Ev${suffix}`,
    ...topLevel,
    event: {
      type: "message",
      channel: "C_SOURCE",
      ts: "1700000000.000100",
      text: "checkout button crashes on submit",
      user: "U_REPORTER",
      ...(eventOverrides ?? {}),
    },
  };
}

export function slackSignature(secret, timestamp, rawBody) {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return `v0=${digest}`;
}

export function signedHeaders(secret, rawBody, at = Date.now()) {
  const timestamp = String(Math.floor(at / 1000));
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": slackSignature(secret, timestamp, rawBody),
  };
}

export function readWakeLines(wakeFile) {
  const text = readFileSync(wakeFile, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function configFixture(dir, extra = {}) {
  const path = join(dir, "benny.json");
  writeFileSync(path, `${JSON.stringify({ ...defaultConfig(), ...extra }, null, 2)}\n`, "utf8");
  return path;
}

export function storeFor(stateDir, wakeFile, extra = {}) {
  return createEventStore({ stateDir, wakeFile, ...extra });
}
