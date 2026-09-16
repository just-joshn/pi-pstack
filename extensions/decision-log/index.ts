/**
 * pstack_decision_log — append TSV decision-trail rows (show-me-your-work 6-column schema).
 * Writes only under cwd/.pi (path allowlist).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stripAtPrefix } from "../lib/paths.ts";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";

function assertAllowlistedLogPath(cwd: string, requested: string): string {
  const root = resolve(cwd, CONFIG_DIR_NAME);
  const path = resolve(cwd, requested);
  if (path === root || !path.startsWith(root + sep)) {
    throw new Error(
      `pstack_decision_log path must stay under ${root} (got ${path}). Use .pi/decisions.tsv or .pi/audit/<slug>.tsv`,
    );
  }
  return path;
}

type DecisionLogParams = {
  path?: string;
  phase: string;
  decision: string;
  why: string;
  evidence?: string;
  result?: string;
};

function ensureDecisionLogHeader(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, HEADER, "utf8");
  else {
    const head = readFileSync(path, "utf8").slice(0, 64);
    if (!head.startsWith("ts\t") && !head.startsWith("timestamp")) {
      writeFileSync(path, HEADER + readFileSync(path, "utf8"), "utf8");
    }
  }
}

function formatDecisionRow(params: DecisionLogParams): string {
  return [
    new Date().toISOString(),
    escapeTsv(params.phase),
    escapeTsv(params.decision),
    escapeTsv(params.why),
    escapeTsv(params.evidence ?? ""),
    escapeTsv(params.result ?? ""),
  ].join("\t");
}

async function executeDecisionLog(
  pi: ExtensionAPI,
  params: DecisionLogParams,
  ctx: ExtensionContext,
): Promise<AgentToolResult<Record<string, unknown>>> {
  const path = assertAllowlistedLogPath(
    ctx.cwd,
    stripAtPrefix(params.path) ?? join(CONFIG_DIR_NAME, "decisions.tsv"),
  );
  await withFileMutationQueue(path, async () => {
    ensureDecisionLogHeader(path);
    appendFileSync(path, `${formatDecisionRow(params)}\n`, "utf8");
  });
  pi.appendEntry("pstack-decision", { path, decision: params.decision, phase: params.phase });
  return {
    content: [{ type: "text", text: `Logged decision to ${path}` }],
    details: { path, decision: params.decision, phase: params.phase },
  };
}

export function registerDecisionLog(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_decision_log",
    label: "Pstack Decision Log",
    description:
      "Append a show-me-your-work decision-trail row (ts/phase/decision/why/evidence/result). Path allowlisted under cwd/.pi only.",
    promptSnippet: "Append an auditable decision-trail row",
    promptGuidelines: [
      "Use pstack_decision_log during long/autonomous runs per the show-me-your-work skill.",
      "pstack_decision_log schema matches scripts/log.sh: ts, phase, decision, why, evidence, result.",
      "pstack_decision_log paths must be under .pi/ (default .pi/decisions.tsv).",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description: "Path under .pi/ (default .pi/decisions.tsv)",
        }),
      ),
      phase: Type.String({ description: "Phase or workstream" }),
      decision: Type.String({ description: "What was chosen or done" }),
      why: Type.String({ description: "Reason in plain words" }),
      evidence: Type.Optional(
        Type.String({ description: "Pointer: commit SHA, PR, file:line, artifact path" }),
      ),
      result: Type.Optional(
        Type.String({ description: "Outcome / predicate state" }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return await executeDecisionLog(pi, params, ctx);
    },
  });
}

function escapeTsv(value: string): string {
  let v = value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  return v;
}
