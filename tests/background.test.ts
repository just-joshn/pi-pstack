import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { test } from "vitest";

import { backgroundWorkers, listWorkers } from "../src/background.ts";
import { busyPaths } from "../src/worktrees.ts";
import { host, notARepository, readResult } from "./host.ts";
import { flag, shaped } from "./support.ts";

interface Listed {
  id: string;
  state: string;
  error?: string;
  report: string;
  lastActivity: string | null;
}
interface Started {
  background: { id: string; sessionDir: string }[];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function longRunningWorkers() {
  const release = new Map<string, () => void>();
  const timeouts: (number | undefined)[] = [];
  const h = host({
    execute: async (bin, args, options) => {
      if (bin === "git") return notARepository;
      timeouts.push(options?.timeout);
      const released = new Promise<void>((resolve, reject) => {
        release.set(flag(args, "--session-id") ?? "", resolve);
        options?.signal?.addEventListener("abort", () => reject(Error("killed")));
      });
      await writeFile(join(flag(args, "--session-dir") ?? "", "session.jsonl"), "{}");
      await released;
      return { code: 0, stdout: "owner report", stderr: "" };
    },
  });
  const call = async <T>(tool: string, params: object) =>
    shaped<T>(readResult(await h.call(tool, params)));
  const list = (action = "list", id?: string) => call<Listed[]>("pstack_workers", { action, id });
  const finish = async (id: string) => {
    const deadline = Date.now() + 4000;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the worker's process to start.
    while (!release.has(id) && Date.now() < deadline) await settle();
    release.get(id)?.();
  };
  const waiting = (id: string) => release.has(id);
  return { call, list, finish, waiting, timeouts, artifacts: h.artifacts };
}

const states = (listed: Listed[]) => new Map(listed.map((w) => [w.id, w.state]));

async function listedAs(list: () => Promise<Listed[]>, expected: Map<string, string>) {
  const deadline = Date.now() + 4000;
  let actual = states(await list());
  while (!isDeepStrictEqual(actual, expected) && Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each check waits for the workers to move on.
    await settle();
    // oxlint-disable-next-line eslint/no-await-in-loop -- The next check needs a fresh listing.
    actual = states(await list());
  }
  assert.deepEqual(actual, expected);
}

test("background workers return at once, keep running, and can be listed and stopped", async () => {
  const { call, list, finish, timeouts } = longRunningWorkers();
  const started = await call<Started>("pstack_delegate", {
    mode: "swarm",
    tasks: ["own PR 1", "own PR 2"],
    background: true,
  });
  const [one = "", two = ""] = started.background.map((w) => w.id);
  await settle();
  assert.deepEqual(
    states(await list()),
    new Map([
      [one, "running"],
      [two, "running"],
    ]),
  );
  assert(
    timeouts.every((t) => t === undefined),
    "no time limit",
  );

  await list("stop", one);
  await finish(two);
  await settle();
  const after = await list();
  assert.deepEqual(
    states(after),
    new Map([
      [one, "stopped"],
      [two, "done"],
    ]),
  );
  const done = after.find((w) => w.id === two);
  assert.equal(await readFile(done?.report ?? "", "utf8"), "owner report");
  assert(done?.lastActivity);
  await assert.rejects(() => list("stop", two), /No running background worker/);
});

test("background is for single and swarm workers", async () => {
  const h = host();
  await assert.rejects(
    () => h.call("pstack_delegate", { mode: "interrogate", tasks: ["review"], background: true }),
    /Background workers take mode single or swarm/,
  );
});

test("the list covers every worker of the session, foreground ones included", async () => {
  const h = host({
    execute: async (bin) => (bin === "git" ? notARepository : { code: 0, stdout: "r", stderr: "" }),
  });
  const list = async () =>
    shaped<Listed[]>(readResult(await h.call("pstack_workers", { action: "list" })));
  assert.deepEqual(await list(), []);
  await h.call("pstack_delegate", { mode: "single", tasks: ["review"] });
  const [finished] = await list();
  assert.equal(finished?.state, "done");
  const empty = join(h.artifacts, "workers", "batch", "worker-9-empty");
  await mkdir(empty, { recursive: true });
  const listed = await list();
  assert.equal(listed.length, 2);
  assert.equal(listed.at(-1)?.lastActivity, null);
  await rm(join(h.artifacts, "workers"), { recursive: true });
  await writeFile(join(h.artifacts, "workers"), "not a folder");
  await assert.rejects(list, /ENOTDIR/);
});

test("a background swarm runs at most `concurrency` workers at once and lists the rest queued", async () => {
  const { call, list, finish } = longRunningWorkers();
  const started = await call<Started>("pstack_delegate", {
    mode: "swarm",
    tasks: ["first", "second"],
    background: true,
    concurrency: 1,
  });
  const [one = "", two = ""] = started.background.map((w) => w.id);
  await listedAs(
    list,
    new Map([
      [one, "running"],
      [two, "queued"],
    ]),
  );
  await finish(one);
  await listedAs(
    list,
    new Map([
      [one, "done"],
      [two, "running"],
    ]),
  );
  await finish(two);
  await listedAs(
    list,
    new Map([
      [one, "done"],
      [two, "done"],
    ]),
  );
});

test("a background worker that fails before its session exists is listed with its error", async () => {
  const { call, list } = longRunningWorkers();
  const started = await call<Started>("pstack_delegate", {
    mode: "single",
    tasks: ["edit"],
    readOnly: false,
    background: true,
  });
  await settle();
  const [worker] = await list();
  assert.equal(worker?.id, started.background[0]?.id);
  assert.equal(worker?.state, "failed");
  assert.match(worker?.error ?? "", /git/);
});

test("a running worker cannot be resumed until it exits", async () => {
  const { call, finish, waiting } = longRunningWorkers();
  const started = await call<Started>("pstack_delegate", {
    mode: "single",
    tasks: ["work"],
    background: true,
  });
  const [worker] = started.background;
  const id = worker?.id ?? "";
  const deadline = Date.now() + 4000;
  // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the worker's process to start.
  while (!waiting(id) && Date.now() < deadline) await settle();
  const resume = { mode: "single", tasks: ["more"], resume: worker?.sessionDir };
  await assert.rejects(() => call("pstack_delegate", resume), /is still running/);
  await finish(id);
});

test("workers a closed session left queued or running are listed as interrupted", async () => {
  const { call, artifacts } = longRunningWorkers();
  await call<Started>("pstack_delegate", {
    mode: "swarm",
    tasks: ["one", "two"],
    background: true,
    concurrency: 1,
  });
  await settle();
  const after = await listWorkers(join(artifacts, "workers"), backgroundWorkers(), busyPaths());
  assert.deepEqual(
    after.map((w) => w.state),
    ["interrupted", "interrupted"],
  );
});

test("a running foreground worker is listed as running, and arena folders are not workers", async () => {
  const gate = Promise.withResolvers<void>();
  const h = host({
    execute: async (bin, args) => {
      if (bin === "git") return notARepository;
      await writeFile(join(flag(args, "--session-dir") ?? "", "session.jsonl"), "{}");
      await gate.promise;
      return { code: 0, stdout: "r", stderr: "" };
    },
  });
  const list = async () =>
    shaped<Listed[]>(readResult(await h.call("pstack_workers", { action: "list" })));
  const running = h.call("pstack_delegate", { mode: "single", tasks: ["work"] });
  await settle();
  assert.deepEqual(
    (await list()).map((w) => w.state),
    ["running"],
  );
  gate.resolve();
  await running;
  const [batch = ""] = await readdir(join(h.artifacts, "workers"));
  await mkdir(join(h.artifacts, "workers", batch, "blinded"));
  assert.deepEqual(
    (await list()).map((w) => w.state),
    ["done"],
  );
});

test("a queued worker that is stopped leaves the queue at once and never starts", async () => {
  const { call, list, finish, waiting } = longRunningWorkers();
  const started = await call<Started>("pstack_delegate", {
    mode: "swarm",
    tasks: ["first", "second"],
    background: true,
    concurrency: 1,
  });
  const [one = "", two = ""] = started.background.map((w) => w.id);
  await listedAs(
    list,
    new Map([
      [one, "running"],
      [two, "queued"],
    ]),
  );
  await list("stop", two);
  assert.equal(states(await list()).get(two), "stopped");
  await finish(one);
  await listedAs(
    list,
    new Map([
      [one, "done"],
      [two, "stopped"],
    ]),
  );
  assert(!waiting(two), "the stopped worker never started");
});

test("a foreground worker is listed done or failed, with its error", async () => {
  let code = 0;
  const h = host({
    execute: async (bin) =>
      bin === "git" ? notARepository : { code, stdout: "report", stderr: "boom" },
  });
  const list = async () =>
    shaped<Listed[]>(readResult(await h.call("pstack_workers", { action: "list" })));
  await h.call("pstack_delegate", { mode: "single", tasks: ["works"] });
  code = 3;
  await h.call("pstack_delegate", { mode: "single", tasks: ["breaks"] });
  const listed = await list();
  assert.deepEqual(listed.map((w) => w.state).toSorted(), ["done", "failed"]);
  assert.match(listed.find((w) => w.state === "failed")?.error ?? "", /failed \(3\)/);
});
