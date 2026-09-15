/**
 * Session-level readonly state: immutable state + pure transitions + runtime wiring.
 * Owns tool-strip/restore, tool_call blocking, and readonly entry persistence.
 */
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
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
  const alwaysKeep = new Set<string>([...READONLY_TOOLS]);
  const nextActive = [...keep].filter(
    (n) => alwaysKeep.has(n) || allTools.includes(n) || toolsBefore.includes(n),
  );
  return { nextActive, toolsBefore };
}

export function reduceSetEnabled(
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
    ...(state.toolsBefore?.length
      ? [{ type: "setActiveTools" as const, tools: state.toolsBefore, guarded: true }]
      : []),
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

interface ReadonlyStateRef {
  state: ReadonlyState;
}

type ReadonlySetEnabled = ReadonlyRuntime["setEnabled"];

type ToolCallDecision = { block: true; reason: string } | { coerceReadonly: true } | undefined;

function makeSetEnabled(pi: ExtensionAPI, stateRef: ReadonlyStateRef): ReadonlySetEnabled {
  return (enabled, ctx, reason) => {
    const result = reduceSetEnabled(
      stateRef.state,
      enabled,
      {
        allTools: pi.getAllTools().map((t) => t.name),
        activeTools: pi.getActiveTools(),
      },
      reason,
    );
    stateRef.state = result.state;
    applyEffects(pi, ctx, result.effects);
  };
}

function restoreReadonlyState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  stateRef: ReadonlyStateRef,
): void {
  const entries = ctx.sessionManager
    .getBranch()
    .filter((e) => e.type === "custom" && e.customType === READONLY_ENTRY_TYPE)
    .map((e) => e.data);
  const restored = restoreFromEntries(entries);
  stateRef.state = createInitialReadonlyState();
  if (restored.enabled) {
    const computed = computeReadonlyTools(
      pi.getAllTools().map((t) => t.name),
      pi.getActiveTools(),
      SESSION_WRITE_TOOLS,
    );
    stateRef.state = { enabled: true, toolsBefore: computed.toolsBefore };
    ctx.ui.setStatus("pstack-ro", "readonly");
    pi.setActiveTools(computed.nextActive);
  }
}

type ReadonlyAction = "block" | "allow" | "coerceReadonly";

interface ReadonlyPolicyDecision {
  readonly action: ReadonlyAction;
  readonly reason?: string;
}

type ReadonlyToolPolicy = (input: unknown) => ReadonlyPolicyDecision;

function blockPolicy(reason: string): ReadonlyToolPolicy {
  return () => ({ action: "block", reason });
}

function writeToolPolicy(name: string): ReadonlyToolPolicy {
  return blockPolicy(
    `pstack session readonly: blocked ${name}. Use /pstack-readonly-off to re-enable writes.`,
  );
}

const allowPolicy: ReadonlyToolPolicy = () => ({ action: "allow" });

function actionOf(input: unknown): string | undefined {
  return (input as { action?: string } | undefined)?.action;
}

function worktreePolicy(input: unknown): ReadonlyPolicyDecision {
  const action = actionOf(input);
  if (action && action !== "list") {
    return { action: "block", reason: "pstack session readonly: blocked mutating pstack_worktree." };
  }
  return { action: "allow" };
}

function deslopPolicy(input: unknown): ReadonlyPolicyDecision {
  const value = input as { applySafe?: boolean; autoApply?: boolean };
  if (value.applySafe || value.autoApply) {
    return { action: "block", reason: "pstack session readonly: blocked deslop applySafe/autoApply." };
  }
  return { action: "allow" };
}

function spawnPolicy(input: unknown): ReadonlyPolicyDecision {
  const value = input as { readonly?: boolean; role?: string };
  const role = value.role ?? "general";
  const ok = value.readonly === true || role === "investigator" || role === "comment-sicko";
  return { action: ok ? "allow" : "coerceReadonly" };
}

function loopPolicy(input: unknown): ReadonlyPolicyDecision {
  const action = actionOf(input);
  if (action === "status" || action === "list" || action === "stop") return { action: "allow" };
  return { action: "block", reason: "pstack session readonly: blocked pstack_loop arm (subprocess watcher)." };
}

