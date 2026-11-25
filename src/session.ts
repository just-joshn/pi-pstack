import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { packageFile, routeTriggers } from "./lib/catalog.ts";
import {
  activePlan,
  initialState,
  restore,
  type State,
  stateType,
  stopped,
  type TaskStatus,
  type Wake,
} from "./lib/state.ts";

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

/** Team Kit's always-applied rules; loaded with poteto-mode so non-TypeScript sessions skip them. */
const teamKitRules = [
  "Team Kit rules:",
  packageFile("reference/rules/no-inline-imports.md"),
  packageFile("reference/rules/typescript-exhaustive-switch.md"),
].join("\n\n");

function systemPromptAdditions(state: State) {
  const plan = activePlan(state);
  return [
    ...(state.mode
      ? [
          teamKitRules,
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

function wakeMessage(count: number, wake: Wake) {
  return {
    customType: "pstack-wake",
    content: `Wake ${count}/${wake.max}. Check the actual predicate: ${wake.predicate}. Inspect new evidence, take one authorized step if needed, record it, and call pstack_wake action stop when verified or blocked. Do not assume completion.`,
    display: true,
  };
}

/** A deep copy that nothing can change, so state changes only through commit. */
function frozen(state: State): State {
  const copy = structuredClone(state);
  const freeze = (value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}

/** Branch state persisted as session entries and mirrored in the status bar and widget. */
function createStore(pi: ExtensionAPI) {
  let state = frozen(initialState());
  function refresh(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("pstack", statusLine(state));
    ctx.ui.setWidget(
      "pstack",
      state.plan?.tasks.map((t) => `${markers[t.status]} ${t.id}. ${t.text}`),
    );
  }
  return {
    state: () => state,
    commit(ctx: ExtensionContext, change: Partial<State>) {
      state = frozen({ ...state, ...change });
      pi.appendEntry(stateType, structuredClone(state));
      refresh(ctx);
    },
    restore(ctx: ExtensionContext) {
      state = frozen(restore(ctx.sessionManager.getBranch()));
      refresh(ctx);
    },
    halt() {
      state = frozen({ ...state, wake: stopped(state.wake) });
    },
  };
}

interface SessionEvents {
  state: () => State;
  restoreBranch: (ctx: ExtensionContext) => void;
  shutdown: () => void;
  stopWake: (ctx: ExtensionContext) => void;
  schedule: (ctx: ExtensionContext) => void;
}
function listen(pi: ExtensionAPI, session: SessionEvents) {
  pi.on("session_start", (_event, ctx) => session.restoreBranch(ctx));
  pi.on("session_tree", (_event, ctx) => session.restoreBranch(ctx));
  pi.on("session_shutdown", () => session.shutdown());
  pi.on("agent_settled", (event, ctx) => {
    const wake = session.state().wake;
    if (wake?.running && (event.aborted || wake.count >= wake.max)) session.stopWake(ctx);
    else session.schedule(ctx);
  });
  pi.on("before_agent_start", (event) => {
    const additions = systemPromptAdditions(session.state());
    if (!additions.length) return undefined;
    return { systemPrompt: [event.systemPrompt, ...additions].join("\n\n") };
  });
}

export function createSession(pi: ExtensionAPI) {
  const store = createStore(pi);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function commit(ctx: ExtensionContext, change: Partial<State>) {
    store.commit(ctx, change);
    if (!store.state().wake?.running) clearTimer();
  }
  const stopWake = (ctx: ExtensionContext, evidence?: string) =>
    commit(ctx, { wake: stopped(store.state().wake, evidence) });

  function wakeUp(ctx: ExtensionContext) {
    timer = undefined;
    const wake = store.state().wake;
    if (!wake?.running) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return schedule(ctx);
    if (wake.count >= wake.max) return stopWake(ctx);
    const count = wake.count + 1;
    commit(ctx, { wake: { ...wake, count } });
    pi.sendMessage(wakeMessage(count, wake), { triggerTurn: true, deliverAs: "followUp" });
  }
  function schedule(ctx: ExtensionContext) {
    const wake = store.state().wake;
    if (timer || !wake?.running || ctx.mode !== "tui") return;
    timer = setTimeout(() => wakeUp(ctx), wake.seconds * 1000);
  }
  function startWake(ctx: ExtensionContext, wake: Wake) {
    clearTimer();
    commit(ctx, { wake });
    schedule(ctx);
  }
  function restoreBranch(ctx: ExtensionContext) {
    clearTimer();
    store.restore(ctx);
  }
  function shutdown() {
    clearTimer();
    store.halt();
  }
  listen(pi, { state: store.state, restoreBranch, shutdown, stopWake, schedule });

  return { state: store.state, commit, stopWake, startWake };
}
export type Session = ReturnType<typeof createSession>;
