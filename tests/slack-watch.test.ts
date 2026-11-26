import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { test } from "vitest";

import { readEvent, readJob } from "../src/jobs/job-input.ts";
import type { SlackTrigger } from "../src/jobs/job-input.ts";
import {
  claimState,
  pollOnce,
  slackHistory,
  type SlackMessage,
  startRun,
  watchedJobs,
  type WatchIo,
} from "../src/jobs/slack-watch.ts";
import { sandbox } from "./host.ts";
import { shaped } from "./support.ts";

const watchModule = fileURLToPath(new URL("../src/jobs/slack-watch.ts", import.meta.url));

const folder = () => mkdtemp(join(sandbox, "slack-watch-"));
const benny = (channel: string) => ({
  version: 1,
  enabled: true,
  kind: "benny-triage",
  cwd: "/tmp",
  tools: ["read", "mcp__slack__*"],
  instructions: "triage",
  config: { sourceChannel: channel, defaultBranch: "main" },
});

function fakeIo(history: Record<string, SlackMessage[]>) {
  const asked: [string, string][] = [];
  const started: [string, SlackTrigger][] = [];
  const io: WatchIo = {
    history: async (channel, oldest) => {
      asked.push([channel, oldest]);
      return history[channel] ?? [];
    },
    dispatch: async (job, trigger) => {
      started.push([job, trigger]);
    },
    now: () => 1_700_000_000_000,
  };
  return { io, asked, started };
}

test("a channel seen for the first time starts from now and replays nothing", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  const { io, asked, started } = fakeIo({ C1: [{ ts: "1.000001" }] });
  assert.deepEqual(await pollOnce([{ path: "a.json", channel: "C1" }], state, io), []);
  assert.deepEqual(asked, []);
  assert.deepEqual(started, []);
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {
    channels: { C1: "1700000000.000000" },
  });
});

test("each new top-level report starts every job on its channel once, oldest first", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  await writeFile(state, JSON.stringify({ channels: { C1: "100.000001", C2: "5.0" } }));
  const { io, asked, started } = fakeIo({
    C1: [
      { ts: "100.000300" },
      { ts: "100.000250", thread_ts: "100.000200" },
      { ts: "100.000200", subtype: "channel_join" },
      { ts: "100.000150", subtype: "file_share" },
      { ts: "100.000120", thread_ts: "100.000120" },
      { ts: "100.000001" },
    ],
  });
  const jobs = [
    { path: "triage.json", channel: "C1" },
    { path: "repro.json", channel: "C1" },
    { path: "other.json", channel: "C2" },
  ];
  const result = await pollOnce(jobs, state, io);
  assert.deepEqual(asked, [
    ["C1", "100.000001"],
    ["C2", "5.0"],
  ]);
  const order = ["100.000120", "100.000150", "100.000300"];
  assert.deepEqual(
    result,
    order.flatMap((ts) => [
      { job: "triage.json", ts },
      { job: "repro.json", ts },
    ]),
  );
  assert.deepEqual(started[0], [
    "triage.json",
    { source_channel_id: "C1", message_ts: "100.000120", ts: "100.000120", thread_ts: "" },
  ]);
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {
    channels: { C1: "100.000300", C2: "5.0" },
  });
});

test("an unreadable state file stops the watcher instead of replaying history", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  await writeFile(state, "{");
  await assert.rejects(pollOnce([], state, fakeIo({}).io), /Invalid JSON/);
  for (const saved of ["[]", '{"channels":{"C1":123}}', '{"channels":[]}']) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each case rewrites the same file.
    await writeFile(state, saved);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each case rewrites the same file.
    await assert.rejects(
      pollOnce([{ path: "a.json", channel: "C1" }], state, fakeIo({}).io),
      /Invalid watcher state/,
    );
  }
});

