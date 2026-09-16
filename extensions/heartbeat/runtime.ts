/**
 * pstack_loop runtime. Owns the loop store, the timers, and the watchers, and
 * interprets the pure reducer's effects. The store replaces each LoopState with
 * a fresh frozen value; nothing reachable from the store is mutated in place.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_FIRES,
  armEffects,
  initialLoopState,
  isLoopMode,
  reduceLoop,
  validateWatcherArgv,
  type LoopEffect,
  type LoopEvent,
  type LoopMode,
  type LoopState,
  type TimerReason,
} from "./state.ts";

const WATCHER_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Process handles for one loop. Kept apart from LoopState so domain state stays serializable. */
export interface LoopResources {
  readonly timer?: ReturnType<typeof setTimeout> | undefined;
  readonly controller?: AbortController | undefined;
  readonly watcherRunning: boolean;
}

export interface HeartbeatRun {
  pi: ExtensionAPI;
  readonly loops: Map<string, LoopState>;
  readonly resources: Map<string, LoopResources>;
  seq: number;
}

export interface ArmParams {
  id?: string | undefined;
  mode?: string | undefined;
  prompt?: string | undefined;
  intervalSeconds?: number | undefined;
  maxFires?: number | undefined;
  watchArgv?: string[] | undefined;
  watchCommand?: string | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchResources(run: HeartbeatRun, id: string, patch: Partial<LoopResources>): void {
  const current = run.resources.get(id) ?? { watcherRunning: false };
  run.resources.set(id, Object.freeze({ ...current, ...patch }));
}

function clearTimer(run: HeartbeatRun, id: string): void {
  const timer = run.resources.get(id)?.timer;
  if (!timer) return;
  clearTimeout(timer);
  patchResources(run, id, { timer: undefined });
}

function abortWatcher(run: HeartbeatRun, id: string): void {
  const controller = run.resources.get(id)?.controller;
  if (!controller) return;
  controller.abort();
  patchResources(run, id, { controller: undefined, watcherRunning: false });
}

function removeLoop(run: HeartbeatRun, id: string): void {
  run.loops.delete(id);
  run.resources.delete(id);
}

function scheduleTimer(run: HeartbeatRun, id: string, delayMs: number, reason: TimerReason): void {
  if (!run.loops.get(id)?.armed) return;
  const timer = setTimeout(() => dispatch(run, id, { type: "tick", reason }), delayMs);
  timer.unref?.();
  patchResources(run, id, { timer });
}

/** A host refusal is recorded on the loop instead of rejecting the watcher task. */
function guardedSend(run: HeartbeatRun, id: string, send: () => void): void {
  try {
    send();
  } catch (error) {
    const state = run.loops.get(id);
    if (!state) return;
    run.loops.set(id, Object.freeze({ ...state, lastFireReason: `deliver-failed (${errorText(error)})` }));
  }
}

function applyEffect(run: HeartbeatRun, id: string, effect: LoopEffect, signal?: AbortSignal): void {
  if (effect.type === "clear-timer") return clearTimer(run, id);
  if (effect.type === "schedule-timer") return scheduleTimer(run, id, effect.delayMs, effect.reason);
  if (effect.type === "start-watcher") return startWatcher(run, id, signal);
  if (effect.type === "abort-watcher") return abortWatcher(run, id);
  if (effect.type === "remove") return removeLoop(run, id);
  if (effect.type === "deliver") {
    return guardedSend(run, id, () => run.pi.sendUserMessage(effect.text, { deliverAs: "followUp" }));
  }
  guardedSend(run, id, () => run.pi.sendMessage({ customType: "pstack-loop", content: effect.text, display: true }));
}

function applyEffects(run: HeartbeatRun, id: string, effects: readonly LoopEffect[], signal?: AbortSignal): void {
  for (const effect of effects) applyEffect(run, id, effect, signal);
}

/** Store the next immutable state, then interpret its effects. */
export function dispatch(run: HeartbeatRun, id: string, event: LoopEvent, signal?: AbortSignal): LoopState | undefined {
  const state = run.loops.get(id);
  if (!state) return undefined;
  const reduction = reduceLoop(state, event, Date.now());
  run.loops.set(id, reduction.state);
  applyEffects(run, id, reduction.effects, signal);
  return reduction.state;
}

function finishWatcher(run: HeartbeatRun, id: string, signal?: AbortSignal): void {
  if (run.resources.has(id)) patchResources(run, id, { watcherRunning: false, controller: undefined });
  const state = run.loops.get(id);
  if (state?.armed && state.mode === "dynamic" && state.fires < state.maxFires) {
    startWatcher(run, id, signal);
  }
}

async function runWatcher(
  run: HeartbeatRun,
  id: string,
  command: string,
  args: string[],
  controller: AbortController,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const result = await run.pi.exec(command, args, { signal: controller.signal, timeout: WATCHER_TIMEOUT_MS });
    if (!run.loops.get(id)?.armed) return;
    dispatch(run, id, { type: "watcher-exit", code: result.code, output: result.stdout || result.stderr || "" });
  } catch (error) {
    if (!run.loops.get(id)?.armed) return;
    dispatch(run, id, { type: "watcher-crash", message: errorText(error) });
  } finally {
    finishWatcher(run, id, signal);
  }
}

