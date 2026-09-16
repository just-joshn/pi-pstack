import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  assert.deepEqual(resolvePiInvocation({ PSTACK_WORKER_PI_BIN: "  /opt/pi  " }, ["node", "/app/server.mjs"]), {
    command: "/opt/pi",
    args: [],
  });
  assert.deepEqual(resolvePiInvocation({}, ["node", "/usr/local/bin/pi"]), {
    command: process.execPath,
    args: ["/usr/local/bin/pi"],
  });
  assert.deepEqual(resolvePiInvocation({}, ["bun", "/$bunfs/root/pi"]), { command: "pi", args: [] });
  assert.deepEqual(resolvePiInvocation({}, ["node", "/app/server.mjs"]), { command: "pi", args: [] });
  assert.deepEqual(resolvePiInvocation({}, []), { command: "pi", args: [] });
});
test("the worker rejects a body past the declared cap with 413", async (t) => {
  const stateDir = tempStateDir();
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: async () => ({ exitCode: 0 }) });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const response = await request(worker.base, "/v1/tasks", {
    method: "POST",
    token: TEST_TOKEN,
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(response.json, { error: "too_large" });
});
test("the worker records a streamed stderr line on the run", async (t) => {
  const stateDir = tempStateDir();
  const executor = async (context) => {
    context.writeStdout("o");
    context.writeStderr("e");
    return { exitCode: 0 };
  };
  const worker = await startWorker({ stateDir, token: TEST_TOKEN, execute: executor });
  t.after(async () => {
    await worker.close();
    cleanupStateDir(stateDir);
  });
  const envelope = makeEnvelope({ runId: "run-stderr", idempotencyKey: "key-stderr" });
  const posted = await request(worker.base, "/v1/tasks", { method: "POST", body: envelope, token: TEST_TOKEN });
  assert.equal(posted.status, 202);
  const deadline = Date.now() + 3000;
  let record;
  while (record?.state !== "completed" && Date.now() < deadline) {
    const polled = await request(worker.base, `/v1/tasks/${envelope.runId}`, { token: TEST_TOKEN });
    record = polled.json;
    if (record?.state !== "completed") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(record.stdout, "o");
  assert.equal(record.stderr, "e");
  assert.equal(record.stderrBytes, 1);
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
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { status: "ok" });
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
  assert.equal(clientKeyOf(req, "test-worker-token"), "10.0.0.9|3db19f57f0d31e2e");
  assert.equal(clientKeyOf(req, "tok"), "10.0.0.9|1a7674eb4ee78df7");
  assert.equal(clientKeyOf(req, ""), "10.0.0.9|2f183a4e64493af3");
  assert.equal(clientKeyOf({}, undefined), "unknown|2f183a4e64493af3");
});
test("createRateLimiter defaults the window and cap and reports its size", () => {
  const limiter = createRateLimiter();
  assert.equal(limiter.windowMs, DEFAULT_WINDOW_MS);
  assert.equal(limiter.maxRequests, DEFAULT_MAX_REQUESTS);
  assert.equal(limiter.size(), 0);
  assert.deepEqual(limiter.check("k"), { allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0 });
  assert.equal(limiter.size(), 1);
});
test("createRateLimiter denies past the cap with retryAfter and resets at the window end", () => {
  let at = 1000;
  const limiter = createRateLimiter({ maxRequests: 2, windowMs: 10_000, now: () => at });
  assert.deepEqual(limiter.check("k"), { allowed: true, limit: 2, remaining: 1, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.check("k"), { allowed: true, limit: 2, remaining: 0, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.check("k"), { allowed: false, limit: 2, remaining: 0, retryAfterSeconds: 10 });
  at = 11_000;
  assert.deepEqual(limiter.check("k"), { allowed: true, limit: 2, remaining: 1, retryAfterSeconds: 0 });
});
test("rateLimitFromEnv reads the named variables and falls back on garbage", () => {
  const names = { maxRequests: "M", windowMs: "W" };
  assert.deepEqual(rateLimitFromEnv({ M: "5", W: "1000" }, names), { maxRequests: 5, windowMs: 1000 });
  assert.deepEqual(rateLimitFromEnv({}, names), { maxRequests: 120, windowMs: 60000 });
  assert.deepEqual(rateLimitFromEnv({ M: "abc", W: "-3" }, names), { maxRequests: 120, windowMs: 60000 });
});
test("defaultStateDir prefers the env override over the home default", () => {
  const saved = process.env.PSTACK_WORKER_STATE_DIR;
  try {
    process.env.PSTACK_WORKER_STATE_DIR = "/tmp/worker-state";
    assert.equal(workerDefaultStateDir(), "/tmp/worker-state");
    Reflect.deleteProperty(process.env, "PSTACK_WORKER_STATE_DIR");
    assert.equal(workerDefaultStateDir(), join(homedir(), ".pi", "agent", "pstack", "hosted"));
  } finally {
    restoreEnv("PSTACK_WORKER_STATE_DIR", saved);
  }
});
test("isValidRunId and isTerminalState classify ids and states", () => {
  assert.equal(isValidRunId("run-1.a_b"), true);
  assert.equal(isValidRunId(".."), false);
  assert.equal(isValidRunId("."), false);
  assert.equal(isValidRunId("a..b"), false);
  assert.equal(isValidRunId("x".repeat(65)), false);
  assert.equal(isValidRunId(7), false);
  for (const state of RUN_STATES) {
    assert.equal(isTerminalState(state), state !== "accepted" && state !== "running");
  }
});
test("runs round-trip through saveRun, loadRun, listRuns, and deleteRun", () => {
  const dir = tempStateDir();
  try {
    const store = createRunStore({ stateDir: dir });
    store.saveRun(runRecord("run-b", { createdAt: 2 }));
    store.saveRun(runRecord("run-a", { createdAt: 1 }));
    assert.deepEqual(store.listRuns().map((entry) => entry.runId), ["run-a", "run-b"]);
    assert.equal(store.loadRun("run-a").idempotencyKey, "idem-run-a");
    assert.equal(store.loadRun("missing"), null);
    assert.equal(store.deleteRun("run-a"), true);
    assert.equal(store.deleteRun("run-a"), false);
    assert.deepEqual(store.listRuns().map((entry) => entry.runId), ["run-b"]);
    assert.equal(store.runPath("run-b"), join(dir, "runs", "run-b.json"));
    assert.throws(() => store.runPath("../escape"), /invalid runId/);
    assert.equal(store.outputPath("run-b", "stdout"), join(dir, "output", "run-b.stdout.log"));
    assert.throws(() => store.outputPath("run-b", "bogus"), /unknown output stream/);
    assert.equal(store.appendOutput("run-out", "stdout", "héllo"), 6);
    assert.equal(store.appendOutput("run-out", "stderr", ""), 0);
    assert.equal(store.readOutput("run-out", "stdout"), "héllo");
    assert.equal(store.readOutput("run-out", "stderr"), "");
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
    assert.equal(claimed.attempt, 1);
    assert.equal(claimed.state, "running");
    assert.equal(claimed.startedAt, 100);
    assert.equal(claimed.leaseExpiresAt, 600);
    now = 200;
    assert.equal(store.claimAttempt("run-claim").attempt, 2);
    assert.throws(() => store.claimAttempt("run-missing"), /cannot claim an attempt for unknown run: run-missing/);
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
    assert.deepEqual(expired.map((entry) => entry.runId), ["run-stale"]);
    const dead = store.loadRun("run-stale");
    assert.equal(dead.state, "dead");
    assert.equal(dead.stdout, "partial");
    assert.equal(dead.stopReason, "lease_expired");
    assert.equal(dead.finishedAt, 1000);
    assert.equal(dead.leaseExpiresAt, null);
    assert.equal(store.loadRun("run-fresh").state, "running");
    assert.equal(store.loadRun("run-terminal").state, "completed");
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
    assert.throws(() => store.loadRun("bad-run"), /corrupt run record at .*bad-run\.json/);
    assert.throws(() => store.saveRun({}), /saveRun requires a valid runId/);
  } finally {
    cleanupStateDir(dir);
  }
});
test("validateTaskRequest normalizes a valid envelope against the workspace root", () => {
  const result = validateTaskRequest(makeEnvelope({ runId: "run-ok", idempotencyKey: "key-ok" }));
  assert.equal(result.ok, true);
  assert.equal(result.value.runId, "run-ok");
  assert.equal(result.value.idempotencyKey, "key-ok");
  assert.equal(result.value.parentOwnership.cwd, realpathSync(process.cwd()));
  assert.equal(result.value.parentSessionCwd, realpathSync(process.cwd()));
  assert.equal(result.value.upstreamRevision, "test-rev");
  assert.equal(result.value.pluginVersion, "test-plugin");
  assert.equal(result.value.task, "test task");
  assert.equal(result.value.role, "general");
  assert.equal(result.value.thinkingLevel, null);
  assert.deepEqual(result.value.capabilities, []);
  assert.deepEqual(result.value.secretRefs, []);
  assert.equal(result.value.isolation, "remote");
  assert.equal(result.value.timeoutMs, 5000);
  assert.equal(result.value.reportSchema, null);
  assert.equal(result.value.policy.background, false);
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
    assert.equal(result.ok, false);
    assert.match(result.message, pattern);
  }
});
test("validateTaskRequest requires the eight policy axes and valid enum values", () => {
  const missing = validateTaskRequest(makeEnvelope({ policy: { filesystem: "read-only" } }));
  assert.equal(missing.ok, false);
  assert.equal(missing.message, "policy is missing axes: background, environment, git, integrations, isolation, network, shell");
  const base = makeEnvelope();
  const badShell = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, shell: "sometimes" } }));
  assert.equal(badShell.message, "policy.shell must be one of none, restricted, full");
  const badBackground = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, background: "yes" } }));
  assert.equal(badBackground.message, "policy.background must be a boolean");
  const nonObject = validateTaskRequest(makeEnvelope({ policy: "nope" }));
  assert.equal(nonObject.message, "policy must be an object with the eight axes");
});
test("validateTaskRequest accepts an integrations array and rejects a bad entry or type", () => {
  const base = makeEnvelope();
  const accepted = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, integrations: ["source-control", "team-chat"] } }));
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.value.policy.integrations, ["source-control", "team-chat"]);
  const emptyEntry = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, integrations: [""] } }));
  assert.equal(emptyEntry.message, "policy.integrations must be none, inherit, or an array of capability names");
  const badType = validateTaskRequest(makeEnvelope({ policy: { ...base.policy, integrations: 5 } }));
  assert.equal(badType.message, "policy.integrations must be none, inherit, or an array of capability names");
});
test("validateTaskRequest validates capabilities, secretRefs, timeout, isolation, and thinkingLevel", () => {
  assert.equal(
    validateTaskRequest(makeEnvelope({ capabilities: ["ok", 1] })).message,
    "capabilities must be an array of strings",
  );
  assert.equal(
    validateTaskRequest(makeEnvelope({ secretRefs: [1] })).message,
    "secretRefs must be an array of strings",
  );
  assert.equal(
    validateTaskRequest(makeEnvelope({ timeoutMs: 999 })).message,
    `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
  );
  assert.equal(validateTaskRequest(makeEnvelope({ timeoutMs: MAX_TIMEOUT_MS + 1 })).ok, false);
  assert.equal(validateTaskRequest(makeEnvelope({ timeoutMs: null })).value.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.match(
    validateTaskRequest(makeEnvelope({ isolation: "moon" })).message,
    /isolation must be one of session, process, worktree/,
  );
  assert.equal(
    validateTaskRequest(makeEnvelope({ thinkingLevel: 5 })).message,
    "thinkingLevel must be a string or null",
  );
  assert.equal(validateTaskRequest(makeEnvelope({ thinkingLevel: "high" })).value.thinkingLevel, "high");
});
test("validateTaskRequest resolves the legacy parentSessionCwd alias and rejects a bad sessionId", () => {
  const alias = validateTaskRequest(makeEnvelope({ parentOwnership: undefined, parentSessionCwd: process.cwd() }));
  assert.equal(alias.ok, true);
  assert.equal(alias.value.parentSessionCwd, realpathSync(process.cwd()));
  const badSession = validateTaskRequest(makeEnvelope({ parentOwnership: { sessionId: 5, cwd: process.cwd() } }));
  assert.equal(badSession.message, "parentOwnership.sessionId must be a string");
  const badObject = validateTaskRequest(makeEnvelope({ parentOwnership: "x" }));
  assert.equal(badObject.message, "parentOwnership must be an object");
});
test("validateTaskRequest rejects a missing cwd, an outside cwd, and a missing workspace root", () => {
  const root = tempStateDir();
  const other = tempStateDir();
  try {
    const missing = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: join(root, "nope") } }),
      { workspaceRoot: root },
    );
    assert.equal(missing.message, "parentOwnership.cwd must be an existing directory inside the workspace root");
    const outside = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: other } }),
      { workspaceRoot: root },
    );
    assert.equal(outside.message, "parentOwnership.cwd must stay inside the worker workspace root");
    const badRoot = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: root } }),
      { workspaceRoot: join(root, "absent") },
    );
    assert.equal(badRoot.message, "the worker workspace root is not an accessible directory");
    const ok = validateTaskRequest(
      makeEnvelope({ parentOwnership: { sessionId: "s", cwd: root } }),
      { workspaceRoot: root },
    );
    assert.equal(ok.value.parentOwnership.cwd, realpathSync(root));
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
  assert.equal(result.value.upstreamRevision, "unknown");
  assert.equal(result.value.pluginVersion, "unknown");
});
test("defaultConfigDir and configPathOf resolve from the env override", () => {
  const saved = process.env.PSTACK_BENNY_CONFIG_DIR;
  try {
    process.env.PSTACK_BENNY_CONFIG_DIR = "/tmp/benny-cfg";
    assert.equal(defaultConfigDir(), "/tmp/benny-cfg");
    assert.equal(configPathOf(), "/tmp/benny-cfg/benny.json");
    Reflect.deleteProperty(process.env, "PSTACK_BENNY_CONFIG_DIR");
    assert.equal(defaultConfigDir(), join(homedir(), ".pi", "agent"));
  } finally {
    restoreEnv("PSTACK_BENNY_CONFIG_DIR", saved);
  }
});
test("validateConfig rejects malformed routes and returns the config unchanged", () => {
  assert.throws(() => validateConfig(null), /benny config must be a JSON object/);
  assert.throws(() => validateConfig({ routes: {} }), /benny config routes must be an array/);
  assert.throws(() => validateConfig({ routes: [1] }), /benny config route 0 must be an object/);
  assert.throws(
    () => validateConfig({ routes: [{ channel: "", intent: "triage" }] }),
    /benny config route 0 needs a channel string/,
  );
  assert.throws(
    () => validateConfig({ routes: [{ channel: "c", intent: "nope" }] }),
    /benny config route 0 intent must be one of triage, repro, ignore/,
  );
  assert.throws(() => validateConfig({ defaultIntent: "nope" }), /benny config defaultIntent must be one of/);
  const valid = { routes: [{ channel: "c", intent: "repro" }], defaultIntent: "ignore" };
  assert.equal(validateConfig(valid), valid);
});
test("loadConfig returns the default when missing and throws on invalid JSON", () => {
  const dir = tempDir("pstack-benny-config-");
  try {
    const missing = loadConfig({ dir });
    assert.equal(missing.exists, false);
    assert.equal(missing.path, join(dir, "benny.json"));
    assert.deepEqual(missing.config, { routes: [], defaultIntent: "triage" });
    writeFileSync(join(dir, "benny.json"), "{oops", "utf8");
    assert.throws(() => loadConfig({ dir }), /is not valid JSON/);
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
    assert.deepEqual(merged, {
      routes: [{ channel: "C", intent: "repro" }],
      defaultIntent: "triage",
      owner: "me",
      note: "keep",
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), merged);
    assert.throws(() => writeConfig({ defaultIntent: "nope" }, { dir }), /benny config defaultIntent must be one of/);
  } finally {
    cleanupDir(dir);
  }
});
test("resolveIntent prefers a channel route, then the default, then triage", () => {
  const config = { routes: [{ channel: "C_SOURCE", intent: "repro" }], defaultIntent: "ignore" };
  assert.equal(resolveIntent(config, "C_SOURCE"), "repro");
  assert.equal(resolveIntent(config, "OTHER"), "ignore");
  assert.equal(resolveIntent({}, "OTHER"), "triage");
  assert.equal(resolveIntent({ routes: [{ channel: "C", intent: "nope" }] }, "C"), "triage");
});
test("sourceEventKeyOf hashes the source event id and rejects an empty id", () => {
  assert.equal(
    sourceEventKeyOf("slack", "Ev1"),
    "fd0e11e3b280d04dc281f9a0e38a5fa379427a46c103c7534e092f8070b685ac",
  );
  assert.equal(sourceEventKeyOf("slack", ""), null);
  assert.equal(sourceEventKeyOf("slack", undefined), null);
  assert.equal(sourceEventKeyOf("slack", 5), null);
});
test("normalizeSlackEvent builds the normalized record and rejects malformed payloads", () => {
  const body = {
    type: "event_callback",
    event_id: "Ev1",
    event: { channel: "C_SOURCE", ts: "1700000000.000100", text: "hi", user: "U1" },
  };
  const result = normalizeSlackEvent(body, { now: () => 0, config: defaultConfig() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
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
  assert.equal(thread.value.threadTs, "T1");
  const cases = [
    ["x", "body must be a JSON object"],
    [{}, "slack payload requires an event object"],
    [{ event: {} }, "slack payload requires a non-empty event_id"],
    [{ event_id: "E1", event: {} }, "slack event requires a channel string"],
    [{ event_id: "E1", event: { channel: "C" } }, "slack event requires a ts for thread association"],
  ];
  for (const [input, message] of cases) {
    assert.equal(normalizeSlackEvent(input, { now: () => 0, config: defaultConfig() }).message, message);
  }
});
test("normalizeWebhookEvent defaults the source and derives random ids", () => {
  const keyed = normalizeWebhookEvent(
    "github",
    { eventId: "E1", payload: { channel: "C", text: "yo" } },
    { now: () => 0, config: defaultConfig() },
  );
  assert.equal(keyed.ok, true);
  assert.equal(keyed.value.source, "github");
  assert.equal(keyed.value.eventId, "evt-11a56f0ea487938b98e5f5df6b1e8e80");
  assert.equal(keyed.value.channel, "C");
  assert.equal(keyed.value.text, "yo");
  assert.equal(keyed.value.threadTs, null);
  assert.equal(keyed.value.user, null);
  const defaulted = normalizeWebhookEvent(undefined, {}, { now: () => 0, config: defaultConfig() });
  assert.equal(defaulted.value.source, "webhook");
  assert.match(defaulted.value.eventId, /^evt-[0-9a-f]{24}$/);
  const liveClock = normalizeWebhookEvent("x", { source: "linear", eventId: "E2", text: "top" });
  assert.equal(liveClock.value.source, "linear");
  assert.equal(liveClock.value.text, "top");
  assert.match(liveClock.value.receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(normalizeWebhookEvent("x", "nope").message, "body must be a JSON object");
});
test("isValidIntent and isValidChannel bound the accepted values", () => {
  for (const intent of INTENTS) assert.equal(isValidIntent(intent), true);
  assert.equal(isValidIntent("nope"), false);
  assert.equal(isValidChannel("general"), true);
  assert.equal(isValidChannel(""), false);
  assert.equal(isValidChannel("x".repeat(201)), false);
  assert.equal(isValidChannel("a\nb"), false);
  assert.equal(isValidChannel(undefined), false);
});
test("defaultStateDir and defaultWakeFile read their env overrides", () => {
  const savedState = process.env.PSTACK_BENNY_STATE_DIR;
  const savedWake = process.env.PSTACK_BENNY_WAKE_FILE;
  try {
    process.env.PSTACK_BENNY_STATE_DIR = "/tmp/benny-state";
    process.env.PSTACK_BENNY_WAKE_FILE = "/tmp/benny-wakes.jsonl";
    assert.equal(bennyDefaultStateDir(), "/tmp/benny-state");
    assert.equal(defaultWakeFile(), "/tmp/benny-wakes.jsonl");
    Reflect.deleteProperty(process.env, "PSTACK_BENNY_STATE_DIR");
    Reflect.deleteProperty(process.env, "PSTACK_BENNY_WAKE_FILE");
    assert.equal(bennyDefaultStateDir(), join(homedir(), ".pi", "agent", "pstack", "benny-events"));
    assert.equal(defaultWakeFile(), join(homedir(), ".pi", "agent", "pstack-benny-wakes.jsonl"));
  } finally {
    restoreEnv("PSTACK_BENNY_STATE_DIR", savedState);
    restoreEnv("PSTACK_BENNY_WAKE_FILE", savedWake);
  }
});
test("randomEventId and eventIdForKey produce stable ids", () => {
  assert.match(randomEventId(), /^evt-[0-9a-f]{24}$/);
  assert.notEqual(randomEventId(), randomEventId());
  assert.equal(
    eventIdForKey("fd0e11e3b280d04dc281f9a0e38a5fa379427a46c103c7534e092f8070b685ac"),
    "evt-fd0e11e3b280d04dc281f9a0e38a5fa3",
  );
  assert.equal(eventIdForKey(undefined), "evt-undefined");
  assert.equal(isValidEventId("evt-abc"), true);
  assert.equal(isValidEventId(".."), false);
  assert.equal(isValidEventId("a..b"), false);
  assert.equal(isValidEventId(5), false);
  assert.equal(isWakeDelivered({ wakeAppendedAt: "2026-01-01T00:00:00.000Z" }), true);
  assert.equal(isWakeDelivered({ wakeAppendedAt: "" }), false);
  assert.equal(isWakeDelivered({}), false);
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
  assert.deepEqual(JSON.parse(wakeLineFor(record, "2026-01-02T03:04:06.000Z")), {
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
    assert.equal(store.eventPath("evt-1"), join(dir, "events", "evt-1.json"));
    assert.throws(() => store.eventPath("../escape"), /invalid eventId/);
    assert.throws(() => store.saveEvent({ eventId: ".." }), /saveEvent requires a valid eventId/);
    const saved = store.saveEvent(eventRecord("evt-1", { receivedAt: "2026-01-01T00:00:02.000Z" }));
    assert.equal(saved.state, "pending");
    assert.equal(store.loadEvent("evt-1").eventId, "evt-1");
    assert.equal(store.loadEvent("evt-missing"), null);
    now = 1000;
    const processed = store.markProcessed("evt-1", { acknowledgedAt: "2026-01-01T00:00:03.000Z" });
    assert.equal(processed.state, "processed");
    assert.deepEqual(processed.result, { acknowledgedAt: "2026-01-01T00:00:03.000Z" });
    assert.equal(processed.processedAt, "1970-01-01T00:00:01.000Z");
    assert.equal(store.markProcessed("evt-missing"), null);
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
    assert.equal(delivered.wakeAttempts, 1);
    assert.equal(delivered.lastWakeError, null);
    assert.equal(delivered.wakeAppendedAt, "1970-01-01T00:00:05.000Z");
    const failed = store.markWakeDelivered("evt-1", { ok: false, error: "disk full" });
    assert.equal(failed.wakeAttempts, 2);
    assert.equal(failed.lastWakeError, "disk full");
    assert.equal(failed.wakeAppendedAt, delivered.wakeAppendedAt);
    assert.equal(store.markWakeDelivered("evt-missing", { ok: true }), null);
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
    assert.equal(typeof delivered.wakeAppendedAt, "string");
    const again = store.deliverEvent("evt-1");
    assert.equal(again.wakeAppendedAt, delivered.wakeAppendedAt);
    assert.equal(readFileSync(wakeFile, "utf8").split("\n").filter((line) => line.trim()).length, 1);
    assert.equal(store.deliverEvent("evt-missing"), null);
  } finally {
    cleanupDir(dir);
  }
});
test("appendWakeFile reports a write failure instead of throwing", () => {
  const dir = tempDir("pstack-benny-wake-");
  const wakeFile = join(dir, "wakes.jsonl");
  try {
    const store = createEventStore({ stateDir: dir, wakeFile });
    assert.deepEqual(store.appendWakeFile("line"), { ok: true, path: wakeFile });
    const target = join(dir, "failing.jsonl");
    const failing = createEventStore({
      stateDir: dir,
      wakeFile: target,
      appendLine: () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(failing.appendWakeFile("line"), { ok: false, path: target, error: "boom" });
    assert.throws(() => failing.appendWakeFile(""), /appendWakeFile requires a non-empty line/);
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
    assert.deepEqual(store.listEvents().map((entry) => entry.eventId), ["evt-c", "evt-a", "evt-b"]);
    assert.deepEqual(store.listEvents("pending").map((entry) => entry.eventId), ["evt-c", "evt-a", "evt-b"]);
    assert.throws(() => store.listEvents("bogus"), /unknown event state: bogus/);
    store.saveEvent(eventRecord("evt-1", { sourceEventKey: "key-1" }));
    assert.equal(store.findDuplicate("key-1").eventId, "evt-1");
    assert.equal(store.findDuplicate("key-2"), null);
    assert.equal(store.findDuplicate(""), null);
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
    assert.throws(() => store.loadEvent("bad"), /corrupt event record at .*bad\.json/);
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
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { status: "ok" });
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
