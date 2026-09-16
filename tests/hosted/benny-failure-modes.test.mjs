import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  TEST_SIGNING_SECRET,
  TEST_TOKEN,
  cleanupDir,
  readWakeLines,
  request,
  signedHeaders,
  slackBody,
  startBenny,
  storeFor,
  tempDir,
} from "./benny-helpers.mjs";

const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const CONFIG = { routes: [{ channel: "C_SOURCE", intent: "triage" }], defaultIntent: "triage" };

function withServer(t, options) {
  const started = startBenny(options);
  return started.then((benny) => {
    t.after(async () => {
      await benny.close();
    });
    return benny;
  });
}

function eventFiles(stateDir) {
  const dir = join(stateDir, "events");
  return existsSync(dir) ? readdirSync(dir) : [];
}

test("benny-failure-01 rejects a bad slack signature", async (t) => {
  const stateDir = tempDir("pstack-benny-sig-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const store = storeFor(stateDir, wakeFile);
  const benny = await withServer(t, {
    store,
    config: CONFIG,
    token: "",
    signingSecret: TEST_SIGNING_SECRET,
    now: () => FIXED_NOW,
  });
  t.after(() => cleanupDir(stateDir));

  const raw = JSON.stringify(slackBody());
  const headers = signedHeaders(TEST_SIGNING_SECRET, raw, FIXED_NOW);
  const accepted = await request(benny.base, "/v1/benny/events", { method: "POST", body: raw, headers });
  assert.equal(accepted.status, 202);
  assert.equal(eventFiles(stateDir).length, 1);

  const tampered = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    body: JSON.stringify(slackBody()),
    headers: { ...headers, "x-slack-signature": `v0=${"0".repeat(64)}` },
  });
  assert.equal(tampered.status, 401);
  assert.equal(eventFiles(stateDir).length, 1);

  const unsigned = await request(benny.base, "/v1/benny/events", { method: "POST", body: raw });
  assert.equal(unsigned.status, 401);
  assert.equal(eventFiles(stateDir).length, 1);
});

test("benny-failure-02 missing credentials are 401", async (t) => {
  const stateDir = tempDir("pstack-benny-auth-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body: slackBody() });
  assert.equal(posted.status, 401);
  const listed = await request(benny.base, "/v1/benny/events?state=pending");
  assert.equal(listed.status, 401);
  const wrong = await request(benny.base, "/v1/benny/events?state=pending", { token: "not-the-token" });
  assert.equal(wrong.status, 401);
  assert.equal(eventFiles(stateDir).length, 0);
});

test("benny-failure-03 no configured credential fails closed with 503", async (t) => {
  const stateDir = tempDir("pstack-benny-closed-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: "",
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const health = await request(benny.base, "/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.json.status, "ok");
  assert.equal((await request(benny.base, "/v1/benny/events", { method: "POST", body: slackBody() })).status, 503);
  assert.equal((await request(benny.base, "/v1/benny/events?state=pending")).status, 503);
  assert.equal((await request(benny.base, "/v1/benny/test-event", { method: "POST", body: slackBody() })).status, 503);
  assert.equal((await request(benny.base, "/v1/hooks/anything", { method: "POST", body: {} })).status, 503);
  assert.equal((await request(benny.base, "/v1/benny/events/evt-x/ack", { method: "POST" })).status, 503);
  assert.equal(existsSync(join(stateDir, "wakes.jsonl")), false);
});

test("benny-failure-04 malformed json persists nothing", async (t) => {
  const stateDir = tempDir("pstack-benny-json-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const posted = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: "{\"type\": \"event_callback\", ",
  });
  assert.equal(posted.status, 400);
  assert.equal(posted.text.includes(TEST_TOKEN), false);
  assert.equal(eventFiles(stateDir).length, 0);

  const wrongShape = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: { type: "event_callback" },
  });
  assert.equal(wrongShape.status, 400);
  assert.equal(eventFiles(stateDir).length, 0);
});

test("benny-failure-05 a failed wake append keeps the event pending and retries", async (t) => {
  const stateDir = tempDir("pstack-benny-wake-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const control = { fail: true };
  const store = storeFor(stateDir, wakeFile, {
    appendLine: (file, text) => {
      if (control.fail) throw new Error("simulated wake write failure");
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, text, "utf8");
    },
  });
  const benny = await withServer(t, {
    store,
    config: CONFIG,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const body = slackBody();
  const first = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  assert.equal(first.status, 202);
  assert.equal(first.json.state, "pending");
  const pending = store.loadEvent(first.json.eventId);
  assert.equal(pending.wakeAppendedAt, null);
  assert.equal(pending.lastWakeError, "simulated wake write failure");
  assert.equal(pending.state, "pending");
  assert.equal(existsSync(wakeFile), false);

  control.fail = false;
  const retried = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  assert.equal(retried.status, 200);
  assert.equal(retried.json.eventId, first.json.eventId);
  assert.equal(store.loadEvent(first.json.eventId).lastWakeError, null);
  assert.equal(typeof store.loadEvent(first.json.eventId).wakeAppendedAt, "string");
  assert.equal(readWakeLines(wakeFile).length, 1);
});

test("benny-failure-06 a stale slack timestamp is rejected", async (t) => {
  const stateDir = tempDir("pstack-benny-stale-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: "",
    signingSecret: TEST_SIGNING_SECRET,
    now: () => FIXED_NOW,
  });
  t.after(() => cleanupDir(stateDir));

  const raw = JSON.stringify(slackBody());
  const headers = signedHeaders(TEST_SIGNING_SECRET, raw, FIXED_NOW - 600_000);
  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body: raw, headers });
  assert.equal(posted.status, 401);
  assert.equal(eventFiles(stateDir).length, 0);
});

test("benny-failure-07 oversized body is rejected with 413", async (t) => {
  const stateDir = tempDir("pstack-benny-large-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const posted = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: JSON.stringify(slackBody({ event: { text: "x".repeat(300_000) } })),
  });
  assert.equal(posted.status, 413);
  assert.equal(eventFiles(stateDir).length, 0);
});
