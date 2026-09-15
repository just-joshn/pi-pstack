import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  defaultModelsConfig,
  loadModelsConfig,
  modelsConfigPath,
  type PstackModelsConfig,
} from "./config.ts";

export { loadModelsConfig, resolveRoleModel, modelsConfigPath } from "./config.ts";

export function registerModels(pi: ExtensionAPI): void {
  pi.registerCommand("setup-pstack", {
    description: "Write ~/.pi/agent/pstack-models.json role→model map",
    handler: async (_args, ctx) => {
      const existing = loadModelsConfig(ctx.cwd) ?? defaultModelsConfig();
      const path = modelsConfigPath();
      mkdirSync(dirname(path), { recursive: true });

      // Interactive path when UI available
      if (ctx.hasUI) {
        const budget = await ctx.ui.select("pstack budget", [
          "unlimited — keep max",
          "large — xhigh reasoning",
          "medium — high reasoning",
          "small — medium reasoning",
        ]);
        if (budget) existing.budget = budget;
        const accept = await ctx.ui.confirm(
          "Write defaults?",
          `Write inherit-parent defaults (budget: ${existing.budget ?? "unlimited"}) to ${path}? Edit the JSON afterward for real slugs.`,
        );
        if (!accept) {
          ctx.ui.notify("setup-pstack cancelled", "info");
          return;
        }
      }

      writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
      ctx.ui.notify(`Wrote ${path}`, "info");
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    const cfg = loadModelsConfig(ctx.cwd);
    if (!cfg) return;
    const lines = Object.entries(cfg.roles)
      .filter(([, v]) => {
        const vals = Array.isArray(v) ? v : [v];
        return vals.some((x) => x && x !== "inherit-parent" && x !== "auto");
      })
      .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    if (lines.length === 0) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## pstack model roles\n${lines.join("\n")}\nUse these when calling pstack_spawn / pstack_swarm / pstack_arena unless overridden.`,
    };
  });
}

export type { PstackModelsConfig };
