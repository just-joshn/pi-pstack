import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { packageFile } from "./lib/catalog.ts";
import { type BennyKind, isJobKind } from "./lib/jobs.ts";
import { artifacts, hasErrorCode, type Notify, result, tsvRow } from "./support.ts";

const bennyDrafts: Record<BennyKind, { name: string; template: string; tools: string[] }> = {
  "benny-triage": {
    name: "benny-triage",
    template: "triage-automation-prompt.md",
    tools: ["read", "grep", "find", "ls", "bash", "pstack_delegate"],
  },
  "benny-repro": {
    name: "benny-reproduce",
    template: "reproduce-automation-prompt.md",
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "pstack_delegate"],
  },
};
const promptTemplate = (file: string) =>
  packageFile(`automations/benny/templates/${file}`)
    .split("\n")
    .filter((line) => !line.startsWith("# ") && !line.startsWith("> "))
    .join("\n")
    .trim();
function draftFields(kind: BennyKind | "custom") {
  if (kind === "custom")
    return {
      tools: [],
      instructions: "Supply explicit task, approved tools, trigger and finish predicate.",
    };
  const { name, template, tools } = bennyDrafts[kind];
  return {
    name,
    tools,
    instructions: promptTemplate(template),
    config: { sourceChannel: "", defaultBranch: "" },
  };
}

function registerAutomationDraft(pi: ExtensionAPI, notify: Notify) {
  pi.registerCommand("pstack-automation", {
    description: "Draft a headless Pi automation (disabled)",
    handler: async (args, ctx) => {
      const kind = args.trim();
      if (!isJobKind(kind)) return notify(ctx, "Choose benny-triage, benny-repro, or custom.");
      const path = join(artifacts(ctx), `${kind}.job.json`);
      const job = { version: 1, enabled: false, kind, cwd: ctx.cwd, ...draftFields(kind) };
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(job, null, 2), { flag: "wx", mode: 0o600 });
      notify(ctx, `Disabled draft: ${path}. No job was enabled and no watcher was started.`);
    },
  });
}

function registerDecisionLog(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pstack_log",
    label: "Pstack decision log",
    description:
      "Append a timestamped decision with phase, rationale, evidence and result to a session TSV.",
    executionMode: "sequential",
    parameters: Type.Object({
      phase: Type.String(),
      decision: Type.String(),
      reason: Type.String(),
      evidence: Type.String(),
      result: Type.String(),
    }),
    async execute(_id, p, _signal, _update, ctx) {
      const dir = artifacts(ctx);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, "decisions.tsv");
      try {
        await writeFile(path, "time\tphase\tdecision\treason\tevidence\tresult\n", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (e) {
        if (!hasErrorCode(e, "EEXIST")) throw e;
      }
      await appendFile(
        path,
        tsvRow([new Date().toISOString(), p.phase, p.decision, p.reason, p.evidence, p.result]),
      );
      return result(path);
    },
  });
}

function registerHistory(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pstack_history",
    label: "Pstack session history",
    description:
      "Read bounded current branch session entries and artifact directory; use Pi resume/tree for other sessions.",
    parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, p, _signal, _update, ctx) {
      const entries = ctx.sessionManager
        .getBranch()
        .slice(-(p.limit ?? 20))
        .map((e) => ({ type: e.type, id: e.id, data: JSON.stringify(e).slice(0, 4000) }));
      return result({
        session: ctx.sessionManager.getSessionFile(),
        artifacts: artifacts(ctx),
        entries,
      });
    },
  });
}

export function registerRecords(pi: ExtensionAPI, notify: Notify) {
  registerAutomationDraft(pi, notify);
  registerDecisionLog(pi);
  registerHistory(pi);
}
