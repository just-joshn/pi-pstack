import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { packageFile, routeTriggers } from "../lib/catalog.ts";
import {
  activePlan,
  initialState,
  restore,
  stateType,
  stopped,
  type State,
  type TaskStatus,
  type Wake,
} from "../lib/state.ts";

const markers: Record<TaskStatus, string> = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
  blocked: "[!]",
  skipped: "[-]",
};

function statusLine({ mode, plan, wake }: State) {
  if (!mode && !plan && !wake?.running) return undefined;
  const closed = plan?.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const progress = plan ? ` | ${plan.route} ${closed}/${plan.tasks.length}` : "";
  return `pstack ${mode ? "on" : "off"}${progress}${wake?.running ? " | loop" : ""}`;
}

function systemPromptAdditions(state: State) {
  const plan = activePlan(state);
  return [
    ...(state.mode
      ? [
          packageFile("skills/poteto-mode/SKILL.md"),
          `Native playbook triggers:\n${routeTriggers()
            .map((r) => `${r.id}: ${r.when}`)
            .join("\n")}`,
        ]
      : []),
    ...(state.goal ? [`Persistent operator goal: ${state.goal}`] : []),
    ...(plan
      ? [`Branch-local task state (call pstack_plan to update): ${JSON.stringify(plan)}`]
      : []),
  ];
}

export function createSession(pi: ExtensionAPI) {
  let state = initialState();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("pstack", statusLine(state));
    ctx.ui.setWidget(
      "pstack",
      state.plan?.tasks.map((t) => `${markers[t.status]} ${t.id}. ${t.text}`),
    );
  }
  function commit(ctx: ExtensionContext, change: Partial<State>) {
    state = { ...state, ...change };
    if (!state.wake?.running) clearTimer();
    pi.appendEntry(stateType, structuredClone(state));
    refresh(ctx);
  }
  const stopWake = (ctx: ExtensionContext, evidence?: string) =>
    commit(ctx, { wake: stopped(state.wake, evidence) });

  function wakeUp(ctx: ExtensionContext) {
    timer = undefined;
    const wake = state.wake;
    if (!wake?.running) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return schedule(ctx);
    if (wake.count >= wake.max) return stopWake(ctx);
    const count = wake.count + 1;
    commit(ctx, { wake: { ...wake, count } });
    pi.sendMessage(
      {
        customType: "pstack-wake",
        content: `Wake ${count}/${wake.max}. Check the actual predicate: ${wake.predicate}. Inspect new evidence, take one authorized step if needed, record it, and call pstack_wake action stop when verified or blocked. Do not assume completion.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }
  function schedule(ctx: ExtensionContext) {
    if (timer || !state.wake?.running || ctx.mode !== "tui") return;
    timer = setTimeout(() => wakeUp(ctx), state.wake.seconds * 1000);
  }
  function startWake(ctx: ExtensionContext, wake: Wake) {
    clearTimer();
    commit(ctx, { wake });
    schedule(ctx);
  }
  function restoreBranch(ctx: ExtensionContext) {
    clearTimer();
    state = restore(ctx.sessionManager.getBranch());
    refresh(ctx);
  }

  pi.on("session_start", (_event, ctx) => restoreBranch(ctx));
  pi.on("session_tree", (_event, ctx) => restoreBranch(ctx));
  pi.on("session_shutdown", () => {
    clearTimer();
    state = { ...state, wake: stopped(state.wake) };
  });
  pi.on("agent_settled", (event, ctx) => {
    const wake = state.wake;
    if (wake?.running && (event.aborted || wake.count >= wake.max)) stopWake(ctx);
    else schedule(ctx);
  });
  pi.on("before_agent_start", (event) => {
    const additions = systemPromptAdditions(state);
    if (!additions.length) return undefined;
    return { systemPrompt: [event.systemPrompt, ...additions].join("\n\n") };
  });

  return { state: () => state, commit, stopWake, startWake };
}
export type Session = ReturnType<typeof createSession>;
