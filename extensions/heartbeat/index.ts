/**
 * pstack_loop — closest Pi twin to Cursor /loop.
 * Arms a settle-retry / heartbeat that re-prompts the agent after idle+delay,
 * or after a watcher argv exits. Uses official ExtensionAPI (sendUserMessage,
 * agent_settled, session_shutdown). No Cursor /loop dependency.
 *
 * mode=dynamic is a settle+watcher composite: fires on agent_settled (after
 * intervalSeconds) and/or when watchArgv exits; watcher re-arms after each fire
 * while the loop remains armed. Settle+watcher fires are coalesced so they do
 * not double-fire within COALESCE_MS.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DYNAMIC_COALESCE_MS } from "./coalesce.ts";

export { DYNAMIC_COALESCE_MS, decideFire, shouldSkipSettleArm, materializeWatchArgv, BABYSIT_WATCH_RECIPES } from "./coalesce.ts";

interface LoopState {
  id: string;
  mode: "interval" | "watcher" | "settle" | "dynamic";
  prompt: string;
  basePrompt: string;
  intervalMs: number;
  maxFires: number;
  fires: number;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  armed: boolean;
  watchArgv?: string[];
  watcherRunning?: boolean;
  lastFireAt: number;
  lastFireReason?: string;
}

interface HeartbeatRun {
  pi: ExtensionAPI;
  loops: Map<string, LoopState>;
  seq: number;
}

interface LoopUiContext {
  ui: {
    setStatus: (key: string, value: string | undefined) => void;
    notify: (message: string, level: string) => void;
  };
}

interface LoopToolParams {
  action: string;
  mode?: string;
  prompt?: string;
  intervalSeconds?: number;
  maxFires?: number;
  watchArgv?: string[];
  watchCommand?: string;
  id?: string;
}

function clearTimer(state: LoopState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

function clearLoop(loops: Map<string, LoopState>, state: LoopState): void {
  state.armed = false;
  clearTimer(state);
  state.controller?.abort();
  loops.delete(state.id);
}

function fire(run: HeartbeatRun, state: LoopState, reason: string): void {
  if (!state.armed) return;
  // Always clear pending settle timer so a watcher fire cannot be followed by a stacked settle.
  clearTimer(state);

  const now = Date.now();
  if (
    state.mode === "dynamic" &&
    state.lastFireAt > 0 &&
    now - state.lastFireAt < DYNAMIC_COALESCE_MS
  ) {
    // Coalesce: e.g. watcher just fired and settle timer also matured.
    return;
  }

  state.fires = state.fires + 1;
  state.lastFireAt = now;
  state.lastFireReason = reason;
  if (state.fires > state.maxFires) {
    clearLoop(run.loops, state);
    run.pi.sendMessage({
      customType: "pstack-loop",
      content: `pstack_loop ${state.id} stopped after ${state.maxFires} fires.`,
      display: true,
    });
    return;
  }
  run.pi.sendUserMessage(`[pstack_loop ${state.id} fire ${state.fires}/${state.maxFires} reason=${reason}]\n${state.prompt}`, { deliverAs: "followUp" });
  // Reset prompt to base after injecting watcher output once
  state.prompt = state.basePrompt;
  if (state.mode === "interval" && state.armed) {
    clearTimer(state);
    state.timer = setTimeout(() => fire(run, state, "interval"), state.intervalMs);
    state.timer.unref?.();
  }
}

/** A watcher that exits nonzero is an error wake, not a success wake. */
export function watcherFireReason(code: number): "watcher" | "watcher-error" {
  return code === 0 ? "watcher" : "watcher-error";
}

