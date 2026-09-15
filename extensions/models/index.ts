import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  defaultModelsConfig,
  detectPreferredModel,
  isBareMarketingSlug,
  isInheritAlias,
  isProviderId,
  loadModelsConfig,
  MARKETING_SLUG_MAP,
  modelsConfigPath,
  sanitizeRoleValueForWrite,
  type PstackModelsConfig,
  type RoleValue,
} from "./config.ts";

export {
  loadModelsConfig,
  resolveRoleModel,
  modelsConfigPath,
  normalizeModelSelector,
  MARKETING_SLUG_MAP,
} from "./config.ts";

function sanitizeConfig(cfg: PstackModelsConfig, preferred?: string): PstackModelsConfig {
  const roles: Record<string, RoleValue> = {};
  for (const [k, v] of Object.entries(cfg.roles)) {
    roles[k] = sanitizeRoleValueForWrite(v, preferred);
  }
  return { ...cfg, roles };
}

export function registerModels(pi: ExtensionAPI): void {
  pi.registerCommand("setup-pstack", {
    description:
      "Write ~/.pi/agent/pstack-models.json role→model map (provider/id when detectable; refuses bare marketing slugs)",
    handler: async (_args, ctx) => {
      const detected = detectPreferredModel();
      let existing = loadModelsConfig(ctx.cwd) ?? defaultModelsConfig(detected);
      // Upgrade inherit blanks when we have a concrete provider/id.
      if (detected && isProviderId(detected)) {
        for (const [k, v] of Object.entries(existing.roles)) {
          if (typeof v === "string" && (isInheritAlias(v) || isBareMarketingSlug(v))) {
            existing.roles[k] = detected;
          }
          if (Array.isArray(v) && v.every((x) => isInheritAlias(x) || isBareMarketingSlug(x))) {
            existing.roles[k] = v.map(() => detected!);
          }
        }
      }
      existing = sanitizeConfig(existing, detected);
      const path = modelsConfigPath();
      mkdirSync(dirname(path), { recursive: true });

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
    },
  });

  // Always-applied-like sticky: inject role map every parent turn (even inherit lines).
  pi.on("before_agent_start", (event, ctx) => {
    const cfg = loadModelsConfig(ctx.cwd) ?? defaultModelsConfig(detectPreferredModel());
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
    return {
      systemPrompt: `${event.systemPrompt}\n\n## pstack model roles (always-applied twin)\n${lines.join("\n")}\nPass provider/id (or inherit-parent/auto) to pstack_spawn / pstack_swarm / pstack_arena. Bare marketing slugs are refused or mapped. Every child resolves via resolveRoleModel.`,
    };
  });
}

export type { PstackModelsConfig };
