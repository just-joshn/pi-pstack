/**
 * pstack_swarm — fan-out N parallel child agents, aggregate one report.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  mapConcurrent,
  runChildTask,
} from "../subagents/child-runner.ts";
import { resolveRoleModel } from "../models/config.ts";

export function registerSwarm(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_swarm",
    label: "Pstack Swarm",
    description:
      "Fan out N parallel Pi child workers (coverage / race / best-of). Replaces Cursor swarm Task fan-out. Max 8 tasks, 4 concurrent.",
    promptSnippet: "Parallel pstack workers with aggregated report",
    promptGuidelines: [
      "Use pstack_swarm for coverage matrices, races, and gauntlets instead of multiple Cursor Task calls.",
      "Each worker brief must stand alone with goal, scope, verify steps, and PASS/ISSUES/BLOCKED reporting.",
    ],
    parameters: Type.Object({
      workers: Type.Array(
        Type.Object({
          task: Type.String(),
          model: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String()),
          role: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: MAX_TASKS },
      ),
      selection: Type.Optional(
        Type.String({ description: "first-pass | rank-all | best-of | coverage (default)" }),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new Error("pstack_swarm requires an active parent model");
      const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
      let done = 0;
      const results = await mapConcurrent(params.workers, MAX_CONCURRENCY, async (w) => {
        const model =
          w.model ??
          resolveRoleModel("swarm workers", parentModel) ??
          parentModel;
        const result = await runChildTask(
          {
            task: w.task,
            model,
            cwd: w.cwd,
            role: w.role ?? "general",
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
          ctx.cwd,
          parentModel,
          signal,
        );
        done++;
        onUpdate?.({
          content: [{ type: "text", text: `${done}/${params.workers.length} swarm workers done` }],
          details: {},
        });
        return result;
      });

      const selection = params.selection ?? "coverage";
      const table = results
        .map(
          (r, i) =>
            `| ${i + 1} | ${r.model} | exit ${r.exitCode} | ${r.stopReason ?? "-"} |`,
        )
        .join("\n");
      const bodies = results
        .map((r, i) => `### Worker ${i + 1} (${r.model}, exit ${r.exitCode})\n\n${r.output}`)
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text",
            text: `## Swarm report (${selection})\n\n| # | model | exit | stop |\n|---|-------|------|------|\n${table}\n\n${bodies}`,
          },
        ],
        details: { selection, results },
      };
    },
  });
}
