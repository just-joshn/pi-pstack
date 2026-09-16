/**
 * Shared primitives for the audit predicate harness: repo paths, temp-dir
 * lifecycle, subprocess execution, loopback HTTP, and a fake Pi host wrapper.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "../pi-host.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const SUBPROCESS_TIMEOUT_MS = 120_000;

export const READ_ONLY_POLICY = Object.freeze({
  filesystem: "read-only",
  shell: "full",
  git: "read",
  network: "allowed",
  integrations: "inherit",
  environment: "local",
  background: false,
  isolation: "session",
});

export function repoPath(...parts) {
  return join(REPO_ROOT, ...parts);
}

export function pass(detail) {
  return { status: "PASS", detail };
}

export function fail(detail) {
  return { status: "FAIL", detail };
}

export function skip(detail) {
  return { status: "SKIP", detail };
}

export function verdict(ok, okDetail, failDetail) {
  return ok ? pass(okDetail) : fail(failDetail);
}

export function errorText(err) {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Create a temp dir and remove it once `fn` settles, whatever the outcome. */
export async function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), `pstack-audit-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Create a temp dir at an exact name under the OS temp root; caller-scoped cleanup. */
export async function withNamedTempDir(name, fn) {
  const dir = join(tmpdir(), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function collectStream(stream, onChunk) {
  stream.setEncoding("utf8");
  stream.on("data", onChunk);
}

/**
 * Run a command with no shell, capped at SUBPROCESS_TIMEOUT_MS. Resolves with
 * the exit code, the captured streams, and whether the timeout fired.
 */
export function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    collectStream(child.stdout, (chunk) => {
      stdout = stdout + chunk;
    });
    collectStream(child.stderr, (chunk) => {
      stderr = stderr + chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

export function runNode(args, options = {}) {
  return runProcess(process.execPath, args, options);
}

/** Listen on an ephemeral loopback port and always close the server afterwards. */
export async function withServer(server, fn) {
  const port = await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise(server.address().port));
  });
  try {
    return await fn(port);
  } finally {
    await new Promise((resolvePromise) => {
      server.closeAllConnections?.();
      server.close(() => resolvePromise(undefined));
    });
  }
}

export async function requestJson(port, path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/** Register an extension entry against the recording fake Pi host. */
export function hostFor(entry, cwd = REPO_ROOT) {
  return createHost(cwd, { entry });
}

export async function importExtension(relativePath) {
  return await import(repoPath(relativePath));
}

/** Swap globalThis.fetch for a recording stub and always restore it. */
export async function withStubbedFetch(handler, fn) {
  const original = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (input, init) => {
    calls = [...calls, { url: String(input), method: init?.method }];
    return handler(String(input));
  };
  try {
    return await fn(() => [...calls]);
  } finally {
    globalThis.fetch = original;
  }
}

export function okResponse(body = "stub") {
  return { status: 200, ok: true, text: async () => body };
}
