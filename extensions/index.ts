/**
 * pi-pstack extension entry — poteto-mode sticky + thin subagent/orchestration tools.
 * No Cursor SDKs. No pi-subagents / tintinweb deps.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDecisionLog } from "./decision-log/index.ts";
import { registerGates } from "./gates/index.ts";
import { registerModels } from "./models/index.ts";
import { registerOrchestration } from "./orchestration/index.ts";
import { registerSpawn } from "./subagents/index.ts";
import { registerWorktree } from "./worktree/index.ts";
import { registerHeartbeat } from "./heartbeat/index.ts";
import { registerCompanions } from "./companions/index.ts";
import { registerSessions } from "./sessions/index.ts";
import { registerShipping } from "./shipping/index.ts";
import { registerBenny } from "./benny/index.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default function piPstack(pi: ExtensionAPI) {
  let potetoEnabled = false;

  const setPoteto = (enabled: boolean, ctx?: { ui: { setStatus: (id: string, v: string | undefined) => void } }) => {
    if (potetoEnabled === enabled) return;
    potetoEnabled = enabled;
    pi.appendEntry("pstack-poteto-mode", { enabled });
    ctx?.ui.setStatus("pstack", enabled ? "poteto" : undefined);
  };

  pi.on("session_start", (_event, ctx) => {
    potetoEnabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "pstack-poteto-mode") continue;
      const data = entry.data as { enabled?: boolean } | undefined;
      potetoEnabled = data?.enabled === true;
    }
    if (potetoEnabled) ctx.ui.setStatus("pstack", "poteto");
  });

  pi.on("input", (event, ctx) => {
    if (event.text.startsWith("/skill:poteto-mode") || event.text.startsWith("/poteto-mode")) {
      setPoteto(true, ctx);
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!potetoEnabled) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nPoteto mode is active (pi-pstack). Apply the poteto-mode skill when this turn matches a playbook or needs rigor. Use pstack_spawn / pstack_swarm / pstack_arena instead of Cursor Task. Stay concise for casual turns.`,
    };
  });

  pi.registerCommand("poteto-mode", {
    description: "Enable sticky poteto-mode and optionally run a task",
    handler: async (args, ctx) => {
      setPoteto(true, ctx);
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Poteto mode on. Use /skill:poteto-mode <task> or /poteto-mode <task>.", "info");
        return;
      }
      pi.sendUserMessage(`/skill:poteto-mode ${task}`, { expandPromptTemplates: true });
    },
  });

  pi.registerCommand("poteto-mode-off", {
    description: "Disable sticky poteto-mode",
    handler: async (_args, ctx) => {
      setPoteto(false, ctx);
      ctx.ui.notify("Poteto mode off.", "info");
    },
  });

  pi.registerCommand("pstack", {
    description: "Alias for /poteto-mode",
    handler: async (args, ctx) => {
      setPoteto(true, ctx);
      const task = args.trim();
      if (!task) {
        ctx.ui.notify(
          `pi-pstack tools: pstack_spawn, pstack_jobs, pstack_swarm, pstack_arena, pstack_loop, pstack_deslop, pstack_ship, pstack_babysit, pstack_benny_wake. Package: ${PACKAGE_ROOT}`,
          "info",
        );
        return;
      }
      pi.sendUserMessage(`/skill:poteto-mode ${task}`, { expandPromptTemplates: true });
    },
  });

  registerSpawn(pi);
  registerOrchestration(pi);
  registerModels(pi);
  registerDecisionLog(pi);
  registerGates(pi);
  registerWorktree(pi);
  registerHeartbeat(pi);
  registerCompanions(pi);
  registerSessions(pi);
  registerShipping(pi);
  registerBenny(pi);
}
