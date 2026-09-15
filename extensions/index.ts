/**
 * pi-pstack extension entry — poteto-mode sticky + thin subagent/orchestration tools.
 * Stage 2 close-local-v3: force skill invoke on match, persist sticky+playbook,
 * restore on session_start, auto-arm readonly for investigation.
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
import { buildPotetoStickyPrompt, matchStickyPlaybook } from "./sticky-poteto.ts";
import { READONLY_TOOLS } from "./subagents/child-runner.ts";
import {
  STICKY_ENTRY_TYPE,
  READONLY_ENTRY_TYPE,
  forcePotetoSkillMessage,
  parseReadonlyEntry,
  parseStickyEntry,
  shouldAutoArmFromPlaybookMatch,
  shouldAutoArmFromSkillText,
  shouldAutoArmReadonly,
  shouldMatchStickyInput,
  stickyEntryPayload,
} from "./sticky-session.ts";

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
  /** Latest user text for sticky playbook auto-match. */
  let lastUserText = "";
  /** Persisted matched playbook id (restored on session_start). */
  let matchedPlaybookId: string | null = null;
  /** Tools active before readonly was applied (restored on off). */
  let toolsBeforeReadonly: string[] | undefined;

  const setPoteto = (
    enabled: boolean,
    ctx?: { ui: { setStatus: (id: string, v: string | undefined) => void } },
    match?: { id: string; score: number } | null,
  ) => {
    const nextPlaybook =
      match === null
        ? null
        : match?.id
          ? match.id
          : enabled
            ? matchedPlaybookId
            : null;
    const playbookChanged = nextPlaybook !== matchedPlaybookId;
    if (potetoEnabled === enabled && !playbookChanged && match === undefined) {
      return;
    }
    potetoEnabled = enabled;
    matchedPlaybookId = enabled ? nextPlaybook : null;
    pi.appendEntry(
      STICKY_ENTRY_TYPE,
      stickyEntryPayload(
        enabled,
        match ?? (matchedPlaybookId ? { id: matchedPlaybookId, score: 0 } : null),
      ),
    );
    ctx?.ui.setStatus(
      "pstack",
      enabled ? (matchedPlaybookId ? `poteto:${matchedPlaybookId}` : "poteto") : undefined,
    );
  };

  const persistStickyMatch = (match: { id: string; score: number }) => {
    matchedPlaybookId = match.id;
    pi.appendEntry(STICKY_ENTRY_TYPE, stickyEntryPayload(true, match));
  };

  const applySessionReadonlyTools = () => {
    const all = pi.getAllTools().map((t) => t.name);
    const active = pi.getActiveTools();
    toolsBeforeReadonly = active.length ? [...active] : [...all];
    const keep = new Set<string>([...READONLY_TOOLS]);
    for (const name of toolsBeforeReadonly) {
      if (name.startsWith("pstack_") && !SESSION_WRITE_TOOLS.has(name)) {
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
    reason?: string,
  ) => {
    if (sessionReadonly === enabled) return;
    sessionReadonly = enabled;
    pi.appendEntry(READONLY_ENTRY_TYPE, {
      enabled,
      reason,
      updatedAt: Date.now(),
    });
    if (enabled) {
      applySessionReadonlyTools();
      ctx?.ui.setStatus("pstack-ro", "readonly");
      ctx?.ui.notify?.(
        reason
          ? `Session readonly on (${reason}): write/edit/bash blocked.`
          : "Session readonly on: write/edit/bash blocked.",
        "info",
      );
    } else {
      clearSessionReadonlyTools();
      ctx?.ui.setStatus("pstack-ro", undefined);
      ctx?.ui.notify?.("Session readonly off.", "info");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    potetoEnabled = false;
    sessionReadonly = false;
    lastUserText = "";
    matchedPlaybookId = null;
    toolsBeforeReadonly = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === STICKY_ENTRY_TYPE) {
        const data = parseStickyEntry(entry.data);
        potetoEnabled = data.enabled === true;
        if (data.matchedPlaybookId) matchedPlaybookId = data.matchedPlaybookId;
      }
      if (entry.customType === READONLY_ENTRY_TYPE) {
        const data = parseReadonlyEntry(entry.data);
        sessionReadonly = data.enabled === true;
      }
    }
    if (potetoEnabled) {
      ctx.ui.setStatus("pstack", matchedPlaybookId ? `poteto:${matchedPlaybookId}` : "poteto");
    }
    if (sessionReadonly) {
      ctx.ui.setStatus("pstack-ro", "readonly");
      applySessionReadonlyTools();
    }
  });

  pi.on("input", (event, ctx) => {
    if (!shouldMatchStickyInput(event.source)) return;
    lastUserText = event.text ?? "";
    if (event.text.startsWith("/skill:poteto-mode") || event.text.startsWith("/poteto-mode")) {
      setPoteto(true, ctx);
    }
    let transformText: string | undefined;
    const matched = matchStickyPlaybook(event.text);
    if (matched && matched.score >= 2) {
      // Persist match whenever sticky is on or strong match arms sticky
      if (!potetoEnabled && matched.score >= 5) {
        setPoteto(true, ctx, { id: matched.id, score: matched.score });
        ctx.ui.notify?.(`Poteto sticky armed via playbook match: ${matched.id}`, "info");
      } else if (potetoEnabled) {
        persistStickyMatch({ id: matched.id, score: matched.score });
        ctx.ui.setStatus("pstack", `poteto:${matched.id}`);
      }

      // Force skill invocation via input transform: same turn, no queued follow-up,
      // no re-entrant "input" event to re-match against (Pi skill-expands the transformed text).
      if ((potetoEnabled || matched.score >= 5) && !event.text.startsWith("/skill:poteto-mode")) {
        transformText = forcePotetoSkillMessage(event.text, matched.id);
      }

      // Investigation playbook → auto-arm session readonly
      if (!process.env.PSTACK_CHILD_ROLE && shouldAutoArmFromPlaybookMatch(matched.id, potetoEnabled, matched.score, event.text)) {
        setSessionReadonly(true, ctx, `playbook:${matched.id}`);
      }
    }

    if (!process.env.PSTACK_CHILD_ROLE && shouldAutoArmFromSkillText(event.text)) {
      setSessionReadonly(true, ctx, "skill:investigation");
    }

    if (transformText) {
      return { action: "transform", text: transformText };
    }
  });

  pi.on("before_agent_start", (event) => {
    let prompt = event.systemPrompt;
    if (potetoEnabled) {
      const live = lastUserText ? matchStickyPlaybook(lastUserText) : undefined;
      prompt = buildPotetoStickyPrompt(prompt, {
        userText: lastUserText,
        match: live ?? null,
        // Reinject full playbook steps on restore (not a routing note only)
        restoredPlaybookId: live ? null : matchedPlaybookId,
      });
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
    if (name === "pstack_deslop") {
      const input = event.input as { applySafe?: boolean; autoApply?: boolean };
      if (input.applySafe || input.autoApply) {
        return {
          block: true,
          reason: "pstack session readonly: blocked deslop applySafe/autoApply.",
        };
      }
    }
    if (name === "pstack_spawn" || name === "pstack_swarm" || name === "pstack_arena") {
      const input = event.input as {
        readonly?: boolean;
        role?: string;
      };
      if (name === "pstack_spawn") {
        const role = input.role ?? "general";
        const ok =
          input.readonly === true ||
          role === "investigator" ||
          role === "comment-sicko";
        if (!ok) {
          (event.input as { readonly?: boolean }).readonly = true;
        }
      }
    }
    return;
  });

  pi.registerCommand("poteto-mode", {
    description: "Enable sticky poteto-mode and force skill invocation (optional task / playbook)",
    handler: async (args, ctx) => {
      const task = args.trim();
      const matched = task ? matchStickyPlaybook(task) : undefined;
      setPoteto(true, ctx, matched ? { id: matched.id, score: matched.score } : undefined);
      if (matched && shouldAutoArmReadonly(matched.id)) {
        setSessionReadonly(true, ctx, `playbook:${matched.id}`);
      }
      if (!task) {
        ctx.ui.notify(
          "Poteto mode on (sticky skill + playbook auto-match; force skill invoke on match). Use /skill:poteto-mode <task> or /poteto-mode <task>.",
          "info",
        );
        return;
      }
      lastUserText = task;
      pi.sendUserMessage(forcePotetoSkillMessage(task, matched?.id), {
        expandPromptTemplates: true,
      });
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
      setSessionReadonly(true, ctx, "command");
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
      const task = args.trim();
      const matched = task ? matchStickyPlaybook(task) : undefined;
      setPoteto(true, ctx, matched ? { id: matched.id, score: matched.score } : undefined);
      if (!task) {
        ctx.ui.notify(
          `pi-pstack tools: pstack_spawn, pstack_jobs, pstack_swarm, pstack_arena, pstack_loop, pstack_deslop, pstack_ship, pstack_babysit, pstack_benny_wake. Readonly: /pstack-readonly. Package: ${PACKAGE_ROOT}`,
          "info",
        );
        return;
      }
      lastUserText = task;
      pi.sendUserMessage(forcePotetoSkillMessage(task, matched?.id), {
        expandPromptTemplates: true,
      });
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
