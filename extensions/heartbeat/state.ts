/**
 * The pstack_loop FSM as a pure reducer. No timers, no host calls: the reducer
 * returns the next LoopState plus declarative effects the runtime applies.
 * Every returned state is a fresh frozen object, so the value held in the loop
 * map is replaced, never mutated in place.
 */
import { DYNAMIC_COALESCE_MS, decideFire, shouldSkipSettleArm } from "./coalesce.ts";

export const LOOP_MODES = ["interval", "watcher", "settle", "dynamic"] as const;
export type LoopMode = (typeof LOOP_MODES)[number];

export type TimerReason = "interval" | "settle";
export type FireReason = TimerReason | "watcher" | "watcher-error";

export const DEFAULT_INTERVAL_SECONDS = 1800;
export const DEFAULT_MAX_FIRES = 50;
export const COMMAND_MAX_FIRES = 100;
export const MIN_INTERVAL_SECONDS = 5;
export const WATCHER_OUTPUT_LIMIT = 8000;

export interface LoopState {
  readonly id: string;
  readonly mode: LoopMode;
  readonly prompt: string;
  readonly basePrompt: string;
  readonly intervalMs: number;
  readonly maxFires: number;
  readonly fires: number;
  readonly armed: boolean;
  readonly watchArgv: readonly string[];
  readonly lastFireAt: number;
  readonly lastFireReason?: string;
}

export type LoopEvent =
  | { type: "tick"; reason: TimerReason }
  | { type: "watcher-exit"; code: number; output: string }
  | { type: "watcher-crash"; message: string }
  | { type: "settle-check" }
  | { type: "disarm" };

export type LoopEffect =
  | { type: "clear-timer" }
  | { type: "schedule-timer"; delayMs: number; reason: TimerReason }
  | { type: "start-watcher" }
  | { type: "abort-watcher" }
  | { type: "deliver"; text: string }
  | { type: "announce-stopped"; text: string }
  | { type: "remove" };

export interface LoopReduction {
  readonly state: LoopState;
  readonly effects: readonly LoopEffect[];
}

export interface LoopSpec {
  readonly id: string;
  readonly mode: LoopMode;
  readonly prompt: string;
  readonly intervalMs: number;
  readonly maxFires: number;
  readonly watchArgv: readonly string[];
}

const CLEAR_TIMER: LoopEffect = Object.freeze({ type: "clear-timer" });
const ABORT_WATCHER: LoopEffect = Object.freeze({ type: "abort-watcher" });
const REMOVE: LoopEffect = Object.freeze({ type: "remove" });

export function isLoopMode(value: unknown): value is LoopMode {
  return typeof value === "string" && LOOP_MODES.some((mode) => mode === value);
}

export function watcherFireReason(code: number): "watcher" | "watcher-error" {
  return code === 0 ? "watcher" : "watcher-error";
}

/** A watcher needs a real command, never an option-looking argv[0]. */
export function validateWatcherArgv(mode: LoopMode, watchArgv: readonly string[]): void {
  if (mode !== "watcher" && mode !== "dynamic") return;
  if (mode === "watcher" && watchArgv.length === 0) {
    throw new Error("watchArgv required for mode=watcher");
  }
  if (watchArgv.length === 0) return;
  const [command] = watchArgv;
  if (!command || command.startsWith("-")) {
    throw new Error("watchArgv[0] must be a command path/name (not an option)");
  }
}

export function initialLoopState(spec: LoopSpec): LoopState {
  return Object.freeze({
    id: spec.id,
    mode: spec.mode,
    prompt: spec.prompt,
    basePrompt: spec.prompt,
    intervalMs: spec.intervalMs,
    maxFires: spec.maxFires,
    fires: 0,
    armed: true,
    watchArgv: Object.freeze([...spec.watchArgv]),
    lastFireAt: 0,
  });
}

