import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_MAX_FIRES,
  armEffects,
  formatLoopRows,
  initialLoopState,
  isLoopMode,
  reduceLoop,
  validateWatcherArgv,
  watcherFireReason,
  type LoopSpec,
  type LoopState,
} from "../../../extensions/heartbeat/state.ts";
import { DYNAMIC_COALESCE_MS } from "../../../extensions/heartbeat/coalesce.ts";

function spec(overrides: Partial<LoopSpec> = {}): LoopSpec {
  return {
    id: "loop-1",
    mode: "interval",
    prompt: "tick",
    intervalMs: 5000,
    maxFires: 3,
    watchArgv: [],
    ...overrides,
  };
}

function mutable(state: LoopState): { fires: number; armed: boolean; prompt: string } {
  return state as unknown as { fires: number; armed: boolean; prompt: string };
}

test("initialLoopState arms a loop with zero fires and the base prompt as the live prompt", () => {
  const state = initialLoopState(spec({ mode: "dynamic", watchArgv: ["watch-pr"] }));
  assert.deepEqual(state, {
    id: "loop-1",
    mode: "dynamic",
    prompt: "tick",
    basePrompt: "tick",
    intervalMs: 5000,
    maxFires: 3,
    fires: 0,
    armed: true,
    watchArgv: ["watch-pr"],
    lastFireAt: 0,
  });
});

test("an interval tick delivers the fire and re-arms the interval timer", () => {
  const state = initialLoopState(spec());
  const reduction = reduceLoop(state, { type: "tick", reason: "interval" }, 5000);
  assert.deepEqual(reduction.state, {
    id: "loop-1",
    mode: "interval",
    prompt: "tick",
    basePrompt: "tick",
    intervalMs: 5000,
    maxFires: 3,
    fires: 1,
    armed: true,
    watchArgv: [],
    lastFireAt: 5000,
    lastFireReason: "interval",
  });
  assert.deepEqual(reduction.effects, [
    { type: "clear-timer" },
    { type: "deliver", text: "[pstack_loop loop-1 fire 1/3 reason=interval]\ntick" },
    { type: "schedule-timer", delayMs: 5000, reason: "interval" },
  ]);
});

test("a fire that would exceed maxFires disarms the loop instead of delivering", () => {
  const atCap = { ...initialLoopState(spec({ maxFires: 2 })), fires: 2, lastFireAt: 0 };
  const reduction = reduceLoop(atCap, { type: "tick", reason: "interval" }, 6000);
  assert.deepEqual(reduction.state, {
    id: "loop-1",
    mode: "interval",
    prompt: "tick",
    basePrompt: "tick",
    intervalMs: 5000,
    maxFires: 2,
    fires: 3,
    armed: false,
    watchArgv: [],
    lastFireAt: 6000,
    lastFireReason: "interval",
  });
  assert.deepEqual(reduction.effects, [
    { type: "clear-timer" },
    { type: "abort-watcher" },
    { type: "remove" },
    { type: "announce-stopped", text: "pstack_loop loop-1 stopped after 2 fires." },
  ]);
});

test("a dynamic tick inside the coalesce window is a no-op that still clears the pending timer", () => {
  const fired = { ...initialLoopState(spec({ mode: "dynamic" })), fires: 1, lastFireAt: 1000 };
  const reduction = reduceLoop(fired, { type: "tick", reason: "settle" }, 1000 + DYNAMIC_COALESCE_MS - 1);
  assert.equal(reduction.state.fires, 1);
  assert.deepEqual(reduction.effects, [{ type: "clear-timer" }]);
});

test("a dynamic tick after the coalesce window fires again", () => {
  const fired = { ...initialLoopState(spec({ mode: "dynamic" })), fires: 1, lastFireAt: 1000 };
  const reduction = reduceLoop(fired, { type: "tick", reason: "settle" }, 1000 + DYNAMIC_COALESCE_MS + 1);
  assert.equal(reduction.state.fires, 2);
  assert.equal(reduction.state.lastFireReason, "settle");
});

test("settle-check arms the settle timer only for settle and dynamic modes", () => {
  const settles = reduceLoop(initialLoopState(spec({ mode: "settle" })), { type: "settle-check" }, 100);
  assert.deepEqual(settles.effects, [
    { type: "clear-timer" },
    { type: "schedule-timer", delayMs: 5000, reason: "settle" },
  ]);
  const interval = reduceLoop(initialLoopState(spec({ mode: "interval" })), { type: "settle-check" }, 100);
  assert.deepEqual(interval.effects, []);
  const watcher = reduceLoop(initialLoopState(spec({ mode: "watcher" })), { type: "settle-check" }, 100);
  assert.deepEqual(watcher.effects, []);
});

test("settle-check skips a dynamic re-arm inside the coalesce window and never skips settle mode", () => {
  const dynamic = reduceLoop(
    { ...initialLoopState(spec({ mode: "dynamic" })), lastFireAt: 1000 },
    { type: "settle-check" },
    1000 + DYNAMIC_COALESCE_MS - 1,
  );
  assert.deepEqual(dynamic.effects, [{ type: "clear-timer" }]);
  const settle = reduceLoop(
    { ...initialLoopState(spec({ mode: "settle" })), lastFireAt: 1000 },
    { type: "settle-check" },
    1000 + DYNAMIC_COALESCE_MS - 1,
  );
  assert.deepEqual(settle.effects, [
    { type: "clear-timer" },
    { type: "schedule-timer", delayMs: 5000, reason: "settle" },
  ]);
});

