import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  TEST_SIGNING_SECRET,
  TEST_TOKEN,
  cleanupDir,
  configFixture,
  readWakeLines,
  request,
  slackBody,
  startBenny,
  storeFor,
  tempDir,
} from "./benny-helpers.mjs";

function withServer(t, options) {
  const started = startBenny(options);
  return started.then((benny) => {
    t.after(async () => {
      await benny.close();
    });
    return benny;
  });
}

test("benny-events-01 slack report persists pending with one wake line", async (t) => {
  const stateDir = tempDir("pstack-benny-events-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const config = { routes: [{ channel: "C_SOURCE", intent: "repro" }], defaultIntent: "triage" };
  const store = storeFor(stateDir, wakeFile);
  const benny = await withServer(t, {
    store,
    config,
    token: TEST_TOKEN,
    signingSecret: "",
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
  });
  t.after(() => cleanupDir(stateDir));

  const body = slackBody();
  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  assert.equal(posted.status, 202);
  assert.equal(posted.json.state, "pending");
  assert.equal(posted.json.intent, "repro");

  const record = store.loadEvent(posted.json.eventId);
  assert.equal(record.state, "pending");
  assert.equal(record.channel, "C_SOURCE");
  assert.equal(record.threadTs, body.event.ts);
  assert.equal(record.receivedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(typeof record.wakeAppendedAt, "string");

  const lines = readWakeLines(wakeFile);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).toSorted(), ["intent", "payload", "ts"]);
  assert.equal(lines[0].intent, "repro");
  assert.equal(new Date(lines[0].ts).toISOString(), lines[0].ts);
  assert.equal(lines[0].payload.channel, "C_SOURCE");
  assert.equal(lines[0].payload.threadTs, body.event.ts);
  assert.equal(readFileSync(wakeFile, "utf8").endsWith("\n"), true);

  const reply = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: slackBody({ event: { thread_ts: "1700000000.000100", ts: "1700000005.000200" } }),
  });
  const replyRecord = store.loadEvent(reply.json.eventId);
  assert.equal(reply.status, 202);
  assert.equal(replyRecord.threadTs, "1700000000.000100");
});

test("benny-events-02 duplicate source event is idempotent", async (t) => {
  const stateDir = tempDir("pstack-benny-dupe-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const benny = await withServer(t, {
    store: storeFor(stateDir, wakeFile),
    config: { routes: [], defaultIntent: "triage" },
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const body = slackBody();
  const first = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  const second = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(second.json.eventId, first.json.eventId);
  assert.equal(second.json.state, "pending");
  assert.equal(readWakeLines(wakeFile).length, 1);
  assert.equal(readdirSync(join(stateDir, "events")).length, 1);
});

test("benny-events-03 config write preserves unknown user keys", async (t) => {
  const configDir = tempDir("pstack-benny-config-");
  t.after(() => cleanupDir(configDir));
  const path = configFixture(configDir, {
    myLocalKey: { keep: true, nested: [1, 2] },
    routes: [{ channel: "C_OLD", intent: "ignore" }],
  });
  const { writeConfig } = await import("../../services/benny/routing.mjs");

  const merged = writeConfig({ routes: [{ channel: "C_SOURCE", intent: "repro" }] }, { dir: configDir });
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.myLocalKey.keep, true);
  assert.deepEqual(onDisk.myLocalKey.nested, [1, 2]);
  assert.equal(onDisk.routes[0].channel, "C_SOURCE");
  assert.equal(onDisk.routes[0].intent, "repro");
  assert.equal(onDisk.defaultIntent, "triage");
  assert.equal(merged.defaultIntent, "triage");

  writeFileSync(path, `${JSON.stringify({ ...onDisk, userNote: "keep me" }, null, 2)}\n`, "utf8");
  writeConfig({ defaultIntent: "repro" }, { dir: configDir });
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after.userNote, "keep me");
  assert.equal(after.defaultIntent, "repro");
  assert.equal(after.routes[0].channel, "C_SOURCE");
});

