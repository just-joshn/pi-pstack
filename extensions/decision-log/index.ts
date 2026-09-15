/**
 * pstack_decision_log — append TSV decision-trail rows (show-me-your-work 6-column schema).
 * Writes only under cwd/.pi (path allowlist).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";

function assertAllowlistedLogPath(cwd: string, requested: string): string {
  const root = resolve(cwd, ".pi");
  const path = resolve(cwd, requested);
  if (path === root || !path.startsWith(root + sep)) {
    throw new Error(
      `pstack_decision_log path must stay under ${root} (got ${path}). Use .pi/decisions.tsv or .pi/audit/<slug>.tsv`,
    );
  }
  return path;
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
      "Schema matches scripts/log.sh: ts, phase, decision, why, evidence, result.",
      "Paths must be under .pi/ (default .pi/decisions.tsv).",
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
      const path = assertAllowlistedLogPath(ctx.cwd, params.path ?? join(".pi", "decisions.tsv"));
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, HEADER, "utf8");
      else {
        const head = readFileSync(path, "utf8").slice(0, 64);
        if (!head.startsWith("ts\t") && !head.startsWith("timestamp")) {
          writeFileSync(path, HEADER + readFileSync(path, "utf8"), "utf8");
        }
      }
      const row = [
        new Date().toISOString(),
        escapeTsv(params.phase),
        escapeTsv(params.decision),
        escapeTsv(params.why),
        escapeTsv(params.evidence ?? ""),
        escapeTsv(params.result ?? ""),
      ].join("\t");
      appendFileSync(path, `${row}\n`, "utf8");
      pi.appendEntry("pstack-decision", { path, decision: params.decision, phase: params.phase });
      return {
        content: [{ type: "text", text: `Logged decision to ${path}` }],
        details: { path, decision: params.decision, phase: params.phase },
      };
    },
  });
}

function escapeTsv(value: string): string {
  let v = value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(v)) v = `'${v}`;
  return v;
}
