/**
 * pstack_loop — closest Pi twin to Cursor /loop.
 * Arms a settle-retry / heartbeat that re-prompts the agent after idle+delay,
 * or after a watcher argv exits. Uses official ExtensionAPI (sendUserMessage,
 * agent_settled, session_shutdown). No Cursor /loop dependency.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface LoopState {
  id: string;
  mode: "interval" | "watcher" | "settle";
  prompt: string;
  intervalMs: number;
  maxFires: number;
  fires: number;
  timer?: ReturnType<typeof setTimeout>;
  child?: { kill: (sig?: string) => void };
  armed: boolean;
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
    } catch {
      /* ignore */
    }
    loops.delete(state.id);
  };

  const fire = (state: LoopState, reason: string) => {
    if (!state.armed) return;
    state.fires++;
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
    if (state.mode === "interval" && state.armed) {
      clearTimer(state);
      state.timer = setTimeout(() => fire(state, "interval"), state.intervalMs);
      state.timer.unref?.();
    }
  };

  pi.on("session_shutdown", () => {
    for (const state of loops.values()) clearLoop(state);
    loops = new Map();
  });

  pi.on("agent_settled", () => {
    for (const state of loops.values()) {
      if (state.mode === "settle" && state.armed) {
        // Clear before re-arm so settle events do not stack uncleared timers.
        clearTimer(state);
        state.timer = setTimeout(() => fire(state, "settle"), state.intervalMs);
        state.timer.unref?.();
      }
    }
  });

  pi.registerCommand("pstack-loop", {
    description: "Arm a heartbeat/settle loop (Cursor /loop twin). Args: <seconds> <prompt…>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "off" || trimmed === "stop") {
        for (const state of [...loops.values()]) clearLoop(state);
        ctx.ui.notify("All pstack loops stopped.", "info");
        return;
      }
      const m = trimmed.match(/^(\d+)\s+([\s\S]+)$/);
      if (!m) {
        ctx.ui.notify("Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop off", "error");
        return;
      }
      const seconds = Number(m[1]);
      const prompt = m[2];
      const id = `loop-${++seq}`;
      const state: LoopState = {
        id,
        mode: "interval",
        prompt,
        intervalMs: Math.max(5, seconds) * 1000,
        maxFires: 100,
        fires: 0,
        armed: true,
      };
      loops.set(id, state);
      ctx.ui.setStatus("pstack-loop", id);
      ctx.ui.notify(`Armed ${id} every ${seconds}s`, "info");
      clearTimer(state);
      state.timer = setTimeout(() => fire(state, "interval"), state.intervalMs);
      state.timer.unref?.();
    },
  });

  pi.registerTool({
    name: "pstack_loop",
    label: "Pstack Loop",
    description:
      "Arm, status, or stop a heartbeat / settle-retry loop (closest Pi twin to Cursor /loop). Modes: interval | settle | watcher. There is no dynamic mode.",
    promptSnippet: "Arm a repeating wake prompt after interval or agent settle",
    promptGuidelines: [
      "Use pstack_loop instead of Cursor /loop for autonomous-run and babysit wake chains.",
      "Prefer mode=watcher with watchArgv (argv array, never a raw shell string) when an event (CI, merge) should wake the agent.",
      "mode=settle clears any prior timer before re-arming on agent_settled.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "arm | stop | status" }),
      mode: Type.Optional(Type.String({ description: "interval | settle | watcher (default interval). No dynamic." })),
      prompt: Type.Optional(Type.String({ description: "Prompt to inject on each fire" })),
      intervalSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 86400 })),
      maxFires: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
      watchArgv: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "For mode=watcher: argv array [command, ...args] (no shell). On exit the loop fires once with stdout.",
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
      if (params.action === "status") {
        const rows = [...loops.values()].map(
          (s) => `${s.id} mode=${s.mode} fires=${s.fires}/${s.maxFires} armed=${s.armed}`,
        );
        return {
          content: [{ type: "text", text: rows.length ? rows.join("\n") : "(no active loops)" }],
          details: { loops: [...loops.keys()] },
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
      if (params.action !== "arm") throw new Error("action must be arm|stop|status");
      if (!params.prompt) throw new Error("prompt required to arm");
      if (params.mode === "dynamic") {
        throw new Error("pstack_loop has no dynamic mode; use interval, settle, or watcher");
      }
      if (params.watchCommand) {
        throw new Error("watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array");
      }
      const id = params.id ?? `loop-${++seq}`;
      const existing = loops.get(id);
      if (existing) clearLoop(existing);
      const mode = (params.mode as LoopState["mode"]) || "interval";
      if (mode !== "interval" && mode !== "settle" && mode !== "watcher") {
        throw new Error("mode must be interval|settle|watcher");
      }
      const state: LoopState = {
        id,
        mode,
        prompt: params.prompt,
        intervalMs: (params.intervalSeconds ?? 1800) * 1000,
        maxFires: params.maxFires ?? 50,
        fires: 0,
        armed: true,
      };
      loops.set(id, state);
      ctx.ui.setStatus("pstack-loop", id);

      if (mode === "watcher") {
        const argv = params.watchArgv;
        if (!argv?.length) throw new Error("watchArgv required for mode=watcher");
        const [command, ...args] = argv;
        if (!command || command.startsWith("-")) {
          throw new Error("watchArgv[0] must be a command path/name (not an option)");
        }
        void (async () => {
          const result = await pi.exec(command, args, {
            signal,
            timeout: 24 * 60 * 60 * 1000,
          });
          if (!state.armed) return;
          const out = (result.stdout || result.stderr || "").slice(0, 8000);
          state.prompt = `${params.prompt}\n\n--- watcher output ---\n${out}`;
          fire(state, "watcher");
        })();
      } else if (mode === "interval") {
        clearTimer(state);
        state.timer = setTimeout(() => fire(state, "interval"), state.intervalMs);
        state.timer.unref?.();
      }
      // settle mode waits for agent_settled hook (timer cleared before each re-arm)

      return {
        content: [
          {
            type: "text",
            text: `Armed ${id} mode=${mode} intervalSeconds=${params.intervalSeconds ?? 1800} maxFires=${state.maxFires}`,
          },
        ],
        details: { id, mode },
      };
    },
  });
}
