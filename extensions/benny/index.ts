/**
 * Benny twin — Cursor Automations host is absent on Pi.
 * Closest parity: webhook/wake-file tools + slash commands that load
 * automations/benny skills and arm pstack_loop for triage/repro runs.
 * Official ExtensionAPI only (registerTool/registerCommand/sendUserMessage).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BENNY_ROOT = resolve(PACKAGE_ROOT, "automations/benny");
const WAKE_DIR = resolve(homedir(), ".pi/agent");
const WAKE_FILE = resolve(WAKE_DIR, "pstack-benny-wakes.jsonl");

function ensureWakeFile(): void {
  if (!existsSync(WAKE_DIR)) mkdirSync(WAKE_DIR, { recursive: true });
  if (!existsSync(WAKE_FILE)) writeFileSync(WAKE_FILE, "", "utf8");
}

export function registerBenny(pi: ExtensionAPI): void {
  pi.registerCommand("setup-benny", {
    description: "Run Benny setup skill (Pi twin of Cursor Automations pack setup)",
    handler: async (_args, ctx) => {
      const skill = resolve(BENNY_ROOT, "skills/setup-benny/SKILL.md");
      if (!existsSync(skill)) {
        ctx.ui.notify(`Benny pack missing at ${BENNY_ROOT}`, "error");
        return;
      }
      pi.sendUserMessage(
        `Read and follow ${skill}. Retarget paths to .pi/automations/benny and .pi/benny. Do not use Cursor Automations host APIs.`,
        { expandPromptTemplates: false },
      );
    },
  });

  pi.registerCommand("benny-triage", {
    description: "Run Benny triage-issue-reports skill once",
    handler: async (args, _ctx) => {
      const skill = resolve(BENNY_ROOT, "skills/triage-issue-reports/SKILL.md");
      const extra = args.trim();
      pi.sendUserMessage(
        `Read and follow ${skill}. ${extra ? `Context: ${extra}` : "Await the next Slack/tracker issue payload from pstack_benny_wake or chat."}`,
        { expandPromptTemplates: false },
      );
    },
  });

  pi.registerCommand("benny-repro", {
    description: "Run Benny reproduce-and-fix-issues skill once",
    handler: async (args, _ctx) => {
      const skill = resolve(BENNY_ROOT, "skills/reproduce-and-fix-issues/SKILL.md");
      const extra = args.trim();
      pi.sendUserMessage(
        `Read and follow ${skill}. Use pstack_control_cli / pstack_control_ui for the control adapter. ${extra ? `Issue: ${extra}` : ""}`,
        { expandPromptTemplates: false },
      );
    },
  });

  pi.registerTool({
    name: "pstack_benny_wake",
    label: "Benny wake",
    description:
      "Append or drain Benny wake payloads (Slack/tracker JSON). Closest twin to Cursor Automations Slack triggers — pair with pstack_loop watcher on the wake file.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("append"), Type.Literal("drain"), Type.Literal("path")], {
        description: "append JSON payload, drain all pending lines, or return wake file path",
      }),
      payload: Type.Optional(Type.String({ description: "JSON string to append (action=append)" })),
      intent: Type.Optional(
        Type.Union([Type.Literal("triage"), Type.Literal("repro")], {
          description: "Hint which Benny skill should handle this wake",
        }),
      ),
    }),
    promptSnippet: "Queue or drain Benny automation wake payloads",
    promptGuidelines: [
      "Use pstack_benny_wake + pstack_loop(mode=watcher) instead of Cursor Automations Slack triggers.",
      "After drain, run /benny-triage or /benny-repro with the payload.",
    ],
    async execute(_id, params) {
      ensureWakeFile();
      if (params.action === "path") {
        return {
          content: [{ type: "text", text: WAKE_FILE }],
          details: { path: WAKE_FILE },
        };
      }
      if (params.action === "append") {
        if (!params.payload?.trim()) {
          return {
            content: [{ type: "text", text: "pstack_benny_wake append requires payload JSON" }],
            details: { ok: false },
          };
        }
        const line = JSON.stringify({
          ts: new Date().toISOString(),
          intent: params.intent ?? "triage",
          payload: (() => {
            try {
              return JSON.parse(params.payload!);
            } catch {
              return params.payload;
            }
          })(),
        });
        appendFileSync(WAKE_FILE, line + "\n", "utf8");
        return {
          content: [{ type: "text", text: `Appended wake to ${WAKE_FILE}` }],
          details: { ok: true, path: WAKE_FILE },
        };
      }
      // drain
      const raw = readFileSync(WAKE_FILE, "utf8");
      writeFileSync(WAKE_FILE, "", "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      return {
        content: [
          {
            type: "text",
            text:
              lines.length === 0
                ? "No pending Benny wakes."
                : `Drained ${lines.length} wake(s):\n${lines.join("\n")}`,
          },
        ],
        details: { count: lines.length, path: WAKE_FILE },
      };
    },
  });
}