/** Effects that bring a freshly stored loop to its armed state. */
export function armEffects(state: LoopState): LoopEffect[] {
  if (state.mode === "interval") {
    return [CLEAR_TIMER, { type: "schedule-timer", delayMs: state.intervalMs, reason: "interval" }];
  }
  const watches = state.mode === "watcher" || (state.mode === "dynamic" && state.watchArgv.length > 0);
  return watches ? [{ type: "start-watcher" }] : [];
}

export function formatLoopRows(states: Iterable<LoopState>): string[] {
  return [...states].map(
    (s) =>
      `${s.id} mode=${s.mode} fires=${s.fires}/${s.maxFires} armed=${s.armed} lastReason=${s.lastFireReason ?? "-"}`,
  );
}

function prompted(state: LoopState, label: string, body: string): LoopState {
  return Object.freeze({ ...state, prompt: `${state.basePrompt}\n\n--- ${label} ---\n${body}` });
}

function withClearedTimer(reduction: LoopReduction): LoopReduction {
  return { state: reduction.state, effects: [CLEAR_TIMER, ...reduction.effects] };
}

function fireTransition(state: LoopState, reason: FireReason, now: number, coalesceMs: number): LoopReduction {
  const decision = decideFire(state, reason, now, coalesceMs, state.mode);
  if (decision.action === "coalesce") return { state, effects: [] };
  if (decision.action === "stop") {
    const stopped = Object.freeze({
      ...state,
      fires: decision.fires,
      lastFireAt: now,
      lastFireReason: reason,
      armed: false,
    });
    return {
      state: stopped,
      effects: [
        ABORT_WATCHER,
        REMOVE,
        { type: "announce-stopped", text: `pstack_loop ${state.id} stopped after ${state.maxFires} fires.` },
      ],
    };
  }
  const next = Object.freeze({
    ...state,
    fires: decision.fires,
    lastFireAt: now,
    lastFireReason: reason,
    prompt: state.basePrompt,
  });
  const deliver: LoopEffect = {
    type: "deliver",
    text: `[pstack_loop ${state.id} fire ${decision.fires}/${state.maxFires} reason=${reason}]\n${state.prompt}`,
  };
  if (state.mode !== "interval" || !state.armed) return { state: next, effects: [deliver] };
  return {
    state: next,
    effects: [deliver, { type: "schedule-timer", delayMs: state.intervalMs, reason: "interval" }],
  };
}

function settleCheck(state: LoopState, now: number, coalesceMs: number): LoopReduction {
  const settles = state.mode === "settle" || state.mode === "dynamic";
  if (!settles) return { state, effects: [] };
  const skip = state.mode === "dynamic" && shouldSkipSettleArm(state.lastFireAt, now, coalesceMs);
  if (skip) return { state, effects: [CLEAR_TIMER] };
  return {
    state,
    effects: [CLEAR_TIMER, { type: "schedule-timer", delayMs: state.intervalMs, reason: "settle" }],
  };
}

export function reduceLoop(
  state: LoopState,
  event: LoopEvent,
  now: number,
  coalesceMs: number = DYNAMIC_COALESCE_MS,
): LoopReduction {
  if (event.type === "disarm") {
    return {
      state: Object.freeze({ ...state, armed: false }),
      effects: [CLEAR_TIMER, ABORT_WATCHER, REMOVE],
    };
  }
  if (!state.armed) return { state, effects: [] };
  if (event.type === "settle-check") return settleCheck(state, now, coalesceMs);
  if (event.type === "tick") return withClearedTimer(fireTransition(state, event.reason, now, coalesceMs));
  if (event.type === "watcher-exit") {
    const reason = watcherFireReason(event.code);
    const label = reason === "watcher" ? "watcher output" : `watcher output (exit ${event.code})`;
    const body = event.output.slice(0, WATCHER_OUTPUT_LIMIT);
    return withClearedTimer(fireTransition(prompted(state, label, body), reason, now, coalesceMs));
  }
  const failed = prompted(state, "watcher failed", event.message);
  return withClearedTimer(fireTransition(failed, "watcher-error", now, coalesceMs));
}
