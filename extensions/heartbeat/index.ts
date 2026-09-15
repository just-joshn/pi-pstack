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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  child?: { kill: (sig?: string) => void };
  armed: boolean;
  watchArgv?: string[];
  watcherRunning?: boolean;
  lastFireAt: number;
  lastFireReason?: string;
}

export function registerHeartbeat(pi: ExtensionAPI): void {
  let loops = new Map<string, LoopState>();
  let seq = 0;

  const clearTimer = (state: LoopState) => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  };

  const clearLoop = (state: LoopState) => {
    state.armed = false;
    clearTimer(state);
    try {
      state.child?.kill("SIGTERM");
    } catch (_err) {
      void _err;
    }
    loops.delete(state.id);
  };

  const fire = (state: LoopState, reason: string) => {
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
      clearLoop(state);
      pi.sendMessage({
        customType: "pstack-loop",
        content: `pstack_loop ${state.id} stopped after ${state.maxFires} fires.`,
        display: true,
      });
      return;
    }
    pi.sendUserMessage(
      `[pstack_loop ${state.id} fire ${state.fires}/${state.maxFires} reason=${reason}]\n${state.prompt}`,
      { deliverAs: "followUp" },
    );
    // Reset prompt to base after injecting watcher output once
    state.prompt = state.basePrompt;
    if (state.mode === "interval" && state.armed) {
      clearTimer(state);
      state.timer = setTimeout(() => fire(state, "interval"), state.intervalMs);
      state.timer.unref?.();
    }
  };

  const startWatcher = (state: LoopState, signal?: AbortSignal) => {
    if (!state.armed || !state.watchArgv?.length || state.watcherRunning) return;
    const argv = state.watchArgv;
    const [command, ...args] = argv;
    if (!command || command.startsWith("-")) return;
    state.watcherRunning = true;
    void (async () => {
      try {
        const result = await pi.exec(command, args, {
          signal,
          timeout: 24 * 60 * 60 * 1000,
        });
        if (!state.armed) return;
        const out = (result.stdout || result.stderr || "").slice(0, 8000);
        state.prompt = `${state.basePrompt}\n\n--- watcher output ---\n${out}`;
        fire(state, "watcher");
      } catch {
        if (!state.armed) return;
        fire(state, "watcher-error");
      } finally {
        state.watcherRunning = false;
        // dynamic: re-arm watcher after fire while still armed and under max
        if (state.armed && state.mode === "dynamic" && state.fires < state.maxFires) {
          startWatcher(state, signal);
        }
      }
    })();
  };

  pi.on("session_shutdown", () => {
    for (const state of loops.values()) clearLoop(state);
    loops = new Map();
  });

  pi.on("agent_settled", () => {
    for (const state of loops.values()) {
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
        state.timer = setTimeout(() => fire(state, "settle"), state.intervalMs);
        state.timer.unref?.();
      }
    }
  });

  const formatLoopRows = () =>
    [...loops.values()].map(
      (s) =>
        `${s.id} mode=${s.mode} fires=${s.fires}/${s.maxFires} armed=${s.armed} lastReason=${s.lastFireReason ?? "-"}`,
    );

  const handleStopAll = (ctx: { ui: { setStatus: (k: string, v: undefined) => void; notify: (msg: string, level: string) => void } }) => {
    for (const state of [...loops.values()]) clearLoop(state);
    ctx.ui.setStatus("pstack-loop", undefined);
    ctx.ui.notify("All pstack loops stopped.", "info");
  };

  const handleStatusList = (ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
    const rows = formatLoopRows();
    ctx.ui.notify(rows.length ? rows.join("\n") : "(no active loops)", "info");
  };

  const handleStopOne = (id: string, ctx: { ui: { setStatus: (k: string, v: undefined) => void; notify: (msg: string, level: string) => void } }) => {
    const s = loops.get(id);
    if (s) clearLoop(s);
    if (!loops.size) ctx.ui.setStatus("pstack-loop", undefined);
    ctx.ui.notify(s ? `Stopped ${id}` : `No loop ${id}`, "info");
  };

  const armIntervalLoop = (seconds: number, prompt: string, ctx: { ui: { setStatus: (k: string, v: string) => void; notify: (msg: string, level: string) => void } }) => {
    seq = seq + 1;
    const id = `loop-${seq}`;
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
    loops.set(id, state);
    ctx.ui.setStatus("pstack-loop", id);
    ctx.ui.notify(`Armed ${id} every ${seconds}s`, "info");
    clearTimer(state);
    state.timer = setTimeout(() => fire(state, "interval"), state.intervalMs);
    state.timer.unref?.();
  };

  const validateAndInitLoopState = (
    params: { id?: string; mode?: string; prompt: string; intervalSeconds?: number; maxFires?: number; watchArgv?: string[]; watchCommand?: string },
  ): LoopState => {
    if (params.watchCommand) {
      throw new Error("watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array");
    }
    const explicitId = params.id;
    if (explicitId === undefined || explicitId === null) seq = seq + 1;
    const id = explicitId ?? `loop-${seq}`;
    const existing = loops.get(id);
    if (existing) clearLoop(existing);
    const mode = (params.mode as LoopState["mode"]) || "interval";
    if (mode !== "interval" && mode !== "settle" && mode !== "watcher" && mode !== "dynamic") {
      throw new Error("mode must be interval|settle|watcher|dynamic");
    }
    return {
      id,
      mode,
      prompt: params.prompt,
      basePrompt: params.prompt,
      intervalMs: (params.intervalSeconds ?? 1800) * 1000,
      maxFires: params.maxFires ?? 50,
      fires: 0,
      armed: true,
      watchArgv: params.watchArgv,
      lastFireAt: 0,
    };
  };

  const startLoopByMode = (state: LoopState, signal?: AbortSignal) => {
    loops.set(state.id, state);
    if (state.mode === "watcher") {
      if (!state.watchArgv?.length) throw new Error("watchArgv required for mode=watcher");
      const [command] = state.watchArgv;
      if (!command || command.startsWith("-")) {
        throw new Error("watchArgv[0] must be a command path/name (not an option)");
      }
      startWatcher(state, signal);
    } else if (state.mode === "dynamic") {
      if (state.watchArgv?.length) {
        const [command] = state.watchArgv;
        if (!command || command.startsWith("-")) {
          throw new Error("watchArgv[0] must be a command path/name (not an option)");
        }
        startWatcher(state, signal);
      }
    } else if (state.mode === "interval") {
      clearTimer(state);
      state.timer = setTimeout(() => fire(state, "interval"), state.intervalMs);
      state.timer.unref?.();
    }
  };

  pi.registerCommand("pstack-loop", {
    description:
      "Arm/status/stop/list heartbeat loops (Cursor /loop twin). Args: <seconds> <prompt…> | status | list | stop [id] | off",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const lower = trimmed.toLowerCase();
      if (!trimmed || lower === "off" || lower === "stop") {
        handleStopAll(ctx);
        return;
      }
      if (lower === "status" || lower === "list") {
        handleStatusList(ctx);
        return;
      }
      const stopOne = trimmed.match(/^stop\s+(\S+)$/i);
      if (stopOne) {
        handleStopOne(stopOne[1], ctx);
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
      armIntervalLoop(Number(m[1]), m[2], ctx);
    },
  });

  pi.registerTool({
    name: "pstack_loop",
    label: "Pstack Loop",
    description:
      "Arm, status, or stop a heartbeat / settle-retry / watcher / dynamic loop (closest Pi twin to Cursor /loop). Modes: interval | settle | watcher | dynamic (settle+watcher composite; coalesced to prevent double-fire).",
    promptSnippet: "Arm a repeating wake prompt after interval, settle, watcher, or dynamic",
    promptGuidelines: [
      "Use pstack_loop for autonomous-run and babysit wake chains (Pi has no Cursor /loop).",
      "Prefer mode=dynamic (settle+watcher) for babysit/shipping frontiers; pass watchArgv when an event (CI, merge) should wake the agent.",
      "mode=settle / dynamic clears any prior timer before re-arming on agent_settled; dynamic coalesces settle+watcher within 2.5s so they do not double-fire.",
      "mode=watcher fires once when watchArgv exits; mode=dynamic re-arms the watcher after each fire.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "arm | stop | status | list" }),
      mode: Type.Optional(
        Type.String({
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
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.action === "status" || params.action === "list") {
        const rows = formatLoopRows();
        return {
          content: [{ type: "text", text: rows.length ? rows.join("\n") : "(no active loops)" }],
          details: { loops: [...loops.keys()], action: params.action },
        };
      }
      if (params.action === "stop") {
        if (params.id) {
          const s = loops.get(params.id);
          if (s) clearLoop(s);
        } else {
          for (const s of [...loops.values()]) clearLoop(s);
        }
        ctx.ui.setStatus("pstack-loop", undefined);
        return { content: [{ type: "text", text: "stopped" }], details: {} };
      }
      if (params.action !== "arm") throw new Error("action must be arm|stop|status|list");
      if (!params.prompt) throw new Error("prompt required to arm");
      
      const state = validateAndInitLoopState(params);
      ctx.ui.setStatus("pstack-loop", state.id);
      startLoopByMode(state, signal);

      return {
        content: [
          {
            type: "text",
            text: `Armed ${state.id} mode=${state.mode} intervalSeconds=${params.intervalSeconds ?? 1800} maxFires=${state.maxFires}${params.watchArgv?.length ? " watcher=on" : ""} coalesceMs=${DYNAMIC_COALESCE_MS}`,
          },
        ],
        details: { id: state.id, mode: state.mode, coalesceMs: DYNAMIC_COALESCE_MS },
      };
    },
  });
}

/** Test-only: exported coalesce constant for scripted checks. */
export function __testCoalesceMs(): number {
  return DYNAMIC_COALESCE_MS;
}
