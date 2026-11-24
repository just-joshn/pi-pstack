import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { nativeNode, routes, workflowPrompt } from "../lib/catalog.ts";
import {
  isTaskStatus,
  planComplete,
  startPlan,
  stopped,
  summary,
  taskStatuses,
  updateTask,
  wakeConfig,
  type Plan,
  type TaskStatus,
} from "../lib/state.ts";
import { mergeRoutes } from "./forge.ts";
import type { Session } from "./session.ts";
import {
  artifacts,
  atomicWrite,
  fail,
  result,
  text,
  unreachable,
  type Notify,
  stringEnum,
} from "./support.ts";

const planParameters = Type.Object({
  action: stringEnum(["start", "custom", "show", "update", "finish"]),
  route: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(Type.String())),
  task: Type.Optional(Type.Integer()),
  status: Type.Optional(stringEnum(taskStatuses)),
  evidence: Type.Optional(Type.String()),
});
type PlanRequest =
  | { action: "show" }
  | { action: "start"; route: string; goal: string }
  | { action: "custom"; goal: string; steps?: string[] }
  | { action: "update"; task: number; status: TaskStatus; evidence?: string }
  | { action: "finish"; evidence: string };

function planRequest(p: Static<typeof planParameters>): PlanRequest {
  switch (p.action) {
    case "show":
      return { action: "show" };
    case "start":
      if (!p.route || !routes.includes(p.route))
        fail("Choose a known playbook or use action custom");
      return { action: "start", route: p.route, goal: p.goal ?? "" };
    case "custom":
      return { action: "custom", goal: p.goal ?? "", steps: p.steps };
    case "update":
      if (p.task === undefined || !isTaskStatus(p.status)) fail("Specify task and status");
      return { action: "update", task: p.task, status: p.status, evidence: p.evidence };
    case "finish":
      return { action: "finish", evidence: p.evidence ?? "" };
    default:
      return unreachable(p.action);
  }
}

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

function finished(plan: Plan | null, evidence: string): Plan {
  if (!plan || !planComplete(plan) || !evidence.trim())
    fail("Incomplete plan or missing final evidence");
  return { ...plan, finishedEvidence: evidence };
}

export function registerPlan(pi: ExtensionAPI, session: Session, notify: Notify) {
  const send = (id: string, request: string) =>
    pi.sendUserMessage(workflowPrompt(id, request), { deliverAs: "followUp" });

  pi.registerCommand("poteto-mode", {
    description: "Run a task with poteto-mode, or persist it with on/off",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "on" || value === "off") return session.commit(ctx, { mode: value === "on" });
      if (value) return send("poteto-mode", value);
      if (!ctx.hasUI) return notify(ctx, "Use /poteto-mode on or /poteto-mode <goal>.");
      const goal = await ctx.ui.input("Goal and observable completion predicate");
      if (goal) send("poteto-mode", goal);
    },
  });
  pi.registerCommand("pstack-run", {
    description: "Run an explicit playbook: /pstack-run <route> <goal>",
    handler: async (args, ctx) => {
      const [route, ...words] = args.trim().split(/\s+/);
      const goal = words.join(" ");
      if (!routes.includes(route) || !goal)
        return notify(ctx, `Choose a route and goal:\n${routes.join(", ")}`);
      session.commit(ctx, { plan: startPlan(route, goal) });
      send("pb-" + route, goal);
    },
  });
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

  pi.registerTool({
    name: "pstack_plan",
    label: "Pstack plan",
    description:
      "Maintain branch-local plan. Start with a route and goal or custom steps for figure-it-out. Mark tasks with real evidence. Finish only when all are done or justified skips.",
    executionMode: "sequential",
    parameters: planParameters,
    async execute(_id, p, _signal, _update, ctx) {
      const request = planRequest(p);
      const { plan, wake } = session.state();
      let instructions: string | undefined;
      switch (request.action) {
        case "show":
          return result(summary(session.state()));
        case "start":
          await approveMergeRoute(ctx, request.route, request.goal);
          instructions = nativeNode("pb-" + request.route).instructions;
          session.commit(ctx, { plan: startPlan(request.route, request.goal) });
          break;
        case "custom":
          session.commit(ctx, { plan: startPlan("figure-it-out", request.goal, request.steps) });
          break;
        case "update":
          session.commit(ctx, {
            plan: updateTask(plan, request.task, request.status, request.evidence),
          });
          break;
        case "finish":
          session.commit(ctx, { plan: finished(plan, request.evidence), wake: stopped(wake) });
          break;
        default:
          unreachable(request);
      }
      return result({ state: summary(session.state()), instructions });
    },
  });
  pi.registerTool({
    name: "pstack_wake",
    label: "Pstack wake status",
    description:
      "Inspect or stop an operator-started wake loop. Starting requires the explicit /pstack-loop command.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: stringEnum(["show", "stop"]),
      evidence: Type.Optional(Type.String()),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      if (p.action === "stop") {
        if (!p.evidence?.trim()) fail("Provide stop evidence or blocker");
        session.stopWake(ctx, p.evidence);
      }
      return result(session.state().wake);
    },
  });
}
