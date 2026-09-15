/**
 * Poteto-mode sticky state: immutable state + pure transitions + runtime wiring.
 * Owns sticky entry persistence, playbook matching, and forced skill invocation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  STICKY_ENTRY_TYPE,
  forcePotetoSkillMessage,
  shouldAutoArmFromPlaybookMatch,
  shouldAutoArmFromSkillText,
  shouldAutoArmReadonly,
  shouldMatchStickyInput,
  stickyEntryPayload,
  parseStickyEntry,
} from "../sticky-session.ts";
import { buildPotetoStickyPrompt, matchStickyPlaybook, type PlaybookMatch } from "../sticky-poteto.ts";
import { applyEffects, type Effect, type EffectContext } from "../effects.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface PotetoState {
  readonly enabled: boolean;
  readonly matchedPlaybookId: string | null;
  readonly lastUserText: string;
}

export function createInitialPotetoState(): PotetoState {
  return { enabled: false, matchedPlaybookId: null, lastUserText: "" };
}

export function reduceSetEnabled(
  state: PotetoState,
  enabled: boolean,
  match?: { id: string; score: number } | null,
): { state: PotetoState; effects: Effect[] } {
  const nextPlaybook =
    match === null
      ? null
      : match?.id
        ? match.id
        : enabled
          ? state.matchedPlaybookId
          : null;
  const playbookChanged = nextPlaybook !== state.matchedPlaybookId;
  if (state.enabled === enabled && !playbookChanged && match === undefined) {
    return { state, effects: [] };
  }
  const nextState: PotetoState = {
    enabled,
    matchedPlaybookId: enabled ? nextPlaybook : null,
    lastUserText: state.lastUserText,
  };
  const effects: Effect[] = [
    {
      type: "appendEntry",
      entryType: STICKY_ENTRY_TYPE,
      payload: stickyEntryPayload(enabled, match ?? (nextState.matchedPlaybookId ? { id: nextState.matchedPlaybookId, score: 0 } : null)),
    },
    {
      type: "setStatus",
      statusId: "pstack",
      value: enabled
        ? nextState.matchedPlaybookId
          ? `poteto:${nextState.matchedPlaybookId}`
          : "poteto"
        : undefined,
    },
  ];
  return { state: nextState, effects };
}

export function reducePersistMatch(
  state: PotetoState,
  match: { id: string; score: number },
): { state: PotetoState; effects: Effect[] } {
  const nextState: PotetoState = {
    ...state,
    matchedPlaybookId: match.id,
  };
  const effects: Effect[] = [
    {
      type: "appendEntry",
      entryType: STICKY_ENTRY_TYPE,
      payload: stickyEntryPayload(true, match),
    },
  ];
  return { state: nextState, effects };
}

export function reduceRecordText(state: PotetoState, text: string): PotetoState {
  return { ...state, lastUserText: text };
}

export function reduceRestore(entries: readonly unknown[]): PotetoState {
  let enabled = false;
  let matchedPlaybookId: string | null = null;
  for (const entry of entries) {
    const data = parseStickyEntry(entry);
    enabled = data.enabled;
    if (data.matchedPlaybookId) {
      matchedPlaybookId = data.matchedPlaybookId;
    }
  }
  return { enabled, matchedPlaybookId, lastUserText: "" };
}

export interface PotetoRuntime {
  getState: () => PotetoState;
  setEnabled: (enabled: boolean, ctx: EffectContext, match?: { id: string; score: number } | null) => void;
}

export function createPotetoRuntime(
  pi: ExtensionAPI,
  options: {
    armReadonly: (ctx: EffectContext, reason: string) => void;
  },
): PotetoRuntime {
  let state = createInitialPotetoState();

  const setEnabledImpl = (
    enabled: boolean,
    ctx: EffectContext,
    match?: { id: string; score: number } | null,
  ) => {
    const result = reduceSetEnabled(state, enabled, match);
    state = result.state;
    applyEffects(pi, ctx, result.effects);
  };

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === STICKY_ENTRY_TYPE)
      .map((e) => e.data);
    state = reduceRestore(entries);
    if (state.enabled) {
      ctx.ui.setStatus(
        "pstack",
        state.matchedPlaybookId ? `poteto:${state.matchedPlaybookId}` : "poteto",
      );
    }
  });

  pi.on("input", (event, ctx) => {
    if (!shouldMatchStickyInput(event.source)) return;
    state = reduceRecordText(state, event.text ?? "");
    if (event.text.startsWith("/skill:poteto-mode") || event.text.startsWith("/poteto-mode")) {
      setEnabledImpl(true, ctx);
    }
    let transformText: string | undefined;
    const matched = matchStickyPlaybook(event.text);
    if (matched && matched.score >= 2) {
      if (!state.enabled && matched.score >= 5) {
        setEnabledImpl(true, ctx, { id: matched.id, score: matched.score });
        ctx.ui.notify?.(`Poteto sticky armed via playbook match: ${matched.id}`, "info");
      } else if (state.enabled) {
        const result = reducePersistMatch(state, { id: matched.id, score: matched.score });
        state = result.state;
        applyEffects(pi, ctx, result.effects);
        ctx.ui.setStatus("pstack", `poteto:${matched.id}`);
      }
      if ((state.enabled || matched.score >= 5) && !event.text.startsWith("/skill:poteto-mode")) {
        transformText = forcePotetoSkillMessage(event.text, matched.id);
      }
      if (
        !process.env.PSTACK_CHILD_ROLE &&
        shouldAutoArmFromPlaybookMatch(
          matched.id,
          state.enabled,
          matched.score,
          event.text,
        )
      ) {
        options.armReadonly(ctx, `playbook:${matched.id}`);
      }
    }
    if (!process.env.PSTACK_CHILD_ROLE && shouldAutoArmFromSkillText(event.text)) {
      options.armReadonly(ctx, "skill:investigation");
    }
    if (transformText) {
      return { action: "transform", text: transformText };
    }
  });

  pi.on("before_agent_start", (event) => {
    let prompt = event.systemPrompt;
    if (state.enabled) {
      const live = state.lastUserText ? matchStickyPlaybook(state.lastUserText) : undefined;
      prompt = buildPotetoStickyPrompt(prompt, {
        userText: state.lastUserText,
        match: live ?? null,
        restoredPlaybookId: live ? null : state.matchedPlaybookId,
      });
    }
    if (prompt === event.systemPrompt) return;
    return { systemPrompt: prompt };
  });

  pi.registerCommand("poteto-mode", {
    description: "Enable sticky poteto-mode and force skill invocation (optional task / playbook)",
    handler: async (args, ctx) => {
      const task = args.trim();
      const matched = task ? matchStickyPlaybook(task) : undefined;
      setEnabledImpl(true, ctx, matched ? { id: matched.id, score: matched.score } : undefined);
      if (matched && shouldAutoArmReadonly(matched.id)) {
        options.armReadonly(ctx, `playbook:${matched.id}`);
      }
      if (!task) {
        ctx.ui.notify(
          "Poteto mode on (sticky skill + playbook auto-match; force skill invoke on match). Use /skill:poteto-mode <task> or /poteto-mode <task>.",
          "info",
        );
        return;
      }
      state = reduceRecordText(state, task);
      pi.sendUserMessage(forcePotetoSkillMessage(task, matched?.id), {
        expandPromptTemplates: true,
      });
    },
  });

  pi.registerCommand("poteto-mode-off", {
    description: "Disable sticky poteto-mode",
    handler: async (_args, ctx) => {
      setEnabledImpl(false, ctx);
      ctx.ui.notify("Poteto mode off.", "info");
    },
  });

  pi.registerCommand("pstack", {
    description: "Alias for /poteto-mode",
    handler: async (args, ctx) => {
      const task = args.trim();
      const matched = task ? matchStickyPlaybook(task) : undefined;
      setEnabledImpl(true, ctx, matched ? { id: matched.id, score: matched.score } : undefined);
      if (!task) {
        ctx.ui.notify(
          `pi-pstack tools: pstack_spawn, pstack_jobs, pstack_swarm, pstack_arena, pstack_loop, pstack_deslop, pstack_ship, pstack_babysit, pstack_benny_wake. Readonly: /pstack-readonly. Package: ${PACKAGE_ROOT}`,
          "info",
        );
        return;
      }
      state = reduceRecordText(state, task);
      pi.sendUserMessage(forcePotetoSkillMessage(task, matched?.id), {
        expandPromptTemplates: true,
      });
    },
  });

  return {
    getState: () => state,
    setEnabled: setEnabledImpl,
  };
}
