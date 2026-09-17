import { expect, test } from "vitest";
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
  expect(state).toEqual({
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
  expect(reduction.state).toEqual({
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
  expect(reduction.effects).toEqual([
    { type: "clear-timer" },
    { type: "deliver", text: "[pstack_loop loop-1 fire 1/3 reason=interval]\ntick" },
    { type: "schedule-timer", delayMs: 5000, reason: "interval" },
  ]);
});

test("a fire that would exceed maxFires disarms the loop instead of delivering", () => {
  const atCap = { ...initialLoopState(spec({ maxFires: 2 })), fires: 2, lastFireAt: 0 };
  const reduction = reduceLoop(atCap, { type: "tick", reason: "interval" }, 6000);
  expect(reduction.state).toEqual({
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
  expect(reduction.effects).toEqual([
    { type: "clear-timer" },
    { type: "abort-watcher" },
    { type: "remove" },
    { type: "announce-stopped", text: "pstack_loop loop-1 stopped after 2 fires." },
  ]);
});

test("a dynamic tick inside the coalesce window is a no-op that still clears the pending timer", () => {
  const fired = { ...initialLoopState(spec({ mode: "dynamic" })), fires: 1, lastFireAt: 1000 };
  const reduction = reduceLoop(fired, { type: "tick", reason: "settle" }, 1000 + DYNAMIC_COALESCE_MS - 1);
  expect(reduction.state.fires).toBe(1);
  expect(reduction.effects).toEqual([{ type: "clear-timer" }]);
});

test("a dynamic tick after the coalesce window fires again", () => {
  const fired = { ...initialLoopState(spec({ mode: "dynamic" })), fires: 1, lastFireAt: 1000 };
  const reduction = reduceLoop(fired, { type: "tick", reason: "settle" }, 1000 + DYNAMIC_COALESCE_MS + 1);
  expect(reduction.state.fires).toBe(2);
  expect(reduction.state.lastFireReason).toBe("settle");
});

test("settle-check arms the settle timer only for settle and dynamic modes", () => {
  const settles = reduceLoop(initialLoopState(spec({ mode: "settle" })), { type: "settle-check" }, 100);
  expect(settles.effects).toEqual([
    { type: "clear-timer" },
    { type: "schedule-timer", delayMs: 5000, reason: "settle" },
  ]);
  const interval = reduceLoop(initialLoopState(spec({ mode: "interval" })), { type: "settle-check" }, 100);
  expect(interval.effects).toEqual([]);
  const watcher = reduceLoop(initialLoopState(spec({ mode: "watcher" })), { type: "settle-check" }, 100);
  expect(watcher.effects).toEqual([]);
});

test("settle-check skips a dynamic re-arm inside the coalesce window and never skips settle mode", () => {
  const dynamic = reduceLoop(
    { ...initialLoopState(spec({ mode: "dynamic" })), lastFireAt: 1000 },
    { type: "settle-check" },
    1000 + DYNAMIC_COALESCE_MS - 1,
  );
  expect(dynamic.effects).toEqual([{ type: "clear-timer" }]);
  const settle = reduceLoop(
    { ...initialLoopState(spec({ mode: "settle" })), lastFireAt: 1000 },
    { type: "settle-check" },
    1000 + DYNAMIC_COALESCE_MS - 1,
  );
  expect(settle.effects).toEqual([
    { type: "clear-timer" },
    { type: "schedule-timer", delayMs: 5000, reason: "settle" },
  ]);
});

test("a watcher exit zero wakes with reason=watcher and its output in the prompt", () => {
  const state = initialLoopState(spec({ mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }));
  const reduction = reduceLoop(state, { type: "watcher-exit", code: 0, output: "READY" }, 1000);
  expect(reduction.effects).toEqual([
    { type: "clear-timer" },
    {
      type: "deliver",
      text: "[pstack_loop loop-1 fire 1/3 reason=watcher]\nwake\n\n--- watcher output ---\nREADY",
    },
  ]);
  expect(reduction.state.lastFireReason).toBe("watcher");
});

test("a watcher exit nonzero wakes with reason=watcher-error and names the exit code", () => {
  const state = initialLoopState(spec({ mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }));
  const reduction = reduceLoop(state, { type: "watcher-exit", code: 2, output: "blocked" }, 1000);
  expect(reduction.state.lastFireReason).toBe("watcher-error");
  expect(reduction.effects.at(-1)).toEqual({
    type: "deliver",
    text: "[pstack_loop loop-1 fire 1/3 reason=watcher-error]\nwake\n\n--- watcher output (exit 2) ---\nblocked",
  });
});

test("a watcher crash fires reason=watcher-error with the crash cause in the prompt", () => {
  const state = initialLoopState(spec({ mode: "watcher", prompt: "wake", watchArgv: ["watch-pr"] }));
  const reduction = reduceLoop(state, { type: "watcher-crash", message: "spawn ENOENT" }, 1000);
  expect(reduction.state.lastFireReason).toBe("watcher-error");
  expect(reduction.effects.at(-1)).toEqual({
    type: "deliver",
    text: "[pstack_loop loop-1 fire 1/3 reason=watcher-error]\nwake\n\n--- watcher failed ---\nspawn ENOENT",
  });
});

test("a coalesced watcher exit keeps the watcher prompt for the next fire", () => {
  const state = initialLoopState(spec({ mode: "dynamic", prompt: "base", watchArgv: ["watch-pr"] }));
  const fired = reduceLoop(state, { type: "tick", reason: "settle" }, 1000).state;
  const coalesced = reduceLoop(fired, { type: "watcher-exit", code: 0, output: "READY" }, 1100);
  expect(coalesced.effects).toEqual([{ type: "clear-timer" }]);
  expect(coalesced.state.fires).toBe(1);
  expect(coalesced.state.prompt).toBe("base\n\n--- watcher output ---\nREADY");
});

test("disarm returns a disarmed state and the effects that release its resources", () => {
  const state = { ...initialLoopState(spec({ mode: "dynamic" })), fires: 2 };
  const reduction = reduceLoop(state, { type: "disarm" }, 2000);
  expect(reduction.state.armed).toBe(false);
  expect(reduction.effects).toEqual([
    { type: "clear-timer" },
    { type: "abort-watcher" },
    { type: "remove" },
  ]);
});

test("a transition returns a new frozen state and leaves the input untouched", () => {
  const state = initialLoopState(spec());
  const reduction = reduceLoop(state, { type: "tick", reason: "interval" }, 5000);
  expect(reduction.state).not.toBe(state);
  expect(state.fires).toBe(0);
  expect(state.prompt).toBe("tick");
  expect(() => {
    mutable(reduction.state).fires = 9;
  }).toThrow(TypeError);
});

test("a fire on an already disarmed loop is a no-op", () => {
  const disarmed = { ...initialLoopState(spec()), armed: false };
  const reduction = reduceLoop(disarmed, { type: "tick", reason: "interval" }, 5000);
  expect(reduction.state).toEqual(disarmed);
  expect(reduction.effects).toEqual([]);
});

test("armEffects starts the right resource for each mode", () => {
  expect(armEffects(initialLoopState(spec({ mode: "interval" })))).toEqual([
    { type: "clear-timer" },
    { type: "schedule-timer", delayMs: 5000, reason: "interval" },
  ]);
  expect(armEffects(initialLoopState(spec({ mode: "watcher", watchArgv: ["watch-pr"] })))).toEqual([
    { type: "start-watcher" },
  ]);
  expect(armEffects(initialLoopState(spec({ mode: "dynamic", watchArgv: ["watch-pr"] })))).toEqual([
    { type: "start-watcher" },
  ]);
  expect(armEffects(initialLoopState(spec({ mode: "dynamic" })))).toEqual([]);
  expect(armEffects(initialLoopState(spec({ mode: "settle" })))).toEqual([]);
});

test("formatLoopRows renders the documented status row", () => {
  const rows = formatLoopRows([
    { ...initialLoopState(spec()), lastFireReason: "interval" },
    initialLoopState(spec({ id: "loop-2", mode: "settle" })),
  ]);
  expect(rows).toEqual([
    "loop-1 mode=interval fires=0/3 armed=true lastReason=interval",
    "loop-2 mode=settle fires=0/3 armed=true lastReason=-",
  ]);
});

test("validateWatcherArgv requires a real watcher command and guards an option-looking argv[0]", () => {
  expect(() => validateWatcherArgv("dynamic", [])).not.toThrow();
  expect(() => validateWatcherArgv("interval", ["-dashed"])).not.toThrow();
  expect(() => validateWatcherArgv("watcher", [])).toThrow(/watchArgv required for mode=watcher/);
  expect(() => validateWatcherArgv("watcher", ["-x"])).toThrow(/watchArgv\[0\] must be a command/);
  expect(() => validateWatcherArgv("dynamic", [""])).toThrow(/watchArgv\[0\] must be a command/);
});

test("watcherFireReason and isLoopMode classify their inputs", () => {
  expect(watcherFireReason(0)).toBe("watcher");
  expect(watcherFireReason(1)).toBe("watcher-error");
  expect(isLoopMode("dynamic")).toBe(true);
  expect(isLoopMode("cron")).toBe(false);
  expect(COMMAND_MAX_FIRES).toBe(100);
});