test("benny-events-04 pending event survives a restart", async (t) => {
  const stateDir = tempDir("pstack-benny-restart-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const config = { routes: [], defaultIntent: "triage" };
  const first = await withServer(t, {
    store: storeFor(stateDir, wakeFile),
    config,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  const body = slackBody();
  const posted = await request(first.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  await first.close();

  const second = await withServer(t, {
    store: storeFor(stateDir, wakeFile),
    config,
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(async () => {
    await second.close();
    cleanupDir(stateDir);
  });
  const listed = await request(second.base, "/v1/benny/events?state=pending", { token: TEST_TOKEN });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.events[0].eventId, posted.json.eventId);
  assert.equal(listed.json.events[0].state, "pending");

  const redelivered = await request(second.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  assert.equal(redelivered.status, 200);
  assert.equal(readWakeLines(wakeFile).length, 1);
});

test("benny-events-05 test event returns the normalized record without enqueuing", async (t) => {
  const stateDir = tempDir("pstack-benny-test-event-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const benny = await withServer(t, {
    store: storeFor(stateDir, wakeFile),
    config: { routes: [{ channel: "C_SOURCE", intent: "triage" }], defaultIntent: "triage" },
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const verified = await request(benny.base, "/v1/benny/test-event", {
    method: "POST",
    token: TEST_TOKEN,
    body: slackBody(),
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.enqueued, false);
  assert.equal(verified.json.record.source, "slack");
  assert.equal(verified.json.record.channel, "C_SOURCE");
  assert.equal(verified.json.record.intent, "triage");
  assert.equal(verified.json.record.state, undefined);

  assert.equal(existsSync(wakeFile), false);
  assert.equal(existsSync(join(stateDir, "events")), false);
  const listed = await request(benny.base, "/v1/benny/events", { token: TEST_TOKEN });
  assert.equal(listed.json.count, 0);
});

test("benny-events-06 generic hook normalizes and enqueues", async (t) => {
  const stateDir = tempDir("pstack-benny-hook-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const benny = await withServer(t, {
    store: storeFor(stateDir, wakeFile),
    config: { routes: [{ channel: "C_OPS", intent: "repro" }], defaultIntent: "triage" },
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const eventId = `hook-${Math.random().toString(36).slice(2, 10)}`;
  const posted = await request(benny.base, "/v1/hooks/make-bot-ui", {
    method: "POST",
    token: TEST_TOKEN,
    body: { eventId, payload: { channel: "C_OPS", threadTs: "1.5", text: "deploy failed", user: "U_OPS" } },
  });
  assert.equal(posted.status, 202);
  assert.equal(posted.json.intent, "repro");

  const lines = readWakeLines(wakeFile);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].payload.source, "make-bot-ui");
  assert.equal(lines[0].payload.threadTs, "1.5");
  assert.equal(lines[0].payload.text, "deploy failed");

  const duplicate = await request(benny.base, "/v1/hooks/make-bot-ui", {
    method: "POST",
    token: TEST_TOKEN,
    body: { eventId, payload: { channel: "C_OPS", threadTs: "1.5", text: "deploy failed", user: "U_OPS" } },
  });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.eventId, posted.json.eventId);
  assert.equal(readWakeLines(wakeFile).length, 1);
});

test("benny-events-07 stored records and responses carry no secret", async (t) => {
  const stateDir = tempDir("pstack-benny-secret-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const store = storeFor(stateDir, wakeFile);
  const benny = await withServer(t, {
    store,
    config: { routes: [{ channel: "C_SOURCE", intent: "triage" }], defaultIntent: "triage" },
    token: TEST_TOKEN,
    signingSecret: TEST_SIGNING_SECRET,
  });
  t.after(() => cleanupDir(stateDir));

  const body = slackBody();
  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  assert.equal(posted.status, 202);
  const listed = await request(benny.base, "/v1/benny/events?state=pending", { token: TEST_TOKEN });
  const acked = await request(benny.base, `/v1/benny/events/${posted.json.eventId}/ack`, { method: "POST", token: TEST_TOKEN });
  assert.equal(acked.status, 200);
  assert.equal(acked.json.state, "processed");

  const responses = [posted.text, listed.text, acked.text, JSON.stringify(store.loadEvent(posted.json.eventId))];
  for (const text of responses) {
    assert.equal(text.includes(TEST_TOKEN), false);
    assert.equal(text.includes(TEST_SIGNING_SECRET), false);
  }
  const files = readdirSync(join(stateDir, "events"));
  assert.equal(files.length, 1);
  const stored = readFileSync(join(stateDir, "events", files[0]), "utf8");
  assert.equal(stored.includes(TEST_TOKEN), false);
  assert.equal(stored.includes(TEST_SIGNING_SECRET), false);
  assert.equal(stored.includes(body.event_id), false);
  assert.equal(readWakeLines(wakeFile)[0].payload.sourceEventId, undefined);
});

test("benny-events-08 slack url verification echoes the challenge", async (t) => {
  const stateDir = tempDir("pstack-benny-challenge-");
  const wakeFile = join(stateDir, "wakes.jsonl");
  const benny = await withServer(t, {
    store: storeFor(stateDir, wakeFile),
    config: { routes: [], defaultIntent: "triage" },
    token: TEST_TOKEN,
    signingSecret: "",
  });
  t.after(() => cleanupDir(stateDir));

  const verified = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: { type: "url_verification", challenge: "challenge-abc" },
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.json.challenge, "challenge-abc");
  assert.equal(existsSync(wakeFile), false);
  assert.equal(existsSync(join(stateDir, "events")), false);
});