function bennyWakePolicy(input: unknown): ReadonlyPolicyDecision {
  if (actionOf(input) === "path") return { action: "allow" };
  return { action: "block", reason: "pstack session readonly: blocked pstack_benny_wake write." };
}

/**
 * One policy per tool the extension registers. A tool absent from the table is
 * allowed. The census in tests/layers/01-unit/readonly-state.test.ts fails when
 * a registered pstack tool has no entry, so a new tool cannot slip past this.
 */
export const READONLY_TOOL_POLICIES: Record<string, ReadonlyToolPolicy> = {
  write: writeToolPolicy("write"),
  edit: writeToolPolicy("edit"),
  bash: writeToolPolicy("bash"),
  powershell: writeToolPolicy("powershell"),
  pstack_worktree: worktreePolicy,
  pstack_ship: blockPolicy("pstack session readonly: blocked pstack_ship."),
  pstack_babysit: blockPolicy("pstack session readonly: blocked pstack_babysit."),
  pstack_deslop: deslopPolicy,
  pstack_spawn: spawnPolicy,
  pstack_swarm: blockPolicy("pstack session readonly: blocked pstack_swarm."),
  pstack_arena: blockPolicy("pstack session readonly: blocked pstack_arena."),
  pstack_loop: loopPolicy,
  pstack_decision_log: blockPolicy("pstack session readonly: blocked pstack_decision_log."),
  pstack_benny_wake: bennyWakePolicy,
  pstack_control_cli: blockPolicy("pstack session readonly: blocked pstack_control_cli."),
  pstack_control_ui: allowPolicy,
  pstack_sessions: allowPolicy,
  pstack_jobs: allowPolicy,
};

function decideToolCall(state: ReadonlyState, event: ToolCallEvent): ToolCallDecision {
  if (!state.enabled) return undefined;
  const policy = READONLY_TOOL_POLICIES[event.toolName];
  if (!policy) return undefined;
  const decision = policy(event.input);
  if (decision.action === "allow") return undefined;
  if (decision.action === "coerceReadonly") return { coerceReadonly: true };
  return {
    block: true,
    reason: decision.reason ?? `pstack session readonly: blocked ${event.toolName}.`,
  };
}

function registerReadonlyHooks(pi: ExtensionAPI, stateRef: ReadonlyStateRef): void {
  pi.on("session_start", (_event, ctx) => {
    restoreReadonlyState(pi, ctx, stateRef);
  });

  pi.on("before_agent_start", (event) => {
    if (!stateRef.state.enabled) return;
    const prompt = `${event.systemPrompt}\n\n## pstack session readonly\nThis session is read-only. Do not write, edit, or run bash. Use read/grep/find/ls (and read-safe pstack_* tools). Spawn children with readonly:true or role investigator/comment-sicko. Deliver citations and recommendations only.`;
    return { systemPrompt: prompt };
  });

  pi.on("tool_call", (event) => {
    const decision = decideToolCall(stateRef.state, event);
    if (!decision) return;
    if ("coerceReadonly" in decision) {
      (event.input as { readonly?: boolean }).readonly = true;
      return;
    }
    return decision;
  });
}

function registerReadonlyCommands(pi: ExtensionAPI, setEnabled: ReadonlySetEnabled): void {
  pi.registerCommand("pstack-readonly", {
    description: "Enable session-level read-only (strip write/edit/bash)",
    handler: async (_args, ctx) => {
      setEnabled(true, ctx, "command");
    },
  });

  pi.registerCommand("pstack-readonly-off", {
    description: "Disable session-level read-only",
    handler: async (_args, ctx) => {
      setEnabled(false, ctx);
    },
  });
}

export function createReadonlyRuntime(pi: ExtensionAPI): ReadonlyRuntime {
  const stateRef: ReadonlyStateRef = { state: createInitialReadonlyState() };
  const setEnabled = makeSetEnabled(pi, stateRef);
  registerReadonlyHooks(pi, stateRef);
  registerReadonlyCommands(pi, setEnabled);
  return { getState: () => stateRef.state, setEnabled };
}
