/**
 * pstack_arena — N candidates, optional cross-judge, return artifacts for graft.
 * Full graft stays in the arena skill; this tool owns fan-out + gather.
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

export function registerArena(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_arena",
    label: "Pstack Arena",
    description:
      "Run N parallel candidates at the same task (optional cross-judge). Parent skill picks base and grafts. Replaces Cursor arena Task fan-out.",
    promptSnippet: "Parallel design/code candidates for arena synthesis",
    promptGuidelines: [
      "Use pstack_arena for arena Phase B fan-out; then pick/graft per the arena skill.",
      "Give each candidate its own output path (worktree or /tmp/arena-...).",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Shared candidate prompt/contract" }),
      candidates: Type.Array(
        Type.Object({
          model: Type.Optional(Type.String()),
          cwd: Type.Optional(Type.String()),
          outputPath: Type.Optional(Type.String()),
          label: Type.Optional(Type.String()),
        }),
        { minItems: 1, maxItems: MAX_TASKS },
      ),
      rubric: Type.Optional(Type.String({ description: "Rubric for optional cross-judge" })),
      crossJudge: Type.Optional(Type.Boolean({ description: "Spawn a readonly judge after candidates" })),
      judgeModel: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new Error("pstack_arena requires an active parent model");
      const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
      let done = 0;
      const results = await mapConcurrent(params.candidates, MAX_CONCURRENCY, async (c, index) => {
        const model =
          c.model ??
          resolveRoleModel("arena runners", parentModel, index) ??
          parentModel;
        const label = c.label ?? `candidate-${index + 1}`;
        const task = [
          params.prompt,
          c.outputPath ? `Write your artifact under: ${c.outputPath}` : "",
          "Also return a short rationale naming alternatives considered and rejected.",
        ]
          .filter(Boolean)
          .join("\n\n");
        const result = await runChildTask(
          {
            task,
            model,
            cwd: c.cwd,
            role: "general",
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
          ctx.cwd,
          parentModel,
          signal,
        );
        done++;
        onUpdate?.({
          content: [{ type: "text", text: `${done}/${params.candidates.length} arena candidates done` }],
          details: {},
        });
        return { label, outputPath: c.outputPath, result };
      });

      let judgeText = "";
      if (params.crossJudge) {
        const judgeModel =
          params.judgeModel ??
          resolveRoleModel("arena cross-judge pool", parentModel) ??
          parentModel;
        const summaries = results
          .map(
            (r) =>
              `### ${r.label} (${r.result.model})\npath: ${r.outputPath ?? "(inline)"}\n\n${r.result.output}`,
          )
          .join("\n\n");
        const judge = await runChildTask(
          {
            task: [
              "You are an arena cross-judge. Score each candidate against the rubric. Recommend a base with rationale.",
              `Rubric:\n${params.rubric ?? "(derive from the shared prompt)"}`,
              summaries,
            ].join("\n\n"),
            model: judgeModel,
            role: "general",
            tools: ["read", "bash", "grep", "find", "ls"],
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
          ctx.cwd,
          parentModel,
          signal,
        );
        judgeText = `\n\n## Cross-judge (${judge.model})\n\n${judge.output}`;
      }

      const body = results
        .map(
          (r) =>
            `### ${r.label} (${r.result.model}, exit ${r.result.exitCode})\npath: ${r.outputPath ?? "(inline)"}\n\n${r.result.output}`,
        )
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text",
            text: `## Arena candidates\n\n${body}${judgeText}\n\nNext: pick a base and graft per the arena skill.`,
          },
        ],
        details: { results },
      };
    },
  });
}
