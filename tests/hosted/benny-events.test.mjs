import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
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
    t.onTestFinished(async () => {
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const body = slackBody();
  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  expect(posted.status).toBe(202);
  expect(posted.json.state).toBe("pending");
  expect(posted.json.intent).toBe("repro");

  const record = store.loadEvent(posted.json.eventId);
  expect(record.state).toBe("pending");
  expect(record.channel).toBe("C_SOURCE");
  expect(record.threadTs).toBe(body.event.ts);
  expect(record.receivedAt).toBe("2026-01-02T03:04:05.000Z");
  expect(typeof record.wakeAppendedAt).toBe("string");

  const lines = readWakeLines(wakeFile);
  expect(lines.length).toBe(1);
  expect(Object.keys(lines[0]).toSorted()).toEqual(["intent", "payload", "ts"]);
  expect(lines[0].intent).toBe("repro");
  expect(new Date(lines[0].ts).toISOString()).toBe(lines[0].ts);
  expect(lines[0].payload.channel).toBe("C_SOURCE");
  expect(lines[0].payload.threadTs).toBe(body.event.ts);
  expect(readFileSync(wakeFile, "utf8").endsWith("\n")).toBe(true);

  const reply = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: slackBody({ event: { thread_ts: "1700000000.000100", ts: "1700000005.000200" } }),
  });
  const replyRecord = store.loadEvent(reply.json.eventId);
  expect(reply.status).toBe(202);
  expect(replyRecord.threadTs).toBe("1700000000.000100");
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const body = slackBody();
  const first = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  const second = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  expect(first.status).toBe(202);
  expect(second.status).toBe(200);
  expect(second.json.eventId).toBe(first.json.eventId);
  expect(second.json.state).toBe("pending");
  expect(readWakeLines(wakeFile).length).toBe(1);
  expect(readdirSync(join(stateDir, "events")).length).toBe(1);
});

test("benny-events-03 config write preserves unknown user keys", async (t) => {
  const configDir = tempDir("pstack-benny-config-");
  t.onTestFinished(() => cleanupDir(configDir));
  const path = configFixture(configDir, {
    myLocalKey: { keep: true, nested: [1, 2] },
    routes: [{ channel: "C_OLD", intent: "ignore" }],
  });
  const { writeConfig } = await import("../../services/benny/routing.mjs");

  const merged = writeConfig({ routes: [{ channel: "C_SOURCE", intent: "repro" }] }, { dir: configDir });
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  expect(onDisk.myLocalKey.keep).toBe(true);
  expect(onDisk.myLocalKey.nested).toEqual([1, 2]);
  expect(onDisk.routes[0].channel).toBe("C_SOURCE");
  expect(onDisk.routes[0].intent).toBe("repro");
  expect(onDisk.defaultIntent).toBe("triage");
  expect(merged.defaultIntent).toBe("triage");

  writeFileSync(path, `${JSON.stringify({ ...onDisk, userNote: "keep me" }, null, 2)}\n`, "utf8");
  writeConfig({ defaultIntent: "repro" }, { dir: configDir });
  const after = JSON.parse(readFileSync(path, "utf8"));
  expect(after.userNote).toBe("keep me");
  expect(after.defaultIntent).toBe("repro");
  expect(after.routes[0].channel).toBe("C_SOURCE");
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
  t.onTestFinished(async () => {
    await second.close();
    cleanupDir(stateDir);
  });
  const listed = await request(second.base, "/v1/benny/events?state=pending", { token: TEST_TOKEN });
  expect(listed.status).toBe(200);
  expect(listed.json.count).toBe(1);
  expect(listed.json.events[0].eventId).toBe(posted.json.eventId);
  expect(listed.json.events[0].state).toBe("pending");

  const redelivered = await request(second.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  expect(redelivered.status).toBe(200);
  expect(readWakeLines(wakeFile).length).toBe(1);
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const verified = await request(benny.base, "/v1/benny/test-event", {
    method: "POST",
    token: TEST_TOKEN,
    body: slackBody(),
  });
  expect(verified.status).toBe(200);
  expect(verified.json.enqueued).toBe(false);
  expect(verified.json.record.source).toBe("slack");
  expect(verified.json.record.channel).toBe("C_SOURCE");
  expect(verified.json.record.intent).toBe("triage");
  expect(verified.json.record.state).toBe(undefined);

  expect(existsSync(wakeFile)).toBe(false);
  expect(existsSync(join(stateDir, "events"))).toBe(false);
  const listed = await request(benny.base, "/v1/benny/events", { token: TEST_TOKEN });
  expect(listed.json.count).toBe(0);
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const eventId = `hook-${Math.random().toString(36).slice(2, 10)}`;
  const posted = await request(benny.base, "/v1/hooks/make-bot-ui", {
    method: "POST",
    token: TEST_TOKEN,
    body: { eventId, payload: { channel: "C_OPS", threadTs: "1.5", text: "deploy failed", user: "U_OPS" } },
  });
  expect(posted.status).toBe(202);
  expect(posted.json.intent).toBe("repro");

  const lines = readWakeLines(wakeFile);
  expect(lines.length).toBe(1);
  expect(lines[0].payload.source).toBe("make-bot-ui");
  expect(lines[0].payload.threadTs).toBe("1.5");
  expect(lines[0].payload.text).toBe("deploy failed");

  const duplicate = await request(benny.base, "/v1/hooks/make-bot-ui", {
    method: "POST",
    token: TEST_TOKEN,
    body: { eventId, payload: { channel: "C_OPS", threadTs: "1.5", text: "deploy failed", user: "U_OPS" } },
  });
  expect(duplicate.status).toBe(200);
  expect(duplicate.json.eventId).toBe(posted.json.eventId);
  expect(readWakeLines(wakeFile).length).toBe(1);
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const body = slackBody();
  const posted = await request(benny.base, "/v1/benny/events", { method: "POST", body, token: TEST_TOKEN });
  expect(posted.status).toBe(202);
  const listed = await request(benny.base, "/v1/benny/events?state=pending", { token: TEST_TOKEN });
  const acked = await request(benny.base, `/v1/benny/events/${posted.json.eventId}/ack`, { method: "POST", token: TEST_TOKEN });
  expect(acked.status).toBe(200);
  expect(acked.json.state).toBe("processed");

  const responses = [posted.text, listed.text, acked.text, JSON.stringify(store.loadEvent(posted.json.eventId))];
  for (const text of responses) {
    expect(text.includes(TEST_TOKEN)).toBe(false);
    expect(text.includes(TEST_SIGNING_SECRET)).toBe(false);
  }
  const files = readdirSync(join(stateDir, "events"));
  expect(files.length).toBe(1);
  const stored = readFileSync(join(stateDir, "events", files[0]), "utf8");
  expect(stored.includes(TEST_TOKEN)).toBe(false);
  expect(stored.includes(TEST_SIGNING_SECRET)).toBe(false);
  expect(stored.includes(body.event_id)).toBe(false);
  expect(readWakeLines(wakeFile)[0].payload.sourceEventId).toBe(undefined);
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
  t.onTestFinished(() => cleanupDir(stateDir));

  const verified = await request(benny.base, "/v1/benny/events", {
    method: "POST",
    token: TEST_TOKEN,
    body: { type: "url_verification", challenge: "challenge-abc" },
  });
  expect(verified.status).toBe(200);
  expect(verified.json.challenge).toBe("challenge-abc");
  expect(existsSync(wakeFile)).toBe(false);
  expect(existsSync(join(stateDir, "events"))).toBe(false);
});
