import { expect, test } from "vitest";
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
  expect(run.loops.size).toBe(0);
  expect(run.resources.size).toBe(0);
  expect(run.seq).toBe(0);
  expect(nextLoopId(run)).toBe("loop-1");
  expect(nextLoopId(run)).toBe("loop-2");
  expect(run.seq).toBe(2);
});

test("state constants keep their documented literals", () => {
  expect(DEFAULT_INTERVAL_SECONDS).toBe(1800);
  expect(DEFAULT_MAX_FIRES).toBe(50);
  expect(COMMAND_MAX_FIRES).toBe(100);
  expect(MIN_INTERVAL_SECONDS).toBe(5);
});

test("armLoop stores an interval loop with the documented defaults and a live timer", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  const state = armLoop(run, { id: "loop-a", prompt: "tick" });
  expect(state).toEqual({
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
  expect(run.loops.get("loop-a")).toBe(state);
  expect(run.resources.get("loop-a")?.timer !== undefined).toBe(true);
  expect(run.resources.get("loop-a")?.watcherRunning).toBe(false);
  stopAllLoops(run);
  expect(run.resources.size).toBe(0);
});

test("armLoop rejects the deprecated watchCommand, a missing prompt, a bad mode, and an empty watcher argv", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  expect(() => armLoop(run, { prompt: "x", watchCommand: "bash -lc echo hi" })).toThrow("watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array");
  expect(() => armLoop(run, { mode: "interval" })).toThrow("prompt required to arm");
  expect(() => armLoop(run, { mode: "cron", prompt: "x" })).toThrow("mode must be interval|settle|watcher|dynamic");
  expect(() => armLoop(run, { id: "loop-w", mode: "watcher", prompt: "x" })).toThrow("watchArgv required for mode=watcher");
  expect([...run.loops.keys()]).toEqual([]);
  expect([...run.resources.keys()]).toEqual([]);
  expect(run.seq).toBe(1);
});

test("re-arming a live id disarms the prior loop and stores the new state", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  const first = armLoop(run, { id: "loop-r", prompt: "first", intervalSeconds: 3600 });
  const second = armLoop(run, { id: "loop-r", prompt: "second", intervalSeconds: 60 });
  expect(first === second).toBe(false);
  expect(first.armed).toBe(true);
  expect(first.prompt).toBe("first");
  expect(run.loops.get("loop-r")).toBe(second);
  expect(second.prompt).toBe("second");
  expect(second.intervalMs).toBe(60000);
  expect(run.loops.size).toBe(1);
  expect(run.resources.get("loop-r")?.timer !== undefined).toBe(true);
  stopAllLoops(run);
});

test("dispatch and startArmedLoop return undefined for an unknown loop id", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  expect(dispatch(run, "loop-missing", { type: "tick", reason: "interval" })).toBe(undefined);
  expect(startArmedLoop(run, "loop-missing")).toBe(undefined);
  expect(env.users()).toEqual([]);
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
  expect(run.resources.has("loop-s")).toBe(false);
  const returned = startArmedLoop(run, "loop-s");
  expect(returned).toBe(state);
  expect(run.resources.get("loop-s")?.timer !== undefined).toBe(true);
  stopAllLoops(run);
});

test("a tick that exceeds maxFires stops the loop and announces it on the message channel", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-1", mode: "interval", prompt: "tick", intervalSeconds: 3600, maxFires: 1 });
  const fired = dispatch(run, "loop-1", { type: "tick", reason: "interval" });
  expect(fired?.fires).toBe(1);
  expect(fired?.armed).toBe(true);
  expect(fired?.lastFireReason).toBe("interval");
  expect(env.users()).toEqual([
    { text: "[pstack_loop loop-1 fire 1/1 reason=interval]\ntick", opts: { deliverAs: "followUp" } },
  ]);
  const stopped = dispatch(run, "loop-1", { type: "tick", reason: "interval" });
  expect(stopped?.fires).toBe(2);
  expect(stopped?.armed).toBe(false);
  expect(env.customs()).toEqual([
    {
      customType: "pstack-loop",
      content: "pstack_loop loop-1 stopped after 1 fires.",
      display: true,
    },
  ]);
  expect(env.users().length).toBe(1);
  expect(run.loops.has("loop-1")).toBe(false);
  expect(run.resources.has("loop-1")).toBe(false);
});

