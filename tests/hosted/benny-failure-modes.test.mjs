import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
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
    t.onTestFinished(async () => {
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const raw = JSON.stringify(slackBody());
  const headers = signedHeaders(TEST_SIGNING_SECRET, raw, FIXED_NOW);
  const accepted = await request(benny.base, "/v1/benny/events", { method: "POST", body: raw, headers });
  expect(accepted.status).toBe(202);
  expect(eventFiles(stateDir).length).toBe(1);

  const tampered = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    body: JSON.stringify(slackBody()),
    headers: { ...headers, "x-slack-signature": `v0=${"0".repeat(64)}` },
  });
  expect(tampered.status).toBe(401);
  expect(eventFiles(stateDir).length).toBe(1);

  const unsigned = await request(benny.base, "/v1/benny/events", { method: "POST", body: raw });
  expect(unsigned.status).toBe(401);
  expect(eventFiles(stateDir).length).toBe(1);
});

test("benny-failure-02 missing credentials are 401", async (t) => {
  const stateDir = tempDir("pstack-benny-auth-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.onTestFinished(() => cleanupDir(stateDir));

  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body: slackBody() });
  expect(posted.status).toBe(401);
  const listed = await request(benny.base, "/v1/benny/events?state=pending");
  expect(listed.status).toBe(401);
  const wrong = await request(benny.base, "/v1/benny/events?state=pending", { token: "not-the-token" });
  expect(wrong.status).toBe(401);
  expect(eventFiles(stateDir).length).toBe(0);
});

test("benny-failure-03 no configured credential fails closed with 503", async (t) => {
  const stateDir = tempDir("pstack-benny-closed-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: "",
    signingSecret: "",
  });
  t.onTestFinished(() => cleanupDir(stateDir));

  const health = await request(benny.base, "/healthz");
  expect(health.status).toBe(200);
  expect(health.json.status).toBe("ok");
  expect((await request(benny.base, "/v1/benny/events", { method: "POST", body: slackBody() })).status).toBe(503);
  expect((await request(benny.base, "/v1/benny/events?state=pending")).status).toBe(503);
  expect((await request(benny.base, "/v1/benny/test-event", { method: "POST", body: slackBody() })).status).toBe(503);
  expect((await request(benny.base, "/v1/hooks/anything", { method: "POST", body: {} })).status).toBe(503);
  expect((await request(benny.base, "/v1/benny/events/evt-x/ack", { method: "POST" })).status).toBe(503);
  expect(existsSync(join(stateDir, "wakes.jsonl"))).toBe(false);
});

test("benny-failure-04 malformed json persists nothing", async (t) => {
  const stateDir = tempDir("pstack-benny-json-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.onTestFinished(() => cleanupDir(stateDir));

  const posted = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: "{\"type\": \"event_callback\", ",
  });
  expect(posted.status).toBe(400);
  expect(posted.text.includes(TEST_TOKEN)).toBe(false);
  expect(eventFiles(stateDir).length).toBe(0);

  const wrongShape = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: { type: "event_callback" },
  });
  expect(wrongShape.status).toBe(400);
  expect(eventFiles(stateDir).length).toBe(0);
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const body = slackBody();
  const first = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  expect(first.status).toBe(202);
  expect(first.json.state).toBe("pending");
  const pending = store.loadEvent(first.json.eventId);
  expect(pending.wakeAppendedAt).toBe(null);
  expect(pending.lastWakeError).toBe("simulated wake write failure");
  expect(pending.state).toBe("pending");
  expect(existsSync(wakeFile)).toBe(false);

  control.fail = false;
  const retried = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  expect(retried.status).toBe(200);
  expect(retried.json.eventId).toBe(first.json.eventId);
  expect(store.loadEvent(first.json.eventId).lastWakeError).toBe(null);
  expect(typeof store.loadEvent(first.json.eventId).wakeAppendedAt).toBe("string");
  expect(readWakeLines(wakeFile).length).toBe(1);
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const raw = JSON.stringify(slackBody());
  const headers = signedHeaders(TEST_SIGNING_SECRET, raw, FIXED_NOW - 600_000);
  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body: raw, headers });
  expect(posted.status).toBe(401);
  expect(eventFiles(stateDir).length).toBe(0);
});

test("benny-failure-07 oversized body is rejected with 413", async (t) => {
  const stateDir = tempDir("pstack-benny-large-");
  const benny = await withServer(t, {
    store: storeFor(stateDir, join(stateDir, "wakes.jsonl")),
    config: CONFIG,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.onTestFinished(() => cleanupDir(stateDir));

  const posted = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: JSON.stringify(slackBody({ event: { text: "x".repeat(300_000) } })),
  });
  expect(posted.status).toBe(413);
  expect(eventFiles(stateDir).length).toBe(0);
});
