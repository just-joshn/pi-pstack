import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { sendWorkflow } from "./catalog-ui.ts";
import { mergeRoutes } from "./forge.ts";
import { nativeNode, routes } from "./lib/catalog.ts";
import {
  addTasks,
  isTaskStatus,
  planComplete,
  startPlan,
  stopped,
  summary,
  taskStatuses,
  updateTask,
  wakeConfig,
} from "./lib/state.ts";
import { planCall, planChecklist } from "./plan-view.ts";
import type { Session } from "./session.ts";
import {
  artifacts,
  atomicWrite,
  fail,
  type Notify,
  result,
  stringEnum,
  text,
  unreachable,
} from "./support.ts";

const planParameters = Type.Object({
  action: stringEnum(["start", "custom", "add", "show", "update", "finish"]),
  route: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(Type.String())),
  task: Type.Optional(Type.Integer()),
  status: Type.Optional(stringEnum(taskStatuses)),
  evidence: Type.Optional(Type.String()),
});
async function approveMergeRoute(ctx: ExtensionContext, route: string, goal: string) {
  if (!mergeRoutes.includes(route)) return;
  const approved =
    ctx.hasUI &&
    (await ctx.ui.confirm(
      `Start the merge-capable ${route} plan?`,
      `${goal}\nThis route enables pstack_ship; each merge still needs its own approval.`,
    ));
  if (!approved)
    fail(`Starting ${route} requires operator approval; use /pstack-run ${route} <goal>`);
}

function registerModeCommands(pi: ExtensionAPI, session: Session, notify: Notify) {
  pi.registerCommand("poteto-mode", {
    description: "Run a task with poteto-mode, or persist it with on/off",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "on" || value === "off") return session.commit(ctx, { mode: value === "on" });
      if (value) return sendWorkflow(pi, "poteto-mode", value);
      if (!ctx.hasUI) return notify(ctx, "Use /poteto-mode on or /poteto-mode <goal>.");
      const goal = await ctx.ui.input("Goal and observable completion predicate");
      if (goal) sendWorkflow(pi, "poteto-mode", goal);
    },
  });
  pi.registerCommand("pstack-run", {
    description: "Run an explicit playbook: /pstack-run <route> <goal>",
    handler: async (args, ctx) => {
      const [route, ...words] = args.trim().split(/\s+/);
      const goal = words.join(" ");
      if (!route || !routes.includes(route) || !goal)
        return notify(ctx, `Choose a route and goal:\n${routes.join(", ")}`);
      session.commit(ctx, { plan: startPlan(route, goal) });
      sendWorkflow(pi, "pb-" + route, goal);
    },
  });
}

function registerStateCommands(pi: ExtensionAPI, session: Session, notify: Notify) {
  pi.registerCommand("pstack-status", {
    description: "Show current goal, route, tasks and loop",
    handler: async (_args, ctx) => notify(ctx, text(summary(session.state()))),
  });
  pi.registerCommand("pstack-clear", {
    description: "Clear the current plan and goal; preserve artifacts",
    handler: async (_args, ctx) => session.commit(ctx, { goal: "", plan: null, wake: null }),
  });
  pi.registerCommand("pstack-goal", {
    description: "Set or clear a persistent branch goal",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) return notify(ctx, session.state().goal || "No goal");
      session.commit(ctx, { goal: goal === "clear" ? "" : goal });
    },
  });
}

function registerWakeCommands(pi: ExtensionAPI, session: Session, notify: Notify) {
  pi.registerCommand("pstack-loop", {
    description: "Start a bounded interactive wake loop: <seconds> <max> <predicate>, or stop",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input === "stop") return session.stopWake(ctx);
      if (!input) return notify(ctx, text(session.state().wake));
      if (ctx.mode !== "tui") fail("Wake loops require an open interactive Pi session.");
      const [seconds, max, ...words] = input.split(/\s+/);
      const next = wakeConfig(Number(seconds), Number(max), words.join(" "));
      if (await ctx.ui.confirm("Start bounded autonomous wake loop?", text(next)))
        session.startWake(ctx, next);
    },
  });
  pi.registerCommand("pstack-pause", {
    description: "Pause wakes and preserve a session resume note",
    handler: async (_args, ctx) => {
      session.stopWake(ctx);
      const path = join(artifacts(ctx), "resume.json");
      const note = {
        ...summary(session.state()),
        cwd: ctx.cwd,
        session: ctx.sessionManager.getSessionFile(),
      };
      await atomicWrite(path, JSON.stringify(note, null, 2));
      notify(ctx, `Paused. Resume note: ${path}`);
    },
  });
}