test("a watcher exit zero wakes with reason=watcher and its output in the prompt", () => {
  const state = initialLoopState(spec({ mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }));
  const reduction = reduceLoop(state, { type: "watcher-exit", code: 0, output: "READY" }, 1000);
  assert.deepEqual(reduction.effects, [
    { type: "clear-timer" },
    {
      type: "deliver",
      text: "[pstack_loop loop-1 fire 1/3 reason=watcher]\nwake\n\n--- watcher output ---\nREADY",
    },
  ]);
  assert.equal(reduction.state.lastFireReason, "watcher");
});

test("a watcher exit nonzero wakes with reason=watcher-error and names the exit code", () => {
  const state = initialLoopState(spec({ mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }));
  const reduction = reduceLoop(state, { type: "watcher-exit", code: 2, output: "blocked" }, 1000);
  assert.equal(reduction.state.lastFireReason, "watcher-error");
  assert.deepEqual(reduction.effects.at(-1), {
    type: "deliver",
    text: "[pstack_loop loop-1 fire 1/3 reason=watcher-error]\nwake\n\n--- watcher output (exit 2) ---\nblocked",
  });
});

test("a watcher crash fires reason=watcher-error with the crash cause in the prompt", () => {
  const state = initialLoopState(spec({ mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }));
  const reduction = reduceLoop(state, { type: "watcher-crash", message: "spawn ENOENT" }, 1000);
  assert.equal(reduction.state.lastFireReason, "watcher-error");
  assert.deepEqual(reduction.effects.at(-1), {
    type: "deliver",
    text: "[pstack_loop loop-1 fire 1/3 reason=watcher-error]\nwake\n\n--- watcher failed ---\nspawn ENOENT",
  });
});

test("a coalesced watcher exit keeps the watcher prompt for the next fire", () => {
  const state = initialLoopState(spec({ mode: "dynamic", prompt: "base", watchArgv: ["watch-pr"] }));
  const fired = reduceLoop(state, { type: "tick", reason: "settle" }, 1000).state;
  const coalesced = reduceLoop(fired, { type: "watcher-exit", code: 0, output: "READY" }, 1100);
  assert.deepEqual(coalesced.effects, [{ type: "clear-timer" }]);
  assert.equal(coalesced.state.fires, 1);
  assert.equal(coalesced.state.prompt, "base\n\n--- watcher output ---\nREADY");
});

test("disarm returns a disarmed state and the effects that release its resources", () => {
  const state = { ...initialLoopState(spec({ mode: "dynamic" })), fires: 2 };
  const reduction = reduceLoop(state, { type: "disarm" }, 2000);
  assert.equal(reduction.state.armed, false);
  assert.deepEqual(reduction.effects, [
    { type: "clear-timer" },
    { type: "abort-watcher" },
    { type: "remove" },
  ]);
});

test("a transition returns a new frozen state and leaves the input untouched", () => {
  const state = initialLoopState(spec());
  const reduction = reduceLoop(state, { type: "tick", reason: "interval" }, 5000);
  assert.notEqual(reduction.state, state);
  assert.equal(state.fires, 0);
  assert.equal(state.prompt, "tick");
  assert.throws(() => {
    mutable(reduction.state).fires = 9;
  }, TypeError);
});

test("a fire on an already disarmed loop is a no-op", () => {
  const disarmed = { ...initialLoopState(spec()), armed: false };
  const reduction = reduceLoop(disarmed, { type: "tick", reason: "interval" }, 5000);
  assert.deepEqual(reduction.state, disarmed);
  assert.deepEqual(reduction.effects, []);
});

test("armEffects starts the right resource for each mode", () => {
  assert.deepEqual(armEffects(initialLoopState(spec({ mode: "interval" }))), [
    { type: "clear-timer" },
    { type: "schedule-timer", delayMs: 5000, reason: "interval" },
  ]);
  assert.deepEqual(armEffects(initialLoopState(spec({ mode: "watcher", watchArgv: ["watch-pr"] }))), [
    { type: "start-watcher" },
  ]);
  assert.deepEqual(armEffects(initialLoopState(spec({ mode: "dynamic", watchArgv: ["watch-pr"] }))), [
    { type: "start-watcher" },
  ]);
  assert.deepEqual(armEffects(initialLoopState(spec({ mode: "dynamic" }))), []);
  assert.deepEqual(armEffects(initialLoopState(spec({ mode: "settle" }))), []);
});

test("formatLoopRows renders the documented status row", () => {
  const rows = formatLoopRows([
    { ...initialLoopState(spec()), lastFireReason: "interval" },
    initialLoopState(spec({ id: "loop-2", mode: "settle" })),
  ]);
  assert.deepEqual(rows, [
    "loop-1 mode=interval fires=0/3 armed=true lastReason=interval",
    "loop-2 mode=settle fires=0/3 armed=true lastReason=-",
  ]);
});

test("validateWatcherArgv requires a real watcher command and guards an option-looking argv[0]", () => {
  assert.doesNotThrow(() => validateWatcherArgv("dynamic", []));
  assert.doesNotThrow(() => validateWatcherArgv("interval", ["-dashed"]));
  assert.throws(() => validateWatcherArgv("watcher", []), /watchArgv required for mode=watcher/);
  assert.throws(() => validateWatcherArgv("watcher", ["-x"]), /watchArgv\[0\] must be a command/);
  assert.throws(() => validateWatcherArgv("dynamic", [""]), /watchArgv\[0\] must be a command/);
});

test("watcherFireReason and isLoopMode classify their inputs", () => {
  assert.equal(watcherFireReason(0), "watcher");
  assert.equal(watcherFireReason(1), "watcher-error");
  assert.equal(isLoopMode("dynamic"), true);
  assert.equal(isLoopMode("cron"), false);
  assert.equal(COMMAND_MAX_FIRES, 100);
});
