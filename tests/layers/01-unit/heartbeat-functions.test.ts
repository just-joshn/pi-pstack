import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_MAX_FIRES,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_FIRES,
  MIN_INTERVAL_SECONDS,
  initialLoopState,
} from "../../../extensions/heartbeat/state.ts";
import {
  armLoop,
  createRun,
  dispatch,
  nextLoopId,
  startArmedLoop,
  stopAllLoops,
  stopLoop,
} from "../../../extensions/heartbeat/runtime.ts";
import {
  __testCoalesceMs,
  registerHeartbeat,
} from "../../../extensions/heartbeat/index.ts";

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakePi(execFn?: ExecFn) {
  let users: Array<{ text: string; opts: unknown }> = [];
  let customs: Array<{ customType: string; content: string; display: boolean }> = [];
  let signals: AbortSignal[] = [];
  const pi = {
    sendUserMessage(text: string, opts?: unknown) {
      users = [...users, { text, opts }];
    },
    sendMessage(payload: { customType: string; content: string; display: boolean }) {
      customs = [...customs, payload];
    },
    async exec(command: string, args: string[], opts?: { signal?: AbortSignal }) {
      if (opts?.signal) signals = [...signals, opts.signal];
      if (!execFn) return { code: 0, stdout: "", stderr: "" };
      return execFn(command, args);
    },
  };
  return { pi, users: () => users, customs: () => customs, signals: () => signals };
}

function liveList<T>() {
  let items: T[] = [];
  return {
    add: (item: T) => {
      items = [...items, item];
    },
    all: () => items,
  };
}

test("createRun starts with empty stores and nextLoopId counts up per run", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  assert.equal(run.loops.size, 0);
  assert.equal(run.resources.size, 0);
  assert.equal(run.seq, 0);
  assert.equal(nextLoopId(run), "loop-1");
  assert.equal(nextLoopId(run), "loop-2");
  assert.equal(run.seq, 2);
});

test("state constants keep their documented literals", () => {
  assert.equal(DEFAULT_INTERVAL_SECONDS, 1800);
  assert.equal(DEFAULT_MAX_FIRES, 50);
  assert.equal(COMMAND_MAX_FIRES, 100);
  assert.equal(MIN_INTERVAL_SECONDS, 5);
});

test("armLoop stores an interval loop with the documented defaults and a live timer", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  const state = armLoop(run, { id: "loop-a", prompt: "tick" });
  assert.deepEqual(state, {
    id: "loop-a",
    mode: "interval",
    prompt: "tick",
    basePrompt: "tick",
    intervalMs: 1800000,
    maxFires: 50,
    fires: 0,
    armed: true,
    watchArgv: [],
    lastFireAt: 0,
  });
  assert.equal(run.loops.get("loop-a"), state);
  assert.equal(run.resources.get("loop-a")?.timer !== undefined, true);
  assert.equal(run.resources.get("loop-a")?.watcherRunning, false);
  stopAllLoops(run);
  assert.equal(run.resources.size, 0);
});

test("armLoop rejects the deprecated watchCommand, a missing prompt, a bad mode, and an empty watcher argv", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  assert.throws(() => armLoop(run, { prompt: "x", watchCommand: "bash -lc echo hi" }), {
    message: "watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array",
  });
  assert.throws(() => armLoop(run, { mode: "interval" }), { message: "prompt required to arm" });
  assert.throws(() => armLoop(run, { mode: "cron", prompt: "x" }), {
    message: "mode must be interval|settle|watcher|dynamic",
  });
  assert.throws(() => armLoop(run, { id: "loop-w", mode: "watcher", prompt: "x" }), {
    message: "watchArgv required for mode=watcher",
  });
  assert.deepEqual([...run.loops.keys()], []);
  assert.deepEqual([...run.resources.keys()], []);
  assert.equal(run.seq, 1);
});

test("re-arming a live id disarms the prior loop and stores the new state", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  const first = armLoop(run, { id: "loop-r", prompt: "first", intervalSeconds: 3600 });
  const second = armLoop(run, { id: "loop-r", prompt: "second", intervalSeconds: 60 });
  assert.equal(first === second, false);
  assert.equal(first.armed, true);
  assert.equal(first.prompt, "first");
  assert.equal(run.loops.get("loop-r"), second);
  assert.equal(second.prompt, "second");
  assert.equal(second.intervalMs, 60000);
  assert.equal(run.loops.size, 1);
  assert.equal(run.resources.get("loop-r")?.timer !== undefined, true);
  stopAllLoops(run);
});

test("dispatch and startArmedLoop return undefined for an unknown loop id", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  assert.equal(dispatch(run, "loop-missing", { type: "tick", reason: "interval" }), undefined);
  assert.equal(startArmedLoop(run, "loop-missing"), undefined);
  assert.deepEqual(env.users(), []);
});

test("startArmedLoop arms a stored loop and returns that same state value", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  const state = initialLoopState({
    id: "loop-s",
    mode: "interval",
    prompt: "tick",
    intervalMs: 9000,
    maxFires: 2,
    watchArgv: [],
  });
  run.loops.set("loop-s", state);
  assert.equal(run.resources.has("loop-s"), false);
  const returned = startArmedLoop(run, "loop-s");
  assert.equal(returned, state);
  assert.equal(run.resources.get("loop-s")?.timer !== undefined, true);
  stopAllLoops(run);
});

