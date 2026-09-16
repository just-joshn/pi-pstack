/**
 * pstack_loop — closest Pi twin to Cursor /loop.
 * Arms a settle-retry / heartbeat that re-prompts the agent after idle+delay,
 * or after a watcher argv exits. Uses official ExtensionAPI (sendUserMessage,
 * agent_settled, session_shutdown). No Cursor /loop dependency.
 *
 * state.ts holds the FSM as a pure reducer and runtime.ts owns the store, the
 * timers, and the watchers. This module is the registration surface.
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
import { createRun, armLoop, dispatch, nextLoopId, startArmedLoop, stopAllLoops, stopLoop, type HeartbeatRun } from "./runtime.ts";
import {
  COMMAND_MAX_FIRES,
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  formatLoopRows,
  initialLoopState,
  type LoopState,
} from "./state.ts";

export { DYNAMIC_COALESCE_MS, decideFire, shouldSkipSettleArm, materializeWatchArgv, BABYSIT_WATCH_RECIPES } from "./coalesce.ts";
export { formatLoopRows, watcherFireReason } from "./state.ts";

/** The UI surface the loop handlers touch; both ExtensionContext and ExtensionCommandContext satisfy it. */
type LoopUiContext = Pick<ExtensionContext, "ui">;

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

function handleStopAll(run: HeartbeatRun, ctx: LoopUiContext): void {
  stopAllLoops(run);
  ctx.ui.setStatus("pstack-loop", undefined);
  ctx.ui.notify("All pstack loops stopped.", "info");
}

function handleStatusList(loops: Map<string, LoopState>, ctx: LoopUiContext): void {
  const rows = formatLoopRows(loops.values());
  ctx.ui.notify(rows.length ? rows.join("\n") : "(no active loops)", "info");
}

function handleStopOne(run: HeartbeatRun, id: string, ctx: LoopUiContext): void {
  const exists = run.loops.has(id);
  if (exists) stopLoop(run, id);
  if (!run.loops.size) ctx.ui.setStatus("pstack-loop", undefined);
  ctx.ui.notify(exists ? `Stopped ${id}` : `No loop ${id}`, "info");
}

function armIntervalLoop(run: HeartbeatRun, seconds: number, prompt: string, ctx: LoopUiContext): void {
  const id = nextLoopId(run);
  const state = initialLoopState({
    id,
    mode: "interval",
    prompt,
    intervalMs: Math.max(MIN_INTERVAL_SECONDS, seconds) * 1000,
    maxFires: COMMAND_MAX_FIRES,
    watchArgv: [],
  });
  run.loops.set(id, state);
  ctx.ui.setStatus("pstack-loop", id);
  ctx.ui.notify(`Armed ${id} every ${seconds}s`, "info");
  startArmedLoop(run, id);
}

function registerLoopLifecycle(run: HeartbeatRun): void {
  run.pi.on("session_shutdown", () => stopAllLoops(run));
  run.pi.on("agent_settled", () => {
    for (const id of [...run.loops.keys()]) dispatch(run, id, { type: "settle-check" });
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
        const id = stopOne[1];
        if (id !== undefined) handleStopOne(run, id, ctx);
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
      const seconds = m[1];
      const prompt = m[2];
      if (seconds === undefined || prompt === undefined) return;
      armIntervalLoop(run, Number(seconds), prompt, ctx);
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
    const rows = formatLoopRows(run.loops.values());
    return {
      content: [{ type: "text", text: rows.length ? rows.join("\n") : "(no active loops)" }],
      details: { loops: [...run.loops.keys()], action: params.action },
    };
  }
  if (params.action === "stop") {
    if (params.id) {
      if (run.loops.has(params.id)) stopLoop(run, params.id);
    } else {
      for (const id of [...run.loops.keys()]) stopLoop(run, id);
    }
    ctx.ui.setStatus("pstack-loop", undefined);
    return { content: [{ type: "text", text: "stopped" }], details: {} };
  }
  if (params.action !== "arm") throw new Error("action must be arm|stop|status|list");

  const state = armLoop(run, params, signal);
  ctx.ui.setStatus("pstack-loop", state.id);

  return {
    content: [
      {
        type: "text",
        text: `Armed ${state.id} mode=${state.mode} intervalSeconds=${params.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS} maxFires=${state.maxFires}${params.watchArgv?.length ? " watcher=on" : ""} coalesceMs=${DYNAMIC_COALESCE_MS}`,
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
  mode?: string | undefined;
  intervalSeconds?: number | undefined;
  maxFires?: number | undefined;
  watchArgv?: string[] | undefined;
}

let activeRun: HeartbeatRun | undefined;

export function registerHeartbeat(pi: ExtensionAPI): void {
  const run = createRun(pi);
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
  return armLoop(run, {
    id: params.id,
    mode: params.mode,
    prompt: params.prompt,
    intervalSeconds: params.intervalSeconds,
    maxFires: params.maxFires,
    watchArgv: params.watchArgv,
  }).id;
}

export function stopProgrammaticLoop(id: string): boolean {
  const run = activeRun;
  if (!run) return false;
  if (!run.loops.has(id)) return false;
  stopLoop(run, id);
  return true;
}

/** Test-only: exported coalesce constant for scripted checks. */
export function __testCoalesceMs(): number {
  return DYNAMIC_COALESCE_MS;
}
