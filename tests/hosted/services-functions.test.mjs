import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolvePiInvocation } from "../../services/worker/executor.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  validateTaskRequest,
} from "../../services/worker/protocol.mjs";
import {
  DEFAULT_MAX_REQUESTS,
  DEFAULT_WINDOW_MS,
  clientKeyOf,
  createRateLimiter,
  rateLimitFromEnv,
} from "../../services/worker/rate-limit.mjs";
import {
  RUN_STATES,
  createRunStore,
  defaultStateDir as workerDefaultStateDir,
  isTerminalState,
  isValidRunId,
} from "../../services/worker/store.mjs";
import { main as workerMain } from "../../services/worker/server.mjs";
import {
  INTENTS,
  configPathOf,
  defaultConfig,
  defaultConfigDir,
  isValidChannel,
  isValidIntent,
  loadConfig,
  normalizeSlackEvent,
  normalizeWebhookEvent,
  resolveIntent,
  sourceEventKeyOf,
  validateConfig,
  writeConfig,
} from "../../services/benny/routing.mjs";
import {
  createEventStore,
  defaultStateDir as bennyDefaultStateDir,
  defaultWakeFile,
  eventIdForKey,
  isWakeDelivered,
  isValidEventId,
  randomEventId,
  wakeLineFor,
} from "../../services/benny/store.mjs";
import { main as bennyMain } from "../../services/benny/server.mjs";
import {
  TEST_TOKEN,
  cleanupStateDir,
  makeEnvelope,
  request,
  startWorker,
  tempStateDir,
} from "./helpers.mjs";
import { cleanupDir, tempDir } from "./benny-helpers.mjs";