test("history reads every page of conversations.history with the token", async () => {
  const urls: URL[] = [];
  const pages = [
    {
      ok: true,
      messages: [{ ts: "2" }, "noise", { ts: 3 }],
      response_metadata: { next_cursor: "n" },
    },
    { ok: true, messages: [{ ts: "1", subtype: "file_share" }] },
  ];
  const fetcher = shaped<typeof fetch>(async (url: string, init: RequestInit) => {
    urls.push(new URL(url));
    assert.deepEqual(init.headers, { authorization: "Bearer xoxb-t" });
    return new Response(JSON.stringify(pages[urls.length - 1]));
  });
  const messages = await slackHistory("xoxb-t", fetcher)("C1", "0.5");
  assert.deepEqual(messages, [{ ts: "2" }, { ts: "1", subtype: "file_share" }]);
  assert.equal(urls[0]?.pathname, "/api/conversations.history");
  assert.equal(urls[0]?.searchParams.get("oldest"), "0.5");
  assert.equal(urls[1]?.searchParams.get("cursor"), "n");
});

const reply = (body: string, status = 200) =>
  slackHistory(
    "t",
    shaped<typeof fetch>(async () => new Response(body, { status })),
  );
test("a Slack error names Slack's reason or the HTTP status", async () => {
  await assert.rejects(reply('{"ok":false,"error":"not_in_channel"}')("C1", "0"), /not_in_channel/);
  await assert.rejects(reply("[]", 502)("C1", "0"), /failed: 502/);
});

test("a started run gets a signed trigger its job accepts, in the background", async () => {
  const dir = await folder();
  const job = join(dir, "benny-triage.job.json");
  await writeFile(job, JSON.stringify(benny("C1")));
  const launched: { args: readonly string[]; options: object; unref: boolean }[] = [];
  const launch = shaped<typeof spawn>((_bin: string, args: readonly string[], options: object) => {
    const entry = { args, options, unref: false };
    launched.push(entry);
    const child = Object.assign(new EventEmitter(), { unref: () => (entry.unref = true) });
    setImmediate(() => child.emit("spawn"));
    return child;
  });
  const trigger = { source_channel_id: "C1", message_ts: "9.1", ts: "9.1", thread_ts: "" };
  await startRun("secret", launch)(job, trigger);
  const [run] = launched;
  assert.deepEqual(run?.options, { detached: true, stdio: "ignore" });
  assert(run?.unref);
  const [script, flag, path, event] = run?.args ?? [];
  assert(script?.endsWith("run-job.mjs"));
  assert.deepEqual([flag, path], ["--run", job]);
  assert.equal(event, join(dir, "events", "benny-triage.job-9.1.json"));
  assert.deepEqual(await readEvent(await readJob(job), event, "secret"), trigger);
});

test("only Benny jobs can be watched", async () => {
  const dir = await folder();
  const triage = join(dir, "triage.json");
  const custom = join(dir, "custom.json");
  await writeFile(triage, JSON.stringify(benny("C9")));
  await writeFile(custom, JSON.stringify({ ...benny("C9"), kind: "custom" }));
  assert.deepEqual(await watchedJobs([triage]), [{ path: triage, channel: "C9" }]);
  await assert.rejects(watchedJobs([custom]), /is not a Benny job/);
});

test("a channel's first cursor is saved even when another channel's poll fails", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  await writeFile(state, JSON.stringify({ channels: { C2: "5.0" } }));
  const { io } = fakeIo({});
  const failing = { ...io, history: async () => Promise.reject(Error("ratelimited")) };
  const jobs = [
    { path: "new.json", channel: "C1" },
    { path: "old.json", channel: "C2" },
  ];
  await assert.rejects(pollOnce(jobs, state, failing), /ratelimited/);
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {
    channels: { C2: "5.0", C1: "1700000000.000000" },
  });
});

test("the cursor file is replaced whole, never rewritten in place", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  await writeFile(state, JSON.stringify({ channels: { C1: "1.0" } }));
  const before = (await stat(state)).ino;
  await pollOnce([{ path: "a.json", channel: "C1" }], state, fakeIo({ C1: [{ ts: "2.0" }] }).io);
  assert.notEqual((await stat(state)).ino, before);
  assert.deepEqual(await readdir(dir), ["watch-state.json"], "no temporary file is left");
});

