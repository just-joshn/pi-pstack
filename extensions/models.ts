import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  aliases,
  applyConfigPatch,
  budgets,
  defaultConfig,
  effort,
  judgeRole,
  panelRoles,
  parseModelConfig,
  roles,
  validateConfig,
  type Role,
  type RoleConfig,
} from "../lib/models.ts";
import { parseJson } from "../lib/validation.ts";
import { agentDir, atomicWrite, fail, hasErrorCode, text, type Notify } from "./support.ts";

const configPath = join(agentDir, "pstack-models.json");
export async function readConfig(): Promise<RoleConfig> {
  try {
    return parseModelConfig(
      parseJson(await readFile(configPath, "utf8"), "pstack model configuration"),
    );
  } catch (e) {
    if (hasErrorCode(e, "ENOENT")) return defaultConfig();
    throw e;
  }
}
export function availableModels(ctx: ExtensionContext) {
  const models = ctx.scopedModels.length
    ? ctx.scopedModels.map((m) => m.model)
    : ctx.modelRegistry.getAvailable();
  return [...new Set(models.map((m) => `${m.provider}/${m.id}`))].toSorted();
}

async function chooseRole(ctx: ExtensionContext, role: Role, available: string[]) {
  const panel = panelRoles.has(role);
  const options = [
    ...(role === judgeRole ? [] : aliases),
    ...available,
    ...(panel ? ["Done"] : []),
  ];
  const chosen: string[] = [];
  while (chosen.length < (panel ? 8 : 1)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Show prior selections in the next dialog.
    const value = await ctx.ui.select(`${role}: ${chosen.join(", ") || "(none)"}`, options);
    if (!value) return undefined;
    if (value === "Done") break;
    chosen.push(value);
  }
  return chosen;
}

async function chooseConfig(ctx: ExtensionContext, config: RoleConfig, available: string[]) {
  const budget = await ctx.ui.select(
    "Reasoning budget",
    budgets.map((b) => `${b} (${effort("feature, refactoring", b)})`),
  );
  if (!budget) return undefined;
  const selections = { ...config.roles };
  for (const role of roles) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Pi shows one selection dialog at a time.
    const action = await ctx.ui.select(`${role}: ${selections[role].join(", ") || "(empty)"}`, [
      "Keep current",
      "Choose model(s)",
    ]);
    if (!action) return undefined;
    if (action === "Keep current") continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Finish choosing this role before the next.
    const chosen = await chooseRole(ctx, role, available);
    if (!chosen) return undefined;
    selections[role] = chosen;
  }
  return { ...config, budget: budget.split(" ")[0], roles: selections };
}

export function registerModelSetup(pi: ExtensionAPI, notify: Notify) {
  pi.registerCommand("setup-pstack", {
    description: "Configure pstack role models and reasoning budget",
    handler: async (args, ctx) => {
      const available = availableModels(ctx);
      const current = await readConfig();
      const input = args.trim();
      if (input === "show" || (!input && !ctx.hasUI)) {
        notify(ctx, text({ config: current, available, path: configPath }));
        return;
      }
      if (!ctx.hasUI) fail("Use /setup-pstack interactively to confirm model configuration.");
      const chosen = input
        ? applyConfigPatch(current, parseJson(input, "setup arguments"))
        : await chooseConfig(ctx, current, available);
      if (!chosen) return;
      const config = validateConfig(chosen, available);
      if (!(await ctx.ui.confirm("Save pstack role configuration?", text(config)))) return;
      await atomicWrite(configPath, JSON.stringify(config, null, 2) + "\n");
      notify(ctx, `Saved ${configPath}. Parent model unchanged.`);
    },
  });
}