test("a tick that exceeds maxFires stops the loop and announces it on the message channel", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-1", mode: "interval", prompt: "tick", intervalSeconds: 3600, maxFires: 1 });
  const fired = dispatch(run, "loop-1", { type: "tick", reason: "interval" });
  assert.equal(fired?.fires, 1);
  assert.equal(fired?.armed, true);
  assert.equal(fired?.lastFireReason, "interval");
  assert.deepEqual(env.users(), [
    { text: "[pstack_loop loop-1 fire 1/1 reason=interval]\ntick", opts: { deliverAs: "followUp" } },
  ]);
  const stopped = dispatch(run, "loop-1", { type: "tick", reason: "interval" });
  assert.equal(stopped?.fires, 2);
  assert.equal(stopped?.armed, false);
  assert.deepEqual(env.customs(), [
    {
      customType: "pstack-loop",
      content: "pstack_loop loop-1 stopped after 1 fires.",
      display: true,
    },
  ]);
  assert.equal(env.users().length, 1);
  assert.equal(run.loops.has("loop-1"), false);
  assert.equal(run.resources.has("loop-1"), false);
});

test("stopLoop disarms a stored loop and releases its timer and resources", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-d", prompt: "tick", intervalSeconds: 3600 });
  assert.equal(run.resources.get("loop-d")?.timer !== undefined, true);
  stopLoop(run, "loop-d");
  assert.equal(run.loops.has("loop-d"), false);
  assert.equal(run.resources.has("loop-d"), false);
});

test("stopAllLoops clears every loop and every resource", () => {
  const env = fakePi(() => new Promise<ExecResult>(() => {}));
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-a", prompt: "a", intervalSeconds: 3600 });
  armLoop(run, { id: "loop-b", mode: "watcher", prompt: "b", watchArgv: ["waiter-b"] });
  armLoop(run, { id: "loop-c", mode: "dynamic", prompt: "c", intervalSeconds: 3600, watchArgv: ["waiter-c"] });
  assert.equal(run.loops.size, 3);
  assert.equal(run.resources.size, 3);
  assert.equal(run.resources.get("loop-b")?.watcherRunning, true);
  stopAllLoops(run);
  assert.equal(run.loops.size, 0);
  assert.equal(run.resources.size, 0);
});

test("a watcher exit fires the loop with the watcher reason and keeps it armed", () => {
  const env = fakePi(() => new Promise<ExecResult>(() => {}));
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-w", mode: "watcher", prompt: "wake", watchArgv: ["watch-pr", "--status-only"], maxFires: 1 });
  const fired = dispatch(run, "loop-w", { type: "watcher-exit", code: 0, output: "READY" });
  assert.equal(fired?.fires, 1);
  assert.equal(fired?.armed, true);
  assert.equal(fired?.lastFireReason, "watcher");
  assert.deepEqual(env.users(), [
    {
      text: "[pstack_loop loop-w fire 1/1 reason=watcher]\nwake\n\n--- watcher output ---\nREADY",
      opts: { deliverAs: "followUp" },
    },
  ]);
  stopAllLoops(run);
  assert.equal(run.loops.size, 0);
});

test("an aborted parent signal aborts the watcher it started", async () => {
  const env = fakePi(() => new Promise<ExecResult>(() => {}));
  const run = createRun(env.pi as never);
  const parent = new AbortController();
  armLoop(run, { id: "loop-p", mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }, parent.signal);
  await flush();
  const watcherSignal = env.signals()[0];
  assert.equal(env.signals().length, 1);
  assert.equal(watcherSignal?.aborted, false);
  parent.abort();
  assert.equal(watcherSignal?.aborted, true);
  assert.equal(run.resources.get("loop-p")?.watcherRunning, true);
  stopAllLoops(run);
  assert.equal(run.loops.size, 0);
});

test("a watcher rejection whose value cannot be stringified still records the crash on the loop", async () => {
  const poison = Object.freeze({
    toString() {
      throw new Error("cannot stringify watcher failure");
    },
  }) as unknown as ExecResult;
  const env = fakePi(() => Promise.reject(poison));
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-p", mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] });
  await flush();
  await flush();
  const state = run.loops.get("loop-p");
  assert.equal(state?.armed, true);
  assert.equal(state?.fires, 1);
  assert.equal(state?.lastFireReason, "watcher-error");
  assert.deepEqual(env.users(), [
    {
      text: "[pstack_loop loop-p fire 1/50 reason=watcher-error]\nwake\n\n--- watcher failed ---\ncannot stringify watcher failure",
      opts: { deliverAs: "followUp" },
    },
  ]);
  stopAllLoops(run);
});

test("the pstack-loop command notifies the usage string for an argument it cannot parse", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notices = liveList<{ message: string; level: string }>();
  const pi = {
    on() {},
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, spec);
    },
    registerTool() {},
    sendUserMessage() {},
    sendMessage() {},
  };
  registerHeartbeat(pi as never);
  const handler = commands.get("pstack-loop")?.handler;
  assert.equal(typeof handler, "function");
  const ui = {
    notify(message: string, level: string) {
      notices.add({ message, level });
    },
  };
  await handler?.("not a loop argument", { ui });
  assert.deepEqual(notices.all(), [
    {
      message:
        "Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop status|list  |  /pstack-loop stop [id]  |  /pstack-loop off",
      level: "error",
    },
  ]);
});

test("__testCoalesceMs exposes the dynamic coalesce window used by the loop tool", () => {
  assert.equal(__testCoalesceMs(), 2500);
});