function recordWatcherCrash(run: HeartbeatRun, id: string, error: unknown): void {
  if (!run.loops.get(id)?.armed) return;
  dispatch(run, id, { type: "watcher-crash", message: errorText(error) });
}

function startWatcher(run: HeartbeatRun, id: string, signal?: AbortSignal): void {
  const state = run.loops.get(id);
  if (!state?.armed || state.watchArgv.length === 0 || run.resources.get(id)?.watcherRunning) return;
  const [command, ...args] = state.watchArgv;
  if (!command || command.startsWith("-")) return;
  const controller = new AbortController();
  patchResources(run, id, { watcherRunning: true, controller });
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", () => controller.abort(), { once: true });
  void runWatcher(run, id, command, args, controller, signal).catch((error) => {
    recordWatcherCrash(run, id, error);
  });
}

function resolveMode(value: string | undefined): LoopMode {
  const mode = value ?? "interval";
  if (!isLoopMode(mode)) throw new Error("mode must be interval|settle|watcher|dynamic");
  return mode;
}

export function nextLoopId(run: HeartbeatRun): string {
  run.seq = run.seq + 1;
  return `loop-${run.seq}`;
}

export function createRun(pi: ExtensionAPI): HeartbeatRun {
  return { pi, loops: new Map(), resources: new Map(), seq: 0 };
}

export function startArmedLoop(run: HeartbeatRun, id: string, signal?: AbortSignal): LoopState | undefined {
  const state = run.loops.get(id);
  if (!state) return undefined;
  applyEffects(run, id, armEffects(state), signal);
  return state;
}

export function armLoop(run: HeartbeatRun, params: ArmParams, signal?: AbortSignal): LoopState {
  if (params.watchCommand) {
    throw new Error("watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array");
  }
  if (!params.prompt) throw new Error("prompt required to arm");
  const id = params.id ?? nextLoopId(run);
  if (run.loops.has(id)) stopLoop(run, id);
  const mode = resolveMode(params.mode);
  const watchArgv = params.watchArgv ?? [];
  validateWatcherArgv(mode, watchArgv);
  const state = initialLoopState({
    id,
    mode,
    prompt: params.prompt,
    intervalMs: (params.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * 1000,
    maxFires: params.maxFires ?? DEFAULT_MAX_FIRES,
    watchArgv,
  });
  run.loops.set(id, state);
  startArmedLoop(run, id, signal);
  return state;
}

export function stopLoop(run: HeartbeatRun, id: string): void {
  dispatch(run, id, { type: "disarm" });
}

export function stopAllLoops(run: HeartbeatRun): void {
  for (const id of [...run.loops.keys()]) stopLoop(run, id);
  run.loops.clear();
  run.resources.clear();
}