function startWatcher(run: HeartbeatRun, state: LoopState, signal?: AbortSignal): void {
  if (!state.armed || !state.watchArgv?.length || state.watcherRunning) return;
  const argv = state.watchArgv;
  const [command, ...args] = argv;
  if (!command || command.startsWith("-")) return;
  const controller = new AbortController();
  state.watcherRunning = true;
  state.controller = controller;
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", () => controller.abort(), { once: true });
  void (async () => {
    try {
      const result = await run.pi.exec(command, args, {
        signal: controller.signal,
        timeout: 24 * 60 * 60 * 1000,
      });
      if (!state.armed) return;
      const reason = watcherFireReason(result.code);
      const out = (result.stdout || result.stderr || "").slice(0, 8000);
      const label = reason === "watcher" ? "watcher output" : `watcher output (exit ${result.code})`;
      state.prompt = `${state.basePrompt}\n\n--- ${label} ---\n${out}`;
      fire(run, state, reason);
    } catch {
      if (!state.armed) return;
      fire(run, state, "watcher-error");
    } finally {
      state.watcherRunning = false;
      state.controller = undefined;
      // dynamic: re-arm watcher after fire while still armed and under max
      if (state.armed && state.mode === "dynamic" && state.fires < state.maxFires) {
        startWatcher(run, state, signal);
      }
    }
  })();
}

function formatLoopRows(loops: Map<string, LoopState>): string[] {
  return [...loops.values()].map(
    (s) =>
      `${s.id} mode=${s.mode} fires=${s.fires}/${s.maxFires} armed=${s.armed} lastReason=${s.lastFireReason ?? "-"}`,
  );
}

function handleStopAll(run: HeartbeatRun, ctx: LoopUiContext): void {
  for (const state of [...run.loops.values()]) clearLoop(run.loops, state);
  ctx.ui.setStatus("pstack-loop", undefined);
  ctx.ui.notify("All pstack loops stopped.", "info");
}

function handleStatusList(loops: Map<string, LoopState>, ctx: LoopUiContext): void {
  const rows = formatLoopRows(loops);
  ctx.ui.notify(rows.length ? rows.join("\n") : "(no active loops)", "info");
}

function handleStopOne(run: HeartbeatRun, id: string, ctx: LoopUiContext): void {
  const s = run.loops.get(id);
  if (s) clearLoop(run.loops, s);
  if (!run.loops.size) ctx.ui.setStatus("pstack-loop", undefined);
  ctx.ui.notify(s ? `Stopped ${id}` : `No loop ${id}`, "info");
}

function nextLoopId(run: HeartbeatRun): string {
  run.seq = run.seq + 1;
  return `loop-${run.seq}`;
}

function armIntervalLoop(run: HeartbeatRun, seconds: number, prompt: string, ctx: LoopUiContext): void {
  const id = nextLoopId(run);
  const state: LoopState = {
    id,
    mode: "interval",
    prompt,
    basePrompt: prompt,
    intervalMs: Math.max(5, seconds) * 1000,
    maxFires: 100,
    fires: 0,
    armed: true,
    lastFireAt: 0,
  };
  run.loops.set(id, state);
  ctx.ui.setStatus("pstack-loop", id);
  ctx.ui.notify(`Armed ${id} every ${seconds}s`, "info");
  clearTimer(state);
  state.timer = setTimeout(() => fire(run, state, "interval"), state.intervalMs);
  state.timer.unref?.();
}

function validateAndInitLoopState(run: HeartbeatRun, params: LoopToolParams): LoopState {
  if (params.watchCommand) {
    throw new Error("watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array");
  }
  const explicitId = params.id;
  const id = explicitId ?? nextLoopId(run);
  const existing = run.loops.get(id);
  if (existing) clearLoop(run.loops, existing);
  const mode = (params.mode as LoopState["mode"]) || "interval";
  if (mode !== "interval" && mode !== "settle" && mode !== "watcher" && mode !== "dynamic") {
    throw new Error("mode must be interval|settle|watcher|dynamic");
  }
  return {
    id,
    mode,
    prompt: params.prompt as string,
    basePrompt: params.prompt as string,
    intervalMs: (params.intervalSeconds ?? 1800) * 1000,
    maxFires: params.maxFires ?? 50,
    fires: 0,
    armed: true,
    watchArgv: params.watchArgv,
    lastFireAt: 0,
  };
}

