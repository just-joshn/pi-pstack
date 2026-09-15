/**
 * Session-level readonly state: immutable state + pure transitions + runtime wiring.
 * Owns tool-strip/restore, tool_call blocking, and readonly entry persistence.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { READONLY_ENTRY_TYPE, parseReadonlyEntry } from "../sticky-session.ts";
import { READONLY_TOOLS } from "../subagents/child-runner.ts";
import { applyEffects, type Effect, type EffectContext } from "../effects.ts";

const SESSION_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "powershell",
]);

export interface ReadonlyState {
  readonly enabled: boolean;
  readonly toolsBefore: string[] | undefined;
}

export function createInitialReadonlyState(): ReadonlyState {
  return { enabled: false, toolsBefore: undefined };
}

export function computeReadonlyTools(
  allTools: readonly string[],
  activeTools: readonly string[],
  writeBlocked: ReadonlySet<string>,
): { nextActive: string[]; toolsBefore: string[] } {
  const toolsBefore = activeTools.length ? [...activeTools] : [...allTools];
  const keep = new Set<string>([...READONLY_TOOLS]);
  for (const name of toolsBefore) {
    if (name.startsWith("pstack_") && !writeBlocked.has(name)) {
      keep.add(name);
    }
    if (name === "read" || name === "grep" || name === "find" || name === "ls") {
      keep.add(name);
    }
  }
  const nextActive = [...keep].filter(
    (n) => allTools.includes(n) || toolsBefore.includes(n),
  );
  return { nextActive, toolsBefore };
}

function setEnabled(
  state: ReadonlyState,
  enabled: boolean,
  ctx: {
    allTools: string[];
    activeTools: string[];
  },
  reason?: string,
): { state: ReadonlyState; effects: Effect[] } {
  if (state.enabled === enabled) {
    return { state, effects: [] };
  }
  const baseEffect: Effect = {
    type: "appendEntry",
    entryType: READONLY_ENTRY_TYPE,
    payload: { enabled, reason, updatedAt: Date.now() },
  };
  if (enabled) {
    const computed = computeReadonlyTools(ctx.allTools, ctx.activeTools, SESSION_WRITE_TOOLS);
    return {
      state: { enabled: true, toolsBefore: computed.toolsBefore },
      effects: [
        baseEffect,
        { type: "setActiveTools", tools: computed.nextActive },
        { type: "setStatus", statusId: "pstack-ro", value: "readonly" },
        {
          type: "notify",
          message: reason
            ? `Session readonly on (${reason}): write/edit/bash blocked.`
            : "Session readonly on: write/edit/bash blocked.",
          level: "info",
        },
      ],
    };
  }
  const offEffects: Effect[] = [
    baseEffect,
    ...(state.toolsBefore?.length ? [{ type: "setActiveTools" as const, tools: state.toolsBefore }] : []),
    { type: "setStatus" as const, statusId: "pstack-ro", value: undefined },
    { type: "notify" as const, message: "Session readonly off.", level: "info" as const },
  ];
  return { state: { enabled: false, toolsBefore: undefined }, effects: offEffects };
}

function restoreFromEntries(entries: readonly unknown[]): { enabled: boolean } {
  let enabled = false;
  for (const entry of entries) {
    const data = parseReadonlyEntry(entry);
    enabled = data.enabled;
  }
  return { enabled };
}

export interface ReadonlyRuntime {
  getState: () => ReadonlyState;
  setEnabled: (enabled: boolean, ctx: EffectContext, reason?: string) => void;
}

export function createReadonlyRuntime(pi: ExtensionAPI): ReadonlyRuntime {
  let state = createInitialReadonlyState();

  const setEnabledImpl = (enabled: boolean, ctx: EffectContext, reason?: string) => {
    const result = setEnabled(
      state,
      enabled,
      {
        allTools: pi.getAllTools().map((t) => t.name),
        activeTools: pi.getActiveTools(),
      },
      reason,
    );
    state = result.state;
    applyEffects(pi, ctx, result.effects);
  };

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === READONLY_ENTRY_TYPE)
      .map((e) => e.data);
    const restored = restoreFromEntries(entries);
    state = createInitialReadonlyState();
    if (restored.enabled) {
      const computed = computeReadonlyTools(
        pi.getAllTools().map((t) => t.name),
        pi.getActiveTools(),
        SESSION_WRITE_TOOLS,
      );
      state = { enabled: true, toolsBefore: computed.toolsBefore };
      ctx.ui.setStatus("pstack-ro", "readonly");
      pi.setActiveTools(computed.nextActive);
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!state.enabled) return;
    const prompt = `${event.systemPrompt}\n\n## pstack session readonly\nThis session is read-only. Do not write, edit, or run bash. Use read/grep/find/ls (and read-safe pstack_* tools). Spawn children with readonly:true or role investigator/comment-sicko. Deliver citations and recommendations only.`;
    return { systemPrompt: prompt };
  });

  pi.on("tool_call", (event) => {
    if (!state.enabled) return;
    const name = event.toolName;
    if (SESSION_WRITE_TOOLS.has(name)) {
      return {
        block: true,
        reason: `pstack session readonly: blocked ${name}. Use /pstack-readonly-off to re-enable writes.`,
      };
    }
    if (name === "pstack_worktree") {
      const action = (event.input as { action?: string } | undefined)?.action;
      if (action && action !== "list") {
        return {
          block: true,
          reason: "pstack session readonly: blocked mutating pstack_worktree.",
        };
      }
    }
    if (name === "pstack_ship" || name === "pstack_babysit") {
      return {
        block: true,
        reason: `pstack session readonly: blocked ${name}.`,
      };
    }
    if (name === "pstack_deslop") {
      const input = event.input as { applySafe?: boolean; autoApply?: boolean };
      if (input.applySafe || input.autoApply) {
        return {
          block: true,
          reason: "pstack session readonly: blocked deslop applySafe/autoApply.",
        };
      }
    }
    if (name === "pstack_spawn" || name === "pstack_swarm" || name === "pstack_arena") {
      const input = event.input as {
        readonly?: boolean;
        role?: string;
      };
      if (name === "pstack_spawn") {
        const role = input.role ?? "general";
        const ok =
          input.readonly === true || role === "investigator" || role === "comment-sicko";
        if (!ok) {
          (event.input as { readonly?: boolean }).readonly = true;
        }
      }
    }
    return;
  });

  pi.registerCommand("pstack-readonly", {
    description: "Enable session-level read-only (strip write/edit/bash)",
    handler: async (_args, ctx) => {
      setEnabledImpl(true, ctx, "command");
    },
  });

  pi.registerCommand("pstack-readonly-off", {
    description: "Disable session-level read-only",
    handler: async (_args, ctx) => {
      setEnabledImpl(false, ctx);
    },
  });

  return {
    getState: () => state,
    setEnabled: setEnabledImpl,
  };
}