async function runPlanAction(
  session: Session,
  ctx: ExtensionContext,
  p: Static<typeof planParameters>,
) {
  const { plan, wake } = session.state();
  let instructions: string | undefined;
  switch (p.action) {
    case "show":
      return summary(session.state());
    case "start": {
      const route = p.route;
      const goal = p.goal ?? "";
      if (!route || !routes.includes(route)) fail("Choose a known playbook or use action custom");
      await approveMergeRoute(ctx, route, goal);
      instructions = nativeNode("pb-" + route).instructions;
      session.commit(ctx, { plan: startPlan(route, goal) });
      break;
    }
    case "custom":
      session.commit(ctx, { plan: startPlan("figure-it-out", p.goal ?? "", p.steps) });
      break;
    case "add":
      session.commit(ctx, { plan: addTasks(plan, p.steps, p.task) });
      break;
    case "update":
      if (p.task === undefined || !isTaskStatus(p.status)) fail("Specify task and status");
      session.commit(ctx, { plan: updateTask(plan, p.task, p.status, p.evidence) });
      break;
    case "finish":
      if (!plan || !planComplete(plan) || !p.evidence?.trim())
        fail("Incomplete plan or missing final evidence");
      session.commit(ctx, { plan: { ...plan, finishedEvidence: p.evidence }, wake: stopped(wake) });
      break;
    default:
      unreachable(p.action);
  }
  return { state: summary(session.state()), instructions };
}

function registerPlanTools(pi: ExtensionAPI, session: Session) {
  pi.registerTool({
    name: "pstack_plan",
    label: "Pstack plan",
    description:
      "Maintain branch-local plan. Start with a route and goal or custom steps for figure-it-out. Add tasks (steps) to the open plan, after task `task` or at the end. Mark tasks with real evidence. Finish only when all are done or justified skips.",
    executionMode: "sequential",
    parameters: planParameters,
    async execute(_id, p, _signal, _update, ctx) {
      const outcome = await runPlanAction(session, ctx, p);
      return { ...result(outcome), details: session.state().plan };
    },
    renderCall: (args, theme) => planCall(args, theme),
    renderResult: (output, _options, theme) => planChecklist(output.details, theme),
  });
  pi.registerTool({
    name: "pstack_wake",
    label: "Pstack wake status",
    description:
      "Start, show or stop the wake loop. A started loop wakes this session every `seconds` (5 to 86400), up to `max` times (1 to 100), to check `predicate`; stop it with evidence when the predicate holds or is blocked. Wakes need an open interactive session.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: stringEnum(["start", "show", "stop"]),
      seconds: Type.Optional(Type.Integer()),
      max: Type.Optional(Type.Integer()),
      predicate: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === "start") {
        if (ctx.mode !== "tui") fail("Wake loops require an open interactive Pi session.");
        session.startWake(ctx, wakeConfig(p.seconds ?? 0, p.max ?? 0, p.predicate ?? ""));
      }
      if (p.action === "stop") {
        if (!p.evidence?.trim()) fail("Provide stop evidence or blocker");
        session.stopWake(ctx, p.evidence);
      }
      return result(session.state().wake);
    },
  });
}

export function registerPlan(pi: ExtensionAPI, session: Session, notify: Notify) {
  registerModeCommands(pi, session, notify);
  registerStateCommands(pi, session, notify);
  registerWakeCommands(pi, session, notify);
  registerPlanTools(pi, session);
}