function startLoopByMode(run: HeartbeatRun, state: LoopState, signal?: AbortSignal): void {
  run.loops.set(state.id, state);
  if (state.mode === "watcher") {
    if (!state.watchArgv?.length) throw new Error("watchArgv required for mode=watcher");
    const [command] = state.watchArgv;
    if (!command || command.startsWith("-")) {
      throw new Error("watchArgv[0] must be a command path/name (not an option)");
    }
    startWatcher(run, state, signal);
  } else if (state.mode === "dynamic") {
    if (state.watchArgv?.length) {
      const [command] = state.watchArgv;
      if (!command || command.startsWith("-")) {
        throw new Error("watchArgv[0] must be a command path/name (not an option)");
      }
      startWatcher(run, state, signal);
    }
  } else if (state.mode === "interval") {
    clearTimer(state);
    state.timer = setTimeout(() => fire(run, state, "interval"), state.intervalMs);
    state.timer.unref?.();
  }
}

function registerLoopLifecycle(run: HeartbeatRun): void {
  run.pi.on("session_shutdown", () => {
    for (const state of run.loops.values()) clearLoop(run.loops, state);
    run.loops = new Map();
  });

  run.pi.on("agent_settled", () => {
    for (const state of run.loops.values()) {
      if ((state.mode === "settle" || state.mode === "dynamic") && state.armed) {
        // Clear before re-arm so settle events do not stack uncleared timers.
        clearTimer(state);
        // If we just fired (e.g. watcher), skip arming settle inside coalesce window.
        if (
          state.mode === "dynamic" &&
          state.lastFireAt > 0 &&
          Date.now() - state.lastFireAt < DYNAMIC_COALESCE_MS
        ) {
          continue;
        }
        state.timer = setTimeout(() => fire(run, state, "settle"), state.intervalMs);
        state.timer.unref?.();
      }
    }
  });
}

function registerLoopCommand(run: HeartbeatRun): void {
  run.pi.registerCommand("pstack-loop", {
    description:
      "Arm/status/stop/list heartbeat loops (Cursor /loop twin). Args: <seconds> <prompt…> | status | list | stop [id] | off",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const lower = trimmed.toLowerCase();
      if (!trimmed || lower === "off" || lower === "stop") {
        handleStopAll(run, ctx);
        return;
      }
      if (lower === "status" || lower === "list") {
        handleStatusList(run.loops, ctx);
        return;
      }
      const stopOne = trimmed.match(/^stop\s+(\S+)$/i);
      if (stopOne) {
        handleStopOne(run, stopOne[1], ctx);
        return;
      }
      const m = trimmed.match(/^(\d+)\s+([\s\S]+)$/);
      if (!m) {
        ctx.ui.notify(
          "Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop status|list  |  /pstack-loop stop [id]  |  /pstack-loop off",
          "error",
        );
        return;
      }
      armIntervalLoop(run, Number(m[1]), m[2], ctx);
    },
  });
}

function loopToolParameters() {
  return Type.Object({
    action: StringEnum(["arm", "stop", "status", "list"] as const, {
      description: "arm | stop | status | list",
    }),
    mode: Type.Optional(
      StringEnum(["interval", "settle", "watcher", "dynamic"] as const, {
        description:
          "interval | settle | watcher | dynamic (default interval). dynamic = settle + optional watcher re-arm (coalesced).",
      }),
    ),
    prompt: Type.Optional(Type.String({ description: "Prompt to inject on each fire" })),
    intervalSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 86400 })),
    maxFires: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    watchArgv: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "For mode=watcher|dynamic: argv array [command, ...args] (no shell). On exit the loop fires (dynamic re-arms).",
      }),
    ),
    watchCommand: Type.Optional(
      Type.String({
        description: "Deprecated; rejected. Use watchArgv argv array instead of bash -lc.",
      }),
    ),
    id: Type.Optional(Type.String({ description: "Loop id for stop" })),
  });
}