test("the cursor moves past messages that are not reports", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  await writeFile(state, JSON.stringify({ channels: { C1: "1.0" } }));
  const { io, started } = fakeIo({ C1: [{ ts: "3.0", subtype: "channel_join" }, { ts: "2.0" }] });
  await pollOnce([{ path: "a.json", channel: "C1" }], state, io);
  assert.equal(started.length, 1);
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), { channels: { C1: "3.0" } });
});

test("a cursor moved past non-reports is saved even when a later channel's poll fails", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  await writeFile(state, JSON.stringify({ channels: { C1: "1.0", C2: "1.0" } }));
  const io: WatchIo = {
    ...fakeIo({}).io,
    history: async (channel) =>
      channel === "C1" ? [{ ts: "2.0", subtype: "channel_join" }] : Promise.reject(Error("down")),
  };
  const jobs = [
    { path: "a.json", channel: "C1" },
    { path: "b.json", channel: "C2" },
  ];
  await assert.rejects(pollOnce(jobs, state, io), /down/);
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {
    channels: { C1: "2.0", C2: "1.0" },
  });
});

test("a run that cannot be spawned fails its dispatch, so the report is not marked seen", async () => {
  const dir = await folder();
  const job = join(dir, "benny-triage.job.json");
  await writeFile(job, JSON.stringify(benny("C1")));
  const launch = shaped<typeof spawn>(() => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    setImmediate(() =>
      child.emit("error", Object.assign(Error("spawn EAGAIN"), { code: "EAGAIN" })),
    );
    return child;
  });
  const trigger = { source_channel_id: "C1", message_ts: "9.1", ts: "9.1", thread_ts: "" };
  await assert.rejects(startRun("secret", launch)(job, trigger), /EAGAIN/);
});

test("a new channel gets its starting cursor even when an earlier channel's poll fails", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  await writeFile(state, JSON.stringify({ channels: { A: "1.0" } }));
  const io: WatchIo = { ...fakeIo({}).io, history: async () => Promise.reject(Error("down")) };
  const jobs = [
    { path: "a.json", channel: "A" },
    { path: "b.json", channel: "B" },
  ];
  await assert.rejects(pollOnce(jobs, state, io), /down/);
  assert.deepEqual(JSON.parse(await readFile(state, "utf8")), {
    channels: { A: "1.0", B: "1700000000.000000" },
  });
});

test("one watcher owns a state file at a time, and the claim ends with its process", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  const release = await claimState(state);
  await assert.rejects(claimState(state), /Another watcher uses/);
  await assert.rejects(claimState(state), /Another watcher uses/);
  await release();
  const again = await claimState(state);
  await again();
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(watchModule)}).then(m => m.claimState(${JSON.stringify(state)})).then(() => { console.log("claimed"); setTimeout(() => {}, 60000); })`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(holder.stdout, "data");
  await assert.rejects(claimState(state), /Another watcher uses/);
  holder.kill("SIGKILL");
  await once(holder, "exit");
  const afterCrash = await claimState(state);
  await afterCrash();
});

test("two watchers claiming at once never both win", async () => {
  const dir = await folder();
  const state = join(dir, "watch-state.json");
  for (let round = 0; round < 20; round += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each round races three claims.
    const claims = await Promise.allSettled([
      claimState(state),
      claimState(state),
      claimState(state),
    ]);
    const won = claims.flatMap((c) => (c.status === "fulfilled" ? [c.value] : []));
    assert.equal(won.length, 1, `round ${round}`);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Release before the next round.
    await Promise.all(won.map((release) => release()));
  }
});

test("a watcher's claim covers the state file under every path that reaches it", async () => {
  const dir = await folder();
  const alias = `${dir}-alias`;
  await symlink(dir, alias);
  const release = await claimState(join(dir, "watch-state.json"));
  await assert.rejects(claimState(join(alias, "watch-state.json")), /Another watcher uses/);
  await release();
});
