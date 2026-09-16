import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  defaultModelsConfig,
  detectPreferredModel,
  isBareMarketingSlug,
  isInheritAlias,
  isProviderId,
  loadModelsConfig,
  MARKETING_SLUG_MAP,
  modelsConfigPath,
  projectConfigCwd,
  sanitizeRoleValueForWrite,
  type PstackModelsConfig,
  type RoleValue,
} from "./config.ts";

export {
  loadModelsConfig,
  resolveRoleModel,
  modelsConfigPath,
  normalizeModelSelector,
  projectConfigCwd,
  MARKETING_SLUG_MAP,
} from "./config.ts";

function sanitizeConfig(cfg: PstackModelsConfig, preferred?: string): PstackModelsConfig {
  const roles: Record<string, RoleValue> = {};
  for (const [k, v] of Object.entries(cfg.roles)) {
    roles[k] = sanitizeRoleValueForWrite(v, preferred);
  }
  return { ...cfg, roles };
}

function upgradeInheritRoles(cfg: PstackModelsConfig, detected?: string): PstackModelsConfig {
  if (!detected || !isProviderId(detected)) return cfg;
  const roles: Record<string, RoleValue> = {};
  for (const [k, v] of Object.entries(cfg.roles)) {
    if (typeof v === "string" && (isInheritAlias(v) || isBareMarketingSlug(v))) {
      roles[k] = detected;
    } else if (Array.isArray(v) && v.every((x) => isInheritAlias(x) || isBareMarketingSlug(x))) {
      roles[k] = v.map(() => detected);
    } else {
      roles[k] = v;
    }
  }
  return { ...cfg, roles };
}

function formatModelRolesSection(cfg: PstackModelsConfig): string {
  const lines = Object.entries(cfg.roles).map(([k, v]) => {
    const vals = Array.isArray(v) ? v : [v];
    const shown = vals
      .map((x) => {
        if (isBareMarketingSlug(x) && MARKETING_SLUG_MAP[x]) {
          return `${MARKETING_SLUG_MAP[x]} (mapped from ${x})`;
        }
        if (isBareMarketingSlug(x)) return `${x} [INVALID bare slug — use provider/id]`;
        return x;
      })
      .join(", ");
    return `- ${k}: ${shown}`;
  });
  return `## pstack model roles (validated always-applied twin)\n${lines.join("\n")}\nPass provider/id (or inherit-parent/auto) to pstack_spawn / pstack_swarm / pstack_arena. Bare marketing slugs are refused at spawn when passed explicitly; known maps applied. Invalid selectors fail closed. Every child resolves via resolveRoleModel.`;
}

async function runSetupPstack(ctx: ExtensionCommandContext): Promise<void> {
  const detected = detectPreferredModel();
  let existing = loadModelsConfig(projectConfigCwd(ctx)) ?? defaultModelsConfig(detected);
  existing = sanitizeConfig(upgradeInheritRoles(existing, detected), detected);
  const path = modelsConfigPath();
  mkdirSync(dirname(path), { recursive: true });

  if (ctx.hasUI) {
    const budget = await ctx.ui.select("pstack budget", [
      "unlimited — keep max",
      "large — xhigh reasoning",
      "medium — high reasoning",
      "small — medium reasoning",
    ]);
    if (budget) existing = { ...existing, budget };
    const accept = await ctx.ui.confirm(
      "Write defaults?",
      `Write role defaults${detected ? ` (detected ${detected})` : " (inherit-parent / mapped provider ids — no bare marketing slugs)"} (budget: ${existing.budget ?? "unlimited"}) to ${path}?`,
    );
    if (!accept) {
      ctx.ui.notify("setup-pstack cancelled", "info");
      return;
    }
  }

  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  ctx.ui.notify(
    `Wrote ${path}${detected ? ` (provider/id ${detected})` : " (edit to set real provider/id)"}. Bare Cursor marketing slugs are mapped or refused.`,
    "info",
  );
}

function registerSetupPstackCommand(pi: ExtensionAPI): void {
  pi.registerCommand("setup-pstack", {
    description:
      "Write ~/.pi/agent/pstack-models.json role→model map (provider/id when detectable; refuses bare marketing slugs)",
    handler: async (_args, ctx) => {
      await runSetupPstack(ctx);
    },
  });
}

function registerModelRolesPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const cfg = loadModelsConfig(projectConfigCwd(ctx)) ?? defaultModelsConfig(detectPreferredModel());
    return { systemPrompt: `${event.systemPrompt}\n\n${formatModelRolesSection(cfg)}` };
  });
}

export function registerModels(pi: ExtensionAPI): void {
  registerSetupPstackCommand(pi);
  registerModelRolesPrompt(pi);
}

export type { PstackModelsConfig };
