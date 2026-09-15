/**
 * pstack_spawn — single isolated Pi child agent.
 * Maps Cursor Task / subagent_type → role + child process.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runChildTask,
  type ChildTaskResult,
} from "./child-runner.ts";
import { resolveRoleModel } from "../models/config.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POTETO_SKILL = resolve(PACKAGE_ROOT, "skills", "poteto-mode", "SKILL.md");

export function registerSpawn(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_spawn",
    label: "Pstack Spawn",
    description:
      "Spawn one isolated Pi child agent. Use role poteto-agent for playbook delegates, comment-sicko for comment review, general for independent workers/reviewers. Replaces Cursor Task/subagent_type.",
    promptSnippet: "Spawn an isolated Pi child agent (pstack delegate)",
    promptGuidelines: [
      "Use pstack_spawn instead of Cursor Task / subagent_type.",
      "Use role poteto-agent for code-writing playbook delegates; comment-sicko for /no-comments; general for reviewers.",
      "Review child output and diffs yourself before accepting work.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Complete self-contained brief for the child" }),
      role: Type.Optional(
        Type.String({
          description: "poteto-agent | comment-sicko | general (default general)",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "provider/model, or inherit-parent / auto. Else role config applies.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Child working directory" })),
      poteto: Type.Optional(Type.Boolean({ description: "Force poteto-mode in child" })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Child tool allowlist" })),
      readonly: Type.Optional(
        Type.Boolean({ description: "If true, restrict child tools to read,bash,grep,find,ls" }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description: "Accepted for parity; v1 still awaits the child (TODO: true async jobs)",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new Error("pstack_spawn requires an active parent model");
      const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
      const role = params.role ?? "general";
      const model =
        params.model ??
        resolveRoleModel(role, parentModel) ??
        parentModel;
      const tools =
        params.tools ??
        (params.readonly ? ["read", "bash", "grep", "find", "ls"] : undefined);
      const poteto = params.poteto === true || role === "poteto-agent";

      onUpdate?.({
        content: [{ type: "text", text: `Spawning ${role} on ${model}…` }],
        details: {},
      });

      const result: ChildTaskResult = await runChildTask(
        {
          task: params.task,
          model,
          cwd: params.cwd,
          role,
          poteto,
          tools,
          timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          skillPath: poteto ? POTETO_SKILL : undefined,
        },
        ctx.cwd,
        parentModel,
        signal,
      );

      return {
        content: [
          {
            type: "text",
            text: `### pstack_spawn (${result.role ?? role}, ${result.model}, exit ${result.exitCode})\n\n${result.output}`,
          },
        ],
        details: { result },
      };
    },
  });
}
