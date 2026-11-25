import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  lookup,
  nativeNode,
  nodes,
  routeTriggers,
  slashSkills,
  view,
  views,
  workflowPrompt,
} from "../lib/catalog.ts";
import { type Notify, result, stringEnum, text } from "./support.ts";

const ownCommands = new Set(["setup-pstack", "poteto-mode"]);

async function browse(pi: ExtensionAPI, ctx: ExtensionContext, start: string) {
  let current = start;
  for (;;) {
    const v = view(current);
    const choices = [
      ...(v.parent ? [`view:${v.parent} (back)`] : []),
      ...v.children.map((c) => `view:${c}`),
      ...v.nodes.map((n) => `node:${n.id}`),
      "Exit",
    ];
    // oxlint-disable-next-line eslint/no-await-in-loop -- The next screen depends on the user's choice.
    const chosen = await ctx.ui.select(`${v.title}\n${v.caption}`, choices);
    if (!chosen || chosen === "Exit") return;
    if (chosen.startsWith("view:")) {
      current = chosen.slice(5).split(" ")[0] ?? current;
      continue;
    }
    const n = nativeNode(chosen.slice(5));
    const links = n.outgoing.map((e) => `${e.to}: ${e.label} (${e.when})`).join("\n");
    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the node action before navigating.
    const action = await ctx.ui.select(
      `${n.id}: ${n.what}\n${n.when}\n${n.implementation}\n${links}`,
      ["Back", "Send full details to transcript"],
    );
    if (action === "Send full details to transcript")
      pi.sendMessage({ customType: "pstack-map", content: text(n), display: true });
  }
}

export const sendWorkflow = (pi: ExtensionAPI, id: string, request: string) =>
  pi.sendUserMessage(workflowPrompt(id, request), { deliverAs: "followUp" });

export function registerCatalog(pi: ExtensionAPI, notify: Notify) {
  for (const n of slashSkills.filter((skill) => !ownCommands.has(skill.id))) {
    pi.registerCommand(n.label.slice(1), {
      description: n.what,
      handler: async (args) => sendWorkflow(pi, n.id, args.trim()),
    });
  }
  pi.registerCommand("pstack-create-skill", {
    description: "Author a project-local Agent Skill",
    handler: async (args) => sendWorkflow(pi, "pb-authoring-a-skill", args),
  });
  pi.registerCommand("pstack-map", {
    description: "Browse all source map nodes, relationships and views",
    handler: async (args, ctx) => {
      const id = args.trim() || "root";
      if (!views.has(id)) return notify(ctx, text(nodes.has(id) ? nativeNode(id) : lookup(id)));
      if (!ctx.hasUI) return notify(ctx, text(view(id)));
      await browse(pi, ctx, id);
    },
  });
  pi.registerTool({
    name: "pstack_catalog",
    label: "Pstack catalog",
    description:
      "Read a skill/playbook or native implementation mapping, search the map, list routes, or inspect a view. Conditional edges are not a call sequence.",
    parameters: Type.Object({
      action: stringEnum(["node", "routes", "view", "search"]),
      id: Type.Optional(Type.String()),
    }),
    async execute(_id, p) {
      if (p.action === "routes") return result(routeTriggers());
      if (p.action === "search") return result(lookup(p.id ?? ""));
      if (p.action === "view") return result(view(p.id ?? "root"));
      return result(nativeNode(p.id ?? ""));
    },
  });
}
