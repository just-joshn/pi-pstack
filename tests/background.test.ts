import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { test } from "vitest";

import { host, notARepository } from "./host.ts";
import { flag, shaped } from "./support.ts";

interface Listed {
  id: string;
  state: string;
  report: string;
  lastActivity: string | null;
}
interface Started {
  background: { id: string; sessionDir: string }[];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A host whose workers run until the test releases them by id, or until they are stopped. */
function longRunningWorkers() {
  const release = new Map<string, () => void>();
  const timeouts: (number | undefined)[] = [];
  const h = host({
    execute: async (bin, args, options) => {
      if (bin === "git") return notARepository;
      timeouts.push(options?.timeout);
      await writeFile(join(flag(args, "--session-dir") ?? "", "session.jsonl"), "{}");
      await new Promise<void>((resolve, reject) => {
        release.set(flag(args, "--session-id") ?? "", resolve);
        options?.signal?.addEventListener("abort", () => reject(Error("killed")));
      });
      return { code: 0, stdout: "owner report", stderr: "" };
    },
  });
  const call = async <T>(tool: string, params: object) =>
    shaped<T>(JSON.parse((await h.call(tool, params)).content[0]?.text ?? ""));
  const list = (action = "list", id?: string) => call<Listed[]>("pstack_workers", { action, id });
  return { call, list, release, timeouts };
}

const states = (listed: Listed[]) => new Map(listed.map((w) => [w.id, w.state]));

test("background workers return at once, keep running, and can be listed and stopped", async () => {
  const { call, list, release, timeouts } = longRunningWorkers();
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
    timeouts.every((t) => (t ?? 0) > 24 * 60 * 60 * 1000),
    "no 30-minute cap",
  );

  await list("stop", one);
  release.get(two)?.();
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
    shaped<Listed[]>(
      JSON.parse((await h.call("pstack_workers", { action: "list" })).content[0]?.text ?? ""),
    );
  assert.deepEqual(await list(), []);
  await h.call("pstack_delegate", { mode: "single", tasks: ["review"] });
  const [finished] = await list();
  assert.equal(finished?.state, "finished");
  const empty = join(h.artifacts, "workers", "batch", "worker-9-empty");
  await mkdir(empty, { recursive: true });
  const listed = await list();
  assert.equal(listed.length, 2);
  assert.equal(listed.at(-1)?.lastActivity, null);
  await rm(join(h.artifacts, "workers"), { recursive: true });
  await writeFile(join(h.artifacts, "workers"), "not a folder");
  await assert.rejects(list, /ENOTDIR/);
});