test("stopLoop disarms a stored loop and releases its timer and resources", () => {
  const env = fakePi();
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-d", prompt: "tick", intervalSeconds: 3600 });
  expect(run.resources.get("loop-d")?.timer !== undefined).toBe(true);
  stopLoop(run, "loop-d");
  expect(run.loops.has("loop-d")).toBe(false);
  expect(run.resources.has("loop-d")).toBe(false);
});

test("stopAllLoops clears every loop and every resource", () => {
  const env = fakePi(() => new Promise<ExecResult>(() => {}));
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-a", prompt: "a", intervalSeconds: 3600 });
  armLoop(run, { id: "loop-b", mode: "watcher", prompt: "b", watchArgv: ["waiter-b"] });
  armLoop(run, { id: "loop-c", mode: "dynamic", prompt: "c", intervalSeconds: 3600, watchArgv: ["waiter-c"] });
  expect(run.loops.size).toBe(3);
  expect(run.resources.size).toBe(3);
  expect(run.resources.get("loop-b")?.watcherRunning).toBe(true);
  stopAllLoops(run);
  expect(run.loops.size).toBe(0);
  expect(run.resources.size).toBe(0);
});

test("a watcher exit fires the loop with the watcher reason and keeps it armed", () => {
  const env = fakePi(() => new Promise<ExecResult>(() => {}));
  const run = createRun(env.pi as never);
  armLoop(run, { id: "loop-w", mode: "watcher", prompt: "wake", watchArgv: ["watch-pr", "--status-only"], maxFires: 1 });
  const fired = dispatch(run, "loop-w", { type: "watcher-exit", code: 0, output: "READY" });
  expect(fired?.fires).toBe(1);
  expect(fired?.armed).toBe(true);
  expect(fired?.lastFireReason).toBe("watcher");
  expect(env.users()).toEqual([
    {
      text: "[pstack_loop loop-w fire 1/1 reason=watcher]\nwake\n\n--- watcher output ---\nREADY",
      opts: { deliverAs: "followUp" },
    },
  ]);
  stopAllLoops(run);
  expect(run.loops.size).toBe(0);
});

test("an aborted parent signal aborts the watcher it started", async () => {
  const env = fakePi(() => new Promise<ExecResult>(() => {}));
  const run = createRun(env.pi as never);
  const parent = new AbortController();
  armLoop(run, { id: "loop-p", mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }, parent.signal);
  await flush();
  const watcherSignal = env.signals()[0];
  expect(env.signals().length).toBe(1);
  expect(watcherSignal?.aborted).toBe(false);
  parent.abort();
  expect(watcherSignal?.aborted).toBe(true);
  expect(run.resources.get("loop-p")?.watcherRunning).toBe(true);
  stopAllLoops(run);
  expect(run.loops.size).toBe(0);
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
  expect(state?.armed).toBe(true);
  expect(state?.fires).toBe(1);
  expect(state?.lastFireReason).toBe("watcher-error");
  expect(env.users()).toEqual([
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
  expect(typeof handler).toBe("function");
  const ui = {
    notify(message: string, level: string) {
      notices.add({ message, level });
    },
  };
  await handler?.("not a loop argument", { ui });
  expect(notices.all()).toEqual([
    {
      message:
        "Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop status|list  |  /pstack-loop stop [id]  |  /pstack-loop off",
      level: "error",
    },
  ]);
});

test("__testCoalesceMs exposes the dynamic coalesce window used by the loop tool", () => {
  expect(__testCoalesceMs()).toBe(2500);
});
