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
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { capToolOutput } from "../lib/tool-output.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BENNY_ROOT = resolve(PACKAGE_ROOT, "automations/benny");

const BENNY_WAKE_PARAMETERS = Type.Object({
  action: StringEnum(["append", "drain", "path"] as const, {
    description: "append JSON payload, drain all pending lines, or return wake file path",
  }),
  payload: Type.Optional(Type.String({ description: "JSON string to append (action=append)" })),
  intent: Type.Optional(
    StringEnum(["triage", "repro"] as const, {
      description: "Hint which Benny skill should handle this wake",
    }),
  ),
});

type WakeParams = Static<typeof BENNY_WAKE_PARAMETERS>;

type WakeToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function wakeFile(): string {
  return resolve(homedir(), ".pi/agent/pstack-benny-wakes.jsonl");
}

async function ensureWakeFile(): Promise<string> {
  const file = wakeFile();
  await withFileMutationQueue(file, async () => {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(file)) writeFileSync(file, "", "utf8");
  });
  return file;
}

async function appendWake(params: WakeParams): Promise<WakeToolResult> {
  const file = await ensureWakeFile();
  if (!params.payload?.trim()) {
    throw new Error("pstack_benny_wake append requires a non-empty payload JSON string");
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
  await withFileMutationQueue(file, async () => {
    appendFileSync(file, line + "\n", "utf8");
  });
  return {
    content: [{ type: "text", text: `Appended wake to ${file}` }],
    details: { ok: true, path: file },
  };
}

async function drainWakes(): Promise<WakeToolResult> {
  const file = await ensureWakeFile();
  const raw = await withFileMutationQueue(file, async () => {
    const text = readFileSync(file, "utf8");
    writeFileSync(file, "", "utf8");
    return text;
  });
  const lines = raw.split("\n").filter((l) => l.trim());
  const body =
    lines.length === 0
      ? "No pending Benny wakes."
      : `Drained ${lines.length} wake(s):\n${lines.join("\n")}`;
  const capped = capToolOutput(body, { keep: "tail", label: "benny-wakes" });
  return {
    content: [{ type: "text", text: capped.text }],
    details: {
      count: lines.length,
      path: file,
      ...(capped.outputPath ? { fullOutputPath: capped.outputPath } : {}),
    },
  };
}

function registerSetupBennyCommand(pi: ExtensionAPI): void {
  pi.registerCommand("setup-benny", {
    description: "Run Benny setup skill (Pi twin of Cursor Automations pack setup)",
    handler: async (_args, ctx) => {
      const skill = resolve(BENNY_ROOT, "skills/setup-benny/SKILL.md");
      if (!existsSync(skill)) {
        ctx.ui.notify(`Benny pack missing at ${BENNY_ROOT}`, "error");
        return;
      }
      pi.sendUserMessage(`Read and follow ${skill}. Retarget paths to .pi/automations/benny and .pi/benny. Do not use Cursor Automations host APIs.`, { expandPromptTemplates: false, deliverAs: "followUp" });
    },
  });
}

function registerBennyTriageCommand(pi: ExtensionAPI): void {
  pi.registerCommand("benny-triage", {
    description: "Run Benny triage-issue-reports skill once",
    handler: async (args, _ctx) => {
      const skill = resolve(BENNY_ROOT, "skills/triage-issue-reports/SKILL.md");
      const extra = args.trim();
      pi.sendUserMessage(`Read and follow ${skill}. ${extra ? `Context: ${extra}` : "Await the next Slack/tracker issue payload from pstack_benny_wake or chat."}`, { expandPromptTemplates: false, deliverAs: "followUp" });
    },
  });
}

function registerBennyReproCommand(pi: ExtensionAPI): void {
  pi.registerCommand("benny-repro", {
    description: "Run Benny reproduce-and-fix-issues skill once",
    handler: async (args, _ctx) => {
      const skill = resolve(BENNY_ROOT, "skills/reproduce-and-fix-issues/SKILL.md");
      const extra = args.trim();
      pi.sendUserMessage(`Read and follow ${skill}. Use pstack_control_cli / pstack_control_ui for the control adapter. ${extra ? `Issue: ${extra}` : ""}`, { expandPromptTemplates: false, deliverAs: "followUp" });
    },
  });
}

function registerBennyWakeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_benny_wake",
    label: "Benny wake",
    description:
      "Append or drain Benny wake payloads (Slack/tracker JSON). Closest twin to Cursor Automations Slack triggers — pair with pstack_loop watcher on the wake file. Drained output caps at 50KB / 2000 lines; when truncated the trailer names the temp file holding the full text.",
    parameters: BENNY_WAKE_PARAMETERS,
    promptSnippet: "Queue or drain Benny automation wake payloads",
    promptGuidelines: [
      "Use pstack_benny_wake + pstack_loop(mode=watcher) instead of Cursor Automations Slack triggers.",
      "After pstack_benny_wake drain, run /benny-triage or /benny-repro with the payload.",
    ],
    async execute(_id, params) {
      const file = await ensureWakeFile();
      if (params.action === "path") {
        return {
          content: [{ type: "text", text: file }],
          details: { path: file },
        };
      }
      if (params.action === "append") {
        return await appendWake(params);
      }
      return await drainWakes();
    },
  });
}

export function registerBenny(pi: ExtensionAPI): void {
  registerSetupBennyCommand(pi);
  registerBennyTriageCommand(pi);
  registerBennyReproCommand(pi);
  registerBennyWakeTool(pi);
}