function restoreEnv(name, value) {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function runRecord(runId, overrides = {}) {
  return {
    runId,
    idempotencyKey: `idem-${runId}`,
    state: "accepted",
    attempt: 0,
    task: "task",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function eventRecord(eventId, overrides = {}) {
  return {
    eventId,
    source: "slack",
    sourceEventKey: null,
    state: "pending",
    receivedAt: "2026-01-01T00:00:00.000Z",
    wakeAttempts: 0,
    wakeAppendedAt: null,
    lastWakeError: null,
    ...overrides,
  };
}

test("resolvePiInvocation picks the override, the pi entry, or the PATH fallback", () => {
  expect(resolvePiInvocation({ PSTACK_WORKER_PI_BIN: "  /opt/pi  " }, ["node", "/app/server.mjs"])).toEqual({
    command: "/opt/pi",
    args: [],
  });
  expect(resolvePiInvocation({}, ["node", "/usr/local/bin/pi"])).toEqual({
    command: process.execPath,
    args: ["/usr/local/bin/pi"],
  });
  expect(resolvePiInvocation({}, ["bun", "/$bunfs/root/pi"])).toEqual({ command: "pi", args: [] });
  expect(resolvePiInvocation({}, ["node", "/app/server.mjs"])).toEqual({ command: "pi", args: [] });
  expect(resolvePiInvocation({}, [])).toEqual({ command: "pi", args: [] });
});
test("the worker rejects a body past the declared cap with 413", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
  expect(response.status).toBe(413);
  expect(response.json).toEqual({ error: "too_large" });
});
test("the worker records a streamed stderr line on the run", async (t) => {
  const stateDir = tempStateDir();
  const executor = async (context) => {
    context.writeStdout("o");
    context.writeStderr("e");
    return { exitCode: 0 };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.onTestFinished(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ runId: "run-stderr", idempotencyKey: "key-stderr" });
  const posted = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  expect(posted.status).toBe(202);
  const deadline = Date.now() + 3000;
  let record;
  while (record?.state !== "completed" && Date.now() < deadline) {
    const polled = await request(worker.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
    record = polled.json;
    if (record?.state !== "completed") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(record.stdout).toBe("o");
  expect(record.stderr).toBe("e");
  expect(record.stderrBytes).toBe(1);
});
test("worker main listens on the env port and serves healthz", async () => {
  const stateDir = tempStateDir();
  const saved = [process.env.PSTACK_WORKER_PORT, process.env.PSTACK_WORKER_TOKEN, process.env.PSTACK_WORKER_STATE_DIR];
  process.env.PSTACK_WORKER_PORT = "0";
  process.env.PSTACK_WORKER_TOKEN = "main-token";
  process.env.PSTACK_WORKER_STATE_DIR = stateDir;
  let server;
  try {
    server = workerMain();
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await request(`http://127.0.0.1:${server.address().port}`, "/healthz");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: "ok" });
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    restoreEnv("PSTACK_WORKER_PORT", saved[0]);
    restoreEnv("PSTACK_WORKER_TOKEN", saved[1]);
    restoreEnv("PSTACK_WORKER_STATE_DIR", saved[2]);
    cleanupStateDir(stateDir);
  }
});
test("clientKeyOf derives the bucket from the peer address and a credential hash", () => {
  const req = { socket: { remoteAddress: "10.0.0.9" } };
  expect(clientKeyOf(req, "test-worker-token")).toBe("10.0.0.9|3db19f57f0d31e2e");
  expect(clientKeyOf(req, "tok")).toBe("10.0.0.9|1a7674eb4ee78df7");
  expect(clientKeyOf(req, "")).toBe("10.0.0.9|2f183a4e64493af3");
  expect(clientKeyOf({}, undefined)).toBe("unknown|2f183a4e64493af3");
});
test("createRateLimiter defaults the window and cap and reports its size", () => {
  const limiter = createRateLimiter();
  expect(limiter.windowMs).toBe(DEFAULT_WINDOW_MS);
  expect(limiter.maxRequests).toBe(DEFAULT_MAX_REQUESTS);
  expect(limiter.size()).toBe(0);
  expect(limiter.check("k")).toEqual({ allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0 });
  expect(limiter.size()).toBe(1);
});
test("createRateLimiter denies past the cap with retryAfter and resets at the window end", () => {
  let at = 1000;
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 10_000, now: () => at });
  expect(limiter.check("k")).toEqual({ allowed: true, limit: 2, remaining: 1, retryAfterSeconds: 0 });
  expect(limiter.check("k")).toEqual({ allowed: true, limit: 2, remaining: 0, retryAfterSeconds: 0 });
  expect(limiter.check("k")).toEqual({ allowed: false, limit: 2, remaining: 0, retryAfterSeconds: 10 });
  at = 11_000;
  expect(limiter.check("k")).toEqual({ allowed: true, limit: 2, remaining: 1, retryAfterSeconds: 0 });
});
test("rateLimitFromEnv reads the named variables and falls back on garbage", () => {
  const names = { maxRequests: "M", windowMs: "W" };
  expect(rateLimitFromEnv({ M: "5", W: "1000" }, names)).toEqual({ maxRequests: 5, windowMs: 1000 });
  expect(rateLimitFromEnv({}, names)).toEqual({ maxRequests: 120, windowMs: 60000 });
  expect(rateLimitFromEnv({ M: "abc", W: "-3" }, names)).toEqual({ maxRequests: 120, windowMs: 60000 });
});
test("defaultStateDir prefers the env override over the home default", () => {
  const saved = process.env.PSTACK_WORKER_STATE_DIR;
  try {
    process.env.PSTACK_WORKER_STATE_DIR = "/tmp/worker-state";
    expect(workerDefaultStateDir()).toBe("/tmp/worker-state");
    Reflect.deleteProperty(process.env, "PSTACK_WORKER_STATE_DIR");
    expect(workerDefaultStateDir()).toBe(join(homedir(), ".pi", "agent", "pstack", "hosted"));
  } finally {
    restoreEnv("PSTACK_WORKER_STATE_DIR", saved);
  }
});
test("isValidRunId and isTerminalState classify ids and states", () => {
  expect(isValidRunId("run-1.a_b")).toBe(true);
  expect(isValidRunId("..")).toBe(false);
  expect(isValidRunId(".")).toBe(false);
  expect(isValidRunId("a..b")).toBe(false);
  expect(isValidRunId("x".repeat(65))).toBe(false);
  expect(isValidRunId(7)).toBe(false);
  for (const state of RUN_STATES) {
    expect(isTerminalState(state)).toBe(state !== "accepted" && state !== "running");
  }
});
test("runs round-trip through saveRun, loadRun, listRuns, and deleteRun", () => {
  const dir = tempStateDir();
  try {
    const store = createRunStore({ stateDir: dir });
    store.saveRun(runRecord("run-b", { createdAt: 2 }));
    store.saveRun(runRecord("run-a", { createdAt: 1 }));
    expect(store.listRuns().map((entry) => entry.runId)).toEqual(["run-a", "run-b"]);
    expect(store.loadRun("run-a").idempotencyKey).toBe("idem-run-a");
    expect(store.loadRun("missing")).toBe(null);
    expect(store.deleteRun("run-a")).toBe(true);
    expect(store.deleteRun("run-a")).toBe(false);
    expect(store.listRuns().map((entry) => entry.runId)).toEqual(["run-b"]);
    expect(store.runPath("run-b")).toBe(join(dir, "runs", "run-b.json"));
    expect(() => store.runPath("../escape")).toThrow(/invalid runId/);
    expect(store.outputPath("run-b", "stdout")).toBe(join(dir, "output", "run-b.stdout.log"));
    expect(() => store.outputPath("run-b", "bogus")).toThrow(/unknown output stream/);
    expect(store.appendOutput("run-out", "stdout", "héllo")).toBe(6);
    expect(store.appendOutput("run-out", "stderr", "")).toBe(0);
    expect(store.readOutput("run-out", "stdout")).toBe("héllo");
    expect(store.readOutput("run-out", "stderr")).toBe("");
  } finally {
    cleanupStateDir(dir);
  }
});
test("claimAttempt increments the attempt and stamps the lease", () => {
  const dir = tempStateDir();
  try {
    let now = 100;
    const store = createRunStore({ stateDir: dir, now: () => now, leaseMs: 500 });
    store.saveRun(runRecord("run-claim"));
    const claimed = store.claimAttempt("run-claim");
    expect(claimed.attempt).toBe(1);
    expect(claimed.state).toBe("running");
    expect(claimed.startedAt).toBe(100);
    expect(claimed.leaseExpiresAt).toBe(600);
    now = 200;
    expect(store.claimAttempt("run-claim").attempt).toBe(2);
    expect(() => store.claimAttempt("run-missing")).toThrow(/cannot claim an attempt for unknown run: run-missing/);
  } finally {
    cleanupStateDir(dir);
  }
});
test("expireStaleLeases marks a lapsed run dead and leaves fresh and terminal runs alone", () => {
  const dir = tempStateDir();
  try {
    const store = createRunStore({ stateDir: dir, now: () => 0, leaseMs: 100 });
    store.saveRun(runRecord("run-stale", { state: "running", attempt: 1, updatedAt: 10 }));
    store.appendOutput("run-stale", "stdout", "partial");
    store.saveRun(runRecord("run-fresh", { state: "running", attempt: 1, updatedAt: 950 }));
    store.saveRun(runRecord("run-terminal", { state: "completed", updatedAt: 10 }));
    const expired = store.expireStaleLeases(1000, 100);
    expect(expired.map((entry) => entry.runId)).toEqual(["run-stale"]);
    const dead = store.loadRun("run-stale");
    expect(dead.state).toBe("dead");
    expect(dead.stdout).toBe("partial");
    expect(dead.stopReason).toBe("lease_expired");
    expect(dead.finishedAt).toBe(1000);
    expect(dead.leaseExpiresAt).toBe(null);
    expect(store.loadRun("run-fresh").state).toBe("running");
    expect(store.loadRun("run-terminal").state).toBe("completed");
  } finally {
    cleanupStateDir(dir);
  }
});
test("a corrupt run record throws with its path and saveRun requires a valid runId", () => {
  const dir = tempStateDir();
  try {
    const store = createRunStore({ stateDir: dir });
    mkdirSync(store.runsDir, { recursive: true });
    writeFileSync(join(store.runsDir, "bad-run.json"), "{not json", "utf8");
    expect(() => store.loadRun("bad-run")).toThrow(/corrupt run record at .*bad-run\.json/);
    expect(() => store.saveRun({})).toThrow(/saveRun requires a valid runId/);
  } finally {
    cleanupStateDir(dir);
  }
});
test("validateTaskRequest normalizes a valid envelope against the workspace root", () => {
  const result = validateTaskRequest(makeEnvelope({ runId: "run-ok", idempotencyKey: "key-ok" }));
  expect(result.ok).toBe(true);
  expect(result.value.runId).toBe("run-ok");
  expect(result.value.idempotencyKey).toBe("key-ok");
  expect(result.value.parentOwnership.cwd).toBe(realpathSync(process.cwd()));
  expect(result.value.parentSessionCwd).toBe(realpathSync(process.cwd()));
  expect(result.value.upstreamRevision).toBe("test-rev");
  expect(result.value.pluginVersion).toBe("test-plugin");
  expect(result.value.task).toBe("test task");
  expect(result.value.role).toBe("general");
  expect(result.value.thinkingLevel).toBe(null);
  expect(result.value.capabilities).toEqual([]);
  expect(result.value.secretRefs).toEqual([]);
  expect(result.value.isolation).toBe("remote");
  expect(result.value.timeoutMs).toBe(5000);
  expect(result.value.reportSchema).toBe(null);
  expect(result.value.policy.background).toBe(false);
});
test("validateTaskRequest rejects unknown fields and malformed identity", () => {
  const cases = [
    ["x", /request body must be a JSON object/],
    [{ ...makeEnvelope(), extra: 1 }, /unknown field\(s\): extra/],
    [makeEnvelope({ runId: "bad id" }), /runId must match/],
    [makeEnvelope({ idempotencyKey: "" }), /idempotencyKey must be a non-empty string/],
    [makeEnvelope({ idempotencyKey: "k".repeat(201) }), /idempotencyKey must be a non-empty string/],
    [makeEnvelope({ task: "" }), /task must be a non-empty string/],
    [makeEnvelope({ role: "" }), /role must be a non-empty string/],
    [makeEnvelope({ model: "bad model" }), /model must be a provider/],
  ];
  for (const [body, pattern] of cases) {
    const result = validateTaskRequest(body);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(pattern);
  }
});
test("validateTaskRequest requires the eight policy axes and valid enum values", () => {
  const missing = validateTaskRequest(makeEnvelope({ policy: { filesystem: "read-only" } }));
  expect(missing.ok).toBe(false);
  expect(missing.message).toBe("policy is missing axes: background, environment, git, integrations, isolation, network, shell");
  const base = makeEnvelope();
  const badShell = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, shell: "sometimes" } }));
  expect(badShell.message).toBe("policy.shell must be one of none, restricted, full");
  const badBackground = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, background: "yes" } }));
  expect(badBackground.message).toBe("policy.background must be a boolean");
  const nonObject = validateTaskRequest(makeEnvelope({ policy: "nope" }));
  expect(nonObject.message).toBe("policy must be an object with the eight axes");
});
test("validateTaskRequest accepts an integrations array and rejects a bad entry or type", () => {
  const base = makeEnvelope();
  const accepted = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, integrations: ["source-control", "team-chat"] } }));
  expect(accepted.ok).toBe(true);
  expect(accepted.value.policy.integrations).toEqual(["source-control", "team-chat"]);
  const emptyEntry = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, integrations: [""] } }));
  expect(emptyEntry.message).toBe("policy.integrations must be none, inherit, or an array of capability names");
  const badType = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, integrations: 5 } }));
  expect(badType.message).toBe("policy.integrations must be none, inherit, or an array of capability names");
});
test("validateTaskRequest validates capabilities, secretRefs, timeout, isolation, and thinkingLevel", () => {
  expect(validateTaskRequest(makeEnvelope({ capabilities: ["ok", 1] })).message).toBe("capabilities must be an array of strings");
  expect(validateTaskRequest(makeEnvelope({ secretRefs: [1] })).message).toBe("secretRefs must be an array of strings");
  expect(validateTaskRequest(makeEnvelope({ timeoutMs: 999 })).message).toBe(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  expect(validateTaskRequest(makeEnvelope({ timeoutMs: MAX_TIMEOUT_MS + 1 })).ok).toBe(false);
  expect(validateTaskRequest(makeEnvelope({ timeoutMs: null })).value.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  expect(validateTaskRequest(makeEnvelope({ isolation: "moon" })).message).toMatch(/isolation must be one of session, process, worktree/);
  expect(validateTaskRequest(makeEnvelope({ thinkingLevel: 5 })).message).toBe("thinkingLevel must be a string or null");
  expect(validateTaskRequest(makeEnvelope({ thinkingLevel: "high" })).value.thinkingLevel).toBe("high");
});
test("validateTaskRequest resolves the legacy parentSessionCwd alias and rejects a bad sessionId", () => {
  const alias = validateTaskRequest(makeEnvelope({ parentOwnership: undefined, parentSessionCwd: process.cwd() }));
  expect(alias.ok).toBe(true);
  expect(alias.value.parentSessionCwd).toBe(realpathSync(process.cwd()));
  const badSession = validateTaskRequest(makeEnvelope({ parentOwnership: { sessionId: 5, cwd: process.cwd() } }));
  expect(badSession.message).toBe("parentOwnership.sessionId must be a string");
  const badObject = validateTaskRequest(makeEnvelope({ parentOwnership: "x" }));
  expect(badObject.message).toBe("parentOwnership must be an object");
});
test("validateTaskRequest rejects a missing cwd, an outside cwd, and a missing workspace root", () => {
  const root = tempStateDir();
  const other = tempStateDir();
  try {
    const missing = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: join(root, "nope") } }),
      { workspaceRoot: root },
    );
    expect(missing.message).toBe("parentOwnership.cwd must be an existing directory inside the workspace root");
    const outside = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: other } }),
      { workspaceRoot: root },
    );
    expect(outside.message).toBe("parentOwnership.cwd must stay inside the worker workspace root");
    const badRoot = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: root } }),
      { workspaceRoot: join(root, "absent") },
    );
    expect(badRoot.message).toBe("the worker workspace root is not an accessible directory");
    const ok = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: root } }),
      { workspaceRoot: root },
    );
    expect(ok.value.parentOwnership.cwd).toBe(realpathSync(root));
  } finally {
    cleanupStateDir(root);
    cleanupStateDir(other);
  }
});
test("validateTaskRequest defaults upstreamRevision and pluginVersion to unknown", () => {
  const envelope = { ...makeEnvelope() };
  Reflect.deleteProperty(envelope, "upstreamRevision");
  Reflect.deleteProperty(envelope, "pluginVersion");
  const result = validateTaskRequest(envelope);
  expect(result.value.upstreamRevision).toBe("unknown");
  expect(result.value.pluginVersion).toBe("unknown");
});
test("defaultConfigDir and configPathOf resolve from the env override", () => {
  const saved = process.env.PSTACK_BENNY_CONFIG_DIR;
  try {
    process.env.PSTACK_BENNY_CONFIG_DIR = "/tmp/benny-cfg";
    expect(defaultConfigDir()).toBe("/tmp/benny-cfg");
    expect(configPathOf()).toBe("/tmp/benny-cfg/benny.json");
    Reflect.deleteProperty(process.env, "PSTACK_BENNY_CONFIG_DIR");
    expect(defaultConfigDir()).toBe(join(homedir(), ".pi", "agent"));
  } finally {
    restoreEnv("PSTACK_BENNY_CONFIG_DIR", saved);
  }
});
test("validateConfig rejects malformed routes and returns the config unchanged", () => {
  expect(() => validateConfig(null)).toThrow(/benny config must be a JSON object/);
  expect(() => validateConfig({ routes: {} })).toThrow(/benny config routes must be an array/);
  expect(() => validateConfig({ routes: [1] })).toThrow(/benny config route 0 must be an object/);
  expect(() => validateConfig({ routes: [{ channel: "", intent: "triage" }] })).toThrow(/benny config route 0 needs a channel string/);
  expect(() => validateConfig({ routes: [{ channel: "c", intent: "nope" }] })).toThrow(/benny config route 0 intent must be one of triage, repro, ignore/);
  expect(() => validateConfig({ defaultIntent: "nope" })).toThrow(/benny config defaultIntent must be one of/);
  const valid = { routes: [{ channel: "c", intent: "repro" }], defaultIntent: "ignore" };
  expect(validateConfig(valid)).toBe(valid);
});
test("loadConfig returns the default when missing and throws on invalid JSON", () => {
  const dir = tempDir("pstack-benny-config-");
  try {
    const missing = loadConfig({ dir });
    expect(missing.exists).toBe(false);
    expect(missing.path).toBe(join(dir, "benny.json"));
    expect(missing.config).toEqual({ routes: [], defaultIntent: "triage" });
    writeFileSync(join(dir, "benny.json"), "{oops", "utf8");
    expect(() => loadConfig({ dir })).toThrow(/is not valid JSON/);
  } finally {
    cleanupDir(dir);
  }
});
test("writeConfig merges owned keys and preserves unknown user keys", () => {
  const dir = tempDir("pstack-benny-write-");
  try {
    const path = join(dir, "benny.json");
    writeFileSync(
      path,
      JSON.stringify({
        routes: [{ channel: "C", intent: "triage" }],
        defaultIntent: "triage",
        owner: "me",
        note: "keep",
      }),
      "utf8",
    );
    const merged = writeConfig({ routes: [{ channel: "C", intent: "repro" }] }, { dir });
    expect(merged).toEqual({
      routes: [{ channel: "C", intent: "repro" }],
      defaultIntent: "triage",
      owner: "me",
      note: "keep",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(merged);
    expect(() => writeConfig({ defaultIntent: "nope" }, { dir })).toThrow(/benny config defaultIntent must be one of/);
  } finally {
    cleanupDir(dir);
  }
});
test("resolveIntent prefers a channel route, then the default, then triage", () => {
  const config = { routes: [{ channel: "C_SOURCE", intent: "repro" }], defaultIntent: "ignore" };
  expect(resolveIntent(config, "C_SOURCE")).toBe("repro");
  expect(resolveIntent(config, "OTHER")).toBe("ignore");
  expect(resolveIntent({}, "OTHER")).toBe("triage");
  expect(resolveIntent({ routes: [{ channel: "C", intent: "nope" }] }, "C")).toBe("triage");
});
test("sourceEventKeyOf hashes the source event id and rejects an empty id", () => {
  expect(sourceEventKeyOf("slack", "Ev1")).toBe("fd0e11e3b280d04dc281f9a0e38a5fa379427a46c103c7534e092f8070b685ac");
  expect(sourceEventKeyOf("slack", "")).toBe(null);
  expect(sourceEventKeyOf("slack", undefined)).toBe(null);
  expect(sourceEventKeyOf("slack", 5)).toBe(null);
});
test("normalizeSlackEvent builds the normalized record and rejects malformed payloads", () => {
  const body = {
    type: "event_callback",
    event_id: "Ev1",
    event: { channel: "C_SOURCE", ts: "1700000000.000100", text: "hi", user: "U1" },
  };
  const result = normalizeSlackEvent(body, { now: () => 0, config: defaultConfig() });
  expect(result.ok).toBe(true);
  expect(result.value).toEqual({
    eventId: "evt-fd0e11e3b280d04dc281f9a0e38a5fa3",
    source: "slack",
    sourceEventKey: "fd0e11e3b280d04dc281f9a0e38a5fa379427a46c103c7534e092f8070b685ac",
    channel: "C_SOURCE",
    threadTs: "1700000000.000100",
    text: "hi",
    user: "U1",
    receivedAt: "1970-01-01T00:00:00.000Z",
    intent: "triage",
  });
  const thread = normalizeSlackEvent(
    { ...body, event: { ...body.event, thread_ts: "T1" } },
    { now: () => 0, config: defaultConfig() },
  );
  expect(thread.value.threadTs).toBe("T1");
  const cases = [
    ["x", "body must be a JSON object"],
    [{}, "slack payload requires an event object"],
    [{ event: {} }, "slack payload requires a non-empty event_id"],
    [{ event_id: "E1", event: {} }, "slack event requires a channel string"],
    [{ event_id: "E1", event: { channel: "C" } }, "slack event requires a ts for thread association"],
  ];
  for (const [input, message] of cases) {
    expect(normalizeSlackEvent(input, { now: () => 0, config: defaultConfig() }).message).toBe(message);
  }
});
test("normalizeWebhookEvent defaults the source and derives random ids", () => {
  const keyed = normalizeWebhookEvent(
    "github",
    { eventId: "E1", payload: { channel: "C", text: "yo" } },
    { now: () => 0, config: defaultConfig() },
  );
  expect(keyed.ok).toBe(true);
  expect(keyed.value.source).toBe("github");
  expect(keyed.value.eventId).toBe("evt-11a56f0ea487938b98e5f5df6b1e8e80");
  expect(keyed.value.channel).toBe("C");
  expect(keyed.value.text).toBe("yo");
  expect(keyed.value.threadTs).toBe(null);
  expect(keyed.value.user).toBe(null);
  const defaulted = normalizeWebhookEvent(undefined, {}, { now: () => 0, config: defaultConfig() });
  expect(defaulted.value.source).toBe("webhook");
  expect(defaulted.value.eventId).toMatch(/^evt-[0-9a-f]{24}$/);
  const liveClock = normalizeWebhookEvent("x", { source: "linear", eventId: "E2", text: "top" });
  expect(liveClock.value.source).toBe("linear");
  expect(liveClock.value.text).toBe("top");
  expect(liveClock.value.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(normalizeWebhookEvent("x", "nope").message).toBe("body must be a JSON object");
});
test("isValidIntent and isValidChannel bound the accepted values", () => {
  for (const intent of INTENTS) expect(isValidIntent(intent)).toBe(true);
  expect(isValidIntent("nope")).toBe(false);
  expect(isValidChannel("general")).toBe(true);
  expect(isValidChannel("")).toBe(false);
  expect(isValidChannel("x".repeat(201))).toBe(false);
  expect(isValidChannel("a\nb")).toBe(false);
  expect(isValidChannel(undefined)).toBe(false);
});
test("defaultStateDir and defaultWakeFile read their env overrides", () => {
  const savedState = process.env.PSTACK_BENNY_STATE_DIR;
  const savedWake = process.env.PSTACK_BENNY_WAKE_FILE;
  try {
    process.env.PSTACK_BENNY_STATE_DIR = "/tmp/benny-state";
    process.env.PSTACK_BENNY_WAKE_FILE = "/tmp/benny-wakes.jsonl";
    expect(bennyDefaultStateDir()).toBe("/tmp/benny-state");
    expect(defaultWakeFile()).toBe("/tmp/benny-wakes.jsonl");
    Reflect.deleteProperty(process.env, "PSTACK_BENNY_STATE_DIR");
    Reflect.deleteProperty(process.env, "PSTACK_BENNY_WAKE_FILE");
    expect(bennyDefaultStateDir()).toBe(join(homedir(), ".pi", "agent", "pstack", "benny-events"));
    expect(defaultWakeFile()).toBe(join(homedir(), ".pi", "agent", "pstack-benny-wakes.jsonl"));
  } finally {
    restoreEnv("PSTACK_BENNY_STATE_DIR", savedState);
    restoreEnv("PSTACK_BENNY_WAKE_FILE", savedWake);
  }
});
test("randomEventId and eventIdForKey produce stable ids", () => {
  expect(randomEventId()).toMatch(/^evt-[0-9a-f]{24}$/);
  expect(randomEventId()).not.toBe(randomEventId());
  expect(eventIdForKey("fd0e11e3b280d04dc281f9a0e38a5fa379427a46c103c7534e092f8070b685ac")).toBe("evt-fd0e11e3b280d04dc281f9a0e38a5fa3");
  expect(eventIdForKey(undefined)).toBe("evt-undefined");
  expect(isValidEventId("evt-abc")).toBe(true);
  expect(isValidEventId("..")).toBe(false);
  expect(isValidEventId("a..b")).toBe(false);
  expect(isValidEventId(5)).toBe(false);
  expect(isWakeDelivered({ wakeAppendedAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
  expect(isWakeDelivered({ wakeAppendedAt: "" })).toBe(false);
  expect(isWakeDelivered({})).toBe(false);
});
test("wakeLineFor emits the agent wake shape", () => {
  const record = {
    source: "slack",
    eventId: "evt-1",
    channel: "C",
    threadTs: "T",
    text: "hi",
    user: "U",
    receivedAt: "2026-01-02T03:04:05.000Z",
    intent: "repro",
  };
  expect(JSON.parse(wakeLineFor(record, "2026-01-02T03:04:06.000Z"))).toEqual({
    ts: "2026-01-02T03:04:06.000Z",
    intent: "repro",
    payload: {
      source: "slack",
      eventId: "evt-1",
      channel: "C",
      threadTs: "T",
      text: "hi",
      user: "U",
      receivedAt: "2026-01-02T03:04:05.000Z",
      intent: "repro",
    },
  });
});
test("event records round-trip and markProcessed flips the state", () => {
  const dir = tempDir("pstack-benny-store-");
  const wakeFile = join(dir, "wakes.jsonl");
  try {
    let now = 0;
    const store = createEventStore({ stateDir: dir, wakeFile, now: () => now });
    expect(store.eventPath("evt-1")).toBe(join(dir, "events", "evt-1.json"));
    expect(() => store.eventPath("../escape")).toThrow(/invalid eventId/);
    expect(() => store.saveEvent({ eventId: ".." })).toThrow(/saveEvent requires a valid eventId/);
    const saved = store.saveEvent(eventRecord("evt-1", { receivedAt: "2026-01-01T00:00:02.000Z" }));
    expect(saved.state).toBe("pending");
    expect(store.loadEvent("evt-1").eventId).toBe("evt-1");
    expect(store.loadEvent("evt-missing")).toBe(null);
    now = 1000;
    const processed = store.markProcessed("evt-1", { acknowledgedAt: "2026-01-01T00:00:03.000Z" });
    expect(processed.state).toBe("processed");
    expect(processed.result).toEqual({ acknowledgedAt: "2026-01-01T00:00:03.000Z" });
    expect(processed.processedAt).toBe("1970-01-01T00:00:01.000Z");
    expect(store.markProcessed("evt-missing")).toBe(null);
  } finally {
    cleanupDir(dir);
  }
});
test("markWakeDelivered records success and failure outcomes", () => {
  const dir = tempDir("pstack-benny-delivered-");
  try {
    let now = 0;
    const store = createEventStore({ stateDir: dir, wakeFile: join(dir, "wakes.jsonl"), now: () => now });
    store.saveEvent(eventRecord("evt-1"));
    now = 5000;
    const delivered = store.markWakeDelivered("evt-1", { ok: true });
    expect(delivered.wakeAttempts).toBe(1);
    expect(delivered.lastWakeError).toBe(null);
    expect(delivered.wakeAppendedAt).toBe("1970-01-01T00:00:05.000Z");
    const failed = store.markWakeDelivered("evt-1", { ok: false, error: "disk full" });
    expect(failed.wakeAttempts).toBe(2);
    expect(failed.lastWakeError).toBe("disk full");
    expect(failed.wakeAppendedAt).toBe(delivered.wakeAppendedAt);
    expect(store.markWakeDelivered("evt-missing", { ok: true })).toBe(null);
  } finally {
    cleanupDir(dir);
  }
});
test("deliverEvent appends one wake line and is idempotent", () => {
  const dir = tempDir("pstack-benny-deliver-");
  const wakeFile = join(dir, "wakes.jsonl");
  try {
    const store = createEventStore({ stateDir: dir, wakeFile, now: () => 0 });
    store.saveEvent(eventRecord("evt-1"));
    const delivered = store.deliverEvent("evt-1");
    expect(typeof delivered.wakeAppendedAt).toBe("string");
    const again = store.deliverEvent("evt-1");
    expect(again.wakeAppendedAt).toBe(delivered.wakeAppendedAt);
    expect(readFileSync(wakeFile, "utf8").split("\n").filter((line) => line.trim()).length).toBe(1);
    expect(store.deliverEvent("evt-missing")).toBe(null);
  } finally {
    cleanupDir(dir);
  }
});
test("appendWakeFile reports a write failure instead of throwing", () => {
  const dir = tempDir("pstack-benny-wake-");
  const wakeFile = join(dir, "wakes.jsonl");
  try {
    const store = createEventStore({ stateDir: dir, wakeFile });
    expect(store.appendWakeFile("line")).toEqual({ ok: true, path: wakeFile });
    const target = join(dir, "failing.jsonl");
    const failing = createEventStore({
      stateDir: dir,
      wakeFile: target,
      appendLine: () => {
        throw new Error("boom");
      },
    });
    expect(failing.appendWakeFile("line")).toEqual({ ok: false, path: target, error: "boom" });
    expect(() => failing.appendWakeFile("")).toThrow(/appendWakeFile requires a non-empty line/);
  } finally {
    cleanupDir(dir);
  }
});
test("listEvents sorts by receivedAt then eventId and rejects an unknown state", () => {
  const dir = tempDir("pstack-benny-list-");
  try {
    const store = createEventStore({ stateDir: dir, wakeFile: join(dir, "wakes.jsonl") });
    store.saveEvent(eventRecord("evt-b", { receivedAt: "2026-01-01T00:00:01.000Z" }));
    store.saveEvent(eventRecord("evt-a", { receivedAt: "2026-01-01T00:00:01.000Z" }));
    store.saveEvent(eventRecord("evt-c", { receivedAt: "2026-01-01T00:00:00.000Z" }));
    expect(store.listEvents().map((entry) => entry.eventId)).toEqual(["evt-c", "evt-a", "evt-b"]);
    expect(store.listEvents("pending").map((entry) => entry.eventId)).toEqual(["evt-c", "evt-a", "evt-b"]);
    expect(() => store.listEvents("bogus")).toThrow(/unknown event state: bogus/);
    store.saveEvent(eventRecord("evt-1", { sourceEventKey: "key-1" }));
    expect(store.findDuplicate("key-1").eventId).toBe("evt-1");
    expect(store.findDuplicate("key-2")).toBe(null);
    expect(store.findDuplicate("")).toBe(null);
  } finally {
    cleanupDir(dir);
  }
});
test("a corrupt event record throws with its path", () => {
  const dir = tempDir("pstack-benny-corrupt-");
  try {
    const store = createEventStore({ stateDir: dir, wakeFile: join(dir, "wakes.jsonl") });
    mkdirSync(store.eventsDir, { recursive: true });
    writeFileSync(join(store.eventsDir, "bad.json"), "{oops", "utf8");
    expect(() => store.loadEvent("bad")).toThrow(/corrupt event record at .*bad\.json/);
  } finally {
    cleanupDir(dir);
  }
});
test("benny main listens on the env port and serves healthz", async () => {
  const dir = tempDir("pstack-benny-main-");
  const saved = [process.env.PSTACK_BENNY_PORT, process.env.PSTACK_BENNY_TOKEN, process.env.PSTACK_BENNY_CONFIG_DIR, process.env.PSTACK_BENNY_STATE_DIR, process.env.PSTACK_BENNY_WAKE_FILE, process.env.PSTACK_BENNY_SIGNING_SECRET];
  process.env.PSTACK_BENNY_PORT = "0";
  process.env.PSTACK_BENNY_TOKEN = "main-token";
  process.env.PSTACK_BENNY_CONFIG_DIR = dir;
  process.env.PSTACK_BENNY_STATE_DIR = dir;
  process.env.PSTACK_BENNY_WAKE_FILE = join(dir, "wakes.jsonl");
  Reflect.deleteProperty(process.env, "PSTACK_BENNY_SIGNING_SECRET");
  let server;
  try {
    server = bennyMain();
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await request(`http://127.0.0.1:${server.address().port}`, "/healthz");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: "ok" });
  } finally {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    restoreEnv("PSTACK_BENNY_PORT", saved[0]);
    restoreEnv("PSTACK_BENNY_TOKEN", saved[1]);
    restoreEnv("PSTACK_BENNY_CONFIG_DIR", saved[2]);
    restoreEnv("PSTACK_BENNY_STATE_DIR", saved[3]);
    restoreEnv("PSTACK_BENNY_WAKE_FILE", saved[4]);
    restoreEnv("PSTACK_BENNY_SIGNING_SECRET", saved[5]);
    cleanupDir(dir);
  }
});