async function executeLoopTool(
  run: HeartbeatRun,
  params: LoopToolParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  if (params.action === "status" || params.action === "list") {
    const rows = formatLoopRows(run.loops);
    return {
      content: [{ type: "text", text: rows.length ? rows.join("\n") : "(no active loops)" }],
      details: { loops: [...run.loops.keys()], action: params.action },
    };
  }
  if (params.action === "stop") {
    if (params.id) {
      const s = run.loops.get(params.id);
      if (s) clearLoop(run.loops, s);
    } else {
      for (const s of [...run.loops.values()]) clearLoop(run.loops, s);
    }
    ctx.ui.setStatus("pstack-loop", undefined);
    return { content: [{ type: "text", text: "stopped" }], details: {} };
  }
  if (params.action !== "arm") throw new Error("action must be arm|stop|status|list");
  if (!params.prompt) throw new Error("prompt required to arm");

  const state = validateAndInitLoopState(run, params);
  ctx.ui.setStatus("pstack-loop", state.id);
  startLoopByMode(run, state, signal);

  return {
    content: [
      {
        type: "text",
        text: `Armed ${state.id} mode=${state.mode} intervalSeconds=${params.intervalSeconds ?? 1800} maxFires=${state.maxFires}${params.watchArgv?.length ? " watcher=on" : ""} coalesceMs=${DYNAMIC_COALESCE_MS}`,
      },
    ],
    details: { id: state.id, mode: state.mode, coalesceMs: DYNAMIC_COALESCE_MS },
  };
}

function registerLoopTool(run: HeartbeatRun): void {
  run.pi.registerTool({
    name: "pstack_loop",
    label: "Pstack Loop",
    description:
      "Arm, status, or stop a heartbeat / settle-retry / watcher / dynamic loop (closest Pi twin to Cursor /loop). Modes: interval | settle | watcher | dynamic (settle+watcher composite; coalesced to prevent double-fire).",
    promptSnippet: "Arm a repeating wake prompt after interval, settle, watcher, or dynamic",
    promptGuidelines: [
      "Use pstack_loop for autonomous-run and babysit wake chains (Pi has no Cursor /loop).",
      "Prefer pstack_loop mode=dynamic (settle+watcher) for babysit/shipping frontiers; pass watchArgv when an event (CI, merge) should wake the agent.",
      "pstack_loop mode=settle / dynamic clears any prior timer before re-arming on agent_settled; dynamic coalesces settle+watcher within 2.5s so they do not double-fire.",
      "pstack_loop mode=watcher fires once when watchArgv exits; mode=dynamic re-arms the watcher after each fire.",
    ],
    parameters: loopToolParameters(),
    execute: (_id, params, signal, _onUpdate, ctx) => executeLoopTool(run, params, signal, ctx),
  });
}

interface ProgrammaticLoopParams {
  id: string;
  prompt: string;
  mode?: string;
  intervalSeconds?: number;
  maxFires?: number;
  watchArgv?: string[];
}

let activeRun: HeartbeatRun | undefined;

export function registerHeartbeat(pi: ExtensionAPI): void {
  const run: HeartbeatRun = { pi, loops: new Map(), seq: 0 };
  activeRun = run;
  registerLoopLifecycle(run);
  registerLoopCommand(run);
  registerLoopTool(run);
}

/**
 * Arm a loop from extension code through the same validate/start path as the
 * pstack_loop tool, so the heartbeat runtime stays the only timer owner.
 */
export function armProgrammaticLoop(params: ProgrammaticLoopParams): string {
  const run = activeRun;
  if (!run) {
    throw new Error(
      "armProgrammaticLoop requires a registered heartbeat runtime; call registerHeartbeat first",
    );
  }
  const state = validateAndInitLoopState(run, {
    action: "arm",
    id: params.id,
    mode: params.mode,
    prompt: params.prompt,
    intervalSeconds: params.intervalSeconds,
    maxFires: params.maxFires,
    watchArgv: params.watchArgv,
  });
  startLoopByMode(run, state);
  return state.id;
}

export function stopProgrammaticLoop(id: string): boolean {
  const run = activeRun;
  if (!run) return false;
  const state = run.loops.get(id);
  if (!state) return false;
  clearLoop(run.loops, state);
  return true;
}

/** Test-only: exported coalesce constant for scripted checks. */
export function __testCoalesceMs(): number {
  return DYNAMIC_COALESCE_MS;
}
