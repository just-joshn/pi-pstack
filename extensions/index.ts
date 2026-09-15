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
import { buildPotetoStickyPrompt } from "./sticky-poteto.ts";
import { READONLY_TOOLS } from "./subagents/child-runner.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parent-session tools that mutate the tree or spawn writers — blocked in session readonly. */
const SESSION_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "bash",
  "powershell",
]);

export default function piPstack(pi: ExtensionAPI) {
  let potetoEnabled = false;
  let sessionReadonly = false;
  /** Tools active before readonly was applied (restored on off). */
  let toolsBeforeReadonly: string[] | undefined;

  const setPoteto = (enabled: boolean, ctx?: { ui: { setStatus: (id: string, v: string | undefined) => void } }) => {
    if (potetoEnabled === enabled) return;
    potetoEnabled = enabled;
    pi.appendEntry("pstack-poteto-mode", { enabled });
    ctx?.ui.setStatus("pstack", enabled ? "poteto" : undefined);
  };

  const applySessionReadonlyTools = () => {
    const all = pi.getAllTools().map((t) => t.name);
    const active = pi.getActiveTools();
    toolsBeforeReadonly = active.length ? [...active] : [...all];
    const keep = new Set<string>([...READONLY_TOOLS]);
    // Keep read-safe pstack companions; block mutating spawn/worktree/ship/deslop-apply paths at tool_call.
    for (const name of toolsBeforeReadonly) {
      if (name.startsWith("pstack_") && !SESSION_WRITE_TOOLS.has(name)) {
        // Allow list/status tools; mutating ones still gated in tool_call below.
        keep.add(name);
      }
      if (name === "read" || name === "grep" || name === "find" || name === "ls") keep.add(name);
    }
    pi.setActiveTools([...keep].filter((n) => all.includes(n) || toolsBeforeReadonly!.includes(n)));
  };

  const clearSessionReadonlyTools = () => {
    if (toolsBeforeReadonly?.length) {
      try {
        pi.setActiveTools(toolsBeforeReadonly);
      } catch {
        /* session may be tearing down */
      }
    }
    toolsBeforeReadonly = undefined;
  };

  const setSessionReadonly = (
    enabled: boolean,
    ctx?: { ui: { setStatus: (id: string, v: string | undefined) => void; notify: (m: string, l: string) => void } },
  ) => {
    if (sessionReadonly === enabled) return;
    sessionReadonly = enabled;
    pi.appendEntry("pstack-session-readonly", { enabled });
    if (enabled) {
      applySessionReadonlyTools();
      ctx?.ui.setStatus("pstack-ro", "readonly");
      ctx?.ui.notify?.("Session readonly on: write/edit/bash blocked.", "info");
    } else {
      clearSessionReadonlyTools();
      ctx?.ui.setStatus("pstack-ro", undefined);
      ctx?.ui.notify?.("Session readonly off.", "info");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    potetoEnabled = false;
    sessionReadonly = false;
    toolsBeforeReadonly = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === "pstack-poteto-mode") {
        const data = entry.data as { enabled?: boolean } | undefined;
        potetoEnabled = data?.enabled === true;
      }
      if (entry.customType === "pstack-session-readonly") {
        const data = entry.data as { enabled?: boolean } | undefined;
        sessionReadonly = data?.enabled === true;
      }
    }
    if (potetoEnabled) ctx.ui.setStatus("pstack", "poteto");
    if (sessionReadonly) {
      ctx.ui.setStatus("pstack-ro", "readonly");
      applySessionReadonlyTools();
    }
  });

  pi.on("input", (event, ctx) => {
    if (event.text.startsWith("/skill:poteto-mode") || event.text.startsWith("/poteto-mode")) {
      setPoteto(true, ctx);
    }
    // Investigation playbook / explicit ask → arm session readonly
    if (
      /\b\/skill:poteto-mode\b.*\b(investigat|read-?only|ask mode)\b/i.test(event.text) ||
      /^\/pstack-readonly\b/i.test(event.text.trim())
    ) {
      /* command handler owns /pstack-readonly; skill path arms below */
    }
    if (
      event.text.startsWith("/skill:poteto-mode") &&
      /\binvestigat/i.test(event.text)
    ) {
      setSessionReadonly(true, ctx);
    }
  });

  pi.on("before_agent_start", (event) => {
    let prompt = event.systemPrompt;
    if (potetoEnabled) {
      prompt = buildPotetoStickyPrompt(prompt);
    }
    if (sessionReadonly) {
      prompt = `${prompt}\n\n## pstack session readonly\nThis session is read-only. Do not write, edit, or run bash. Use read/grep/find/ls (and read-safe pstack_* tools). Spawn children with readonly:true or role investigator/comment-sicko. Deliver citations and recommendations only.`;
    }
    if (prompt === event.systemPrompt) return;
    return { systemPrompt: prompt };
  });

  pi.on("tool_call", (event) => {
    if (!sessionReadonly) return;
    const name = event.toolName;
    if (SESSION_WRITE_TOOLS.has(name)) {
      return {
        block: true,
        reason: `pstack session readonly: blocked ${name}. Use /pstack-readonly-off to re-enable writes.`,
      };
    }
    if (name === "pstack_worktree") {
      const action = (event.input as { action?: string } | undefined)?.action;
      if (action && action !== "list") {
        return {
          block: true,
          reason: "pstack session readonly: blocked mutating pstack_worktree.",
        };
      }
    }
    if (name === "pstack_ship" || name === "pstack_babysit") {
      return {
        block: true,
        reason: `pstack session readonly: blocked ${name}.`,
      };
    }
    if (name === "pstack_spawn" || name === "pstack_swarm" || name === "pstack_arena") {
      const input = event.input as {
        readonly?: boolean;
        role?: string;
        tasks?: unknown[];
      };
      if (name === "pstack_spawn") {
        const role = input.role ?? "general";
        const ok =
          input.readonly === true ||
          role === "investigator" ||
          role === "comment-sicko";
        if (!ok) {
          // Force readonly by mutating input in place (ExtensionAPI contract).
          (event.input as { readonly?: boolean }).readonly = true;
        }
      }
    }
    return;
  });

  pi.registerCommand("poteto-mode", {
    description: "Enable sticky poteto-mode and optionally run a task",
    handler: async (args, ctx) => {
      setPoteto(true, ctx);
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Poteto mode on (sticky skill re-injected each turn). Use /skill:poteto-mode <task> or /poteto-mode <task>.", "info");
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

  pi.registerCommand("pstack-readonly", {
    description: "Enable session-level read-only (strip write/edit/bash)",
    handler: async (_args, ctx) => {
      setSessionReadonly(true, ctx);
    },
  });

  pi.registerCommand("pstack-readonly-off", {
    description: "Disable session-level read-only",
    handler: async (_args, ctx) => {
      setSessionReadonly(false, ctx);
    },
  });

  pi.registerCommand("pstack", {
    description: "Alias for /poteto-mode",
    handler: async (args, ctx) => {
      setPoteto(true, ctx);
      const task = args.trim();
      if (!task) {
        ctx.ui.notify(
          `pi-pstack tools: pstack_spawn, pstack_jobs, pstack_swarm, pstack_arena, pstack_loop, pstack_deslop, pstack_ship, pstack_babysit, pstack_benny_wake. Readonly: /pstack-readonly. Package: ${PACKAGE_ROOT}`,
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
