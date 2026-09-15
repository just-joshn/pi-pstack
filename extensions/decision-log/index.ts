/**
 * pstack_decision_log — append TSV decision-trail rows (show-me-your-work).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HEADER = "timestamp\tdecision\trationale\tevidence\n";

export function registerDecisionLog(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_decision_log",
    label: "Pstack Decision Log",
    description:
      "Append a row to decisions.tsv (show-me-your-work trail). Creates the file with a header if missing.",
    promptSnippet: "Append an auditable decision-trail row",
    promptGuidelines: [
      "Use pstack_decision_log during long/autonomous runs per the show-me-your-work skill.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Path to decisions.tsv (default ./decisions.tsv)" }),
      ),
      decision: Type.String(),
      rationale: Type.String(),
      evidence: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolve(ctx.cwd, params.path ?? "decisions.tsv");
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, HEADER, "utf8");
      else {
        const head = readFileSync(path, "utf8").slice(0, 32);
        if (!head.startsWith("timestamp")) {
          writeFileSync(path, HEADER + readFileSync(path, "utf8"), "utf8");
        }
      }
      const row = [
        new Date().toISOString(),
        escapeTsv(params.decision),
        escapeTsv(params.rationale),
        escapeTsv(params.evidence ?? ""),
      ].join("\t");
      appendFileSync(path, `${row}\n`, "utf8");
      pi.appendEntry("pstack-decision", { path, decision: params.decision });
      return {
        content: [{ type: "text", text: `Logged decision to ${path}` }],
        details: { path, decision: params.decision },
      };
    },
  });
}

function escapeTsv(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}
