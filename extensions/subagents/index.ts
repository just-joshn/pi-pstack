/**
 * pstack_spawn — single isolated Pi child agent.
 * Maps Cursor Task / subagent_type → role + child process.
 * background:true detaches via in-process job queue + completion follow-up.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  READONLY_TOOLS,
  abortAllBackgroundJobs,
  abortBackgroundJob,
  awaitBackgroundJob,
  childConcurrencyStats,
  enqueueBackgroundChild,
  getBackgroundJob,
  listBackgroundJobs,
  runChildTask,
  type ChildTaskResult,
} from "./child-runner.ts";
import { normalizeModelSelector, resolveRoleModel } from "../models/config.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POTETO_SKILL = resolve(PACKAGE_ROOT, "skills", "poteto-mode", "SKILL.md");

/** Roles that always get the readonly tool allowlist (no bash/write/edit). */
const AUTO_READONLY_ROLES = new Set(["comment-sicko", "investigator"]);

function resolveTools(
  role: string,
  params: { tools?: string[]; readonly?: boolean },
): string[] | undefined {
  if (params.tools?.length) return params.tools;
  if (params.readonly === true || AUTO_READONLY_ROLES.has(role)) {
    return [...READONLY_TOOLS];
  }
  return undefined;
}

export function registerSpawn(pi: ExtensionAPI): void {
  pi.on("session_shutdown", () => {
    // Abort in-flight children; finished job records are discarded with the process.
    // Within a live session, jobs remain listable via pstack_jobs across follow-ups.
    abortAllBackgroundJobs();
  });

  pi.registerTool({
    name: "pstack_spawn",
    label: "Pstack Spawn",
    description:
      `Spawn one isolated Pi child agent. Use role poteto-agent for playbook delegates, comment-sicko for comment review (auto-readonly), investigator for read-only investigation, general for independent workers/reviewers. background:true detaches and posts a follow-up on completion. Global child concurrency cap: ${MAX_CONCURRENCY} (env PSTACK_MAX_CONCURRENCY; shared with swarm/arena). Output cap ${MAX_OUTPUT_BYTES} bytes (env PSTACK_MAX_OUTPUT_BYTES; persistOutput or PSTACK_PERSIST_OUTPUT=1 writes full text under .pi/pstack-child-output/). sessionMode isolated uses --session-dir instead of --no-session.`,
    promptSnippet: "Spawn an isolated Pi child agent (pstack delegate)",
    promptGuidelines: [
      "Use pstack_spawn for local child agents (Pi has no Cursor Task).",
      "Use role poteto-agent for code-writing playbook delegates; comment-sicko for /no-comments (auto-readonly); investigator for investigation playbook children (auto-readonly); general for reviewers.",
      "background:true returns a job id immediately; completion arrives as a follow-up message. Use pstack_jobs to list/await across follow-ups in this session. Prefer pstack_swarm / pstack_arena for parallel fan-out.",
      "Pass model as provider/id (or inherit-parent/auto). Bare marketing slugs are refused/mapped.",
      "Review child output and diffs yourself before accepting work.",
      `Cap ${MAX_CONCURRENCY} concurrent children globally (foreground + background). Raise via PSTACK_MAX_CONCURRENCY.`,
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Complete self-contained brief for the child" }),
      role: Type.Optional(
        Type.String({
          description:
            "poteto-agent | comment-sicko | investigator | general (default general). comment-sicko and investigator auto-apply readonly allowlist.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "provider/model, or inherit-parent / auto. Else role config applies. Bare marketing slugs refused.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Child working directory" })),
      poteto: Type.Optional(Type.Boolean({ description: "Force poteto-mode in child" })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Child tool allowlist" })),
      readonly: Type.Optional(
        Type.Boolean({
          description: `If true, restrict child to Pi read-only builtins: ${READONLY_TOOLS.join(",")}. Auto-true for comment-sicko and investigator.`,
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "If true, detach: return job id immediately; child runs under concurrency cap; completion posts a follow-up. Use pstack_jobs to poll/await within this session.",
        }),
      ),
      persistOutput: Type.Optional(
        Type.Boolean({
          description:
            "If true (or PSTACK_PERSIST_OUTPUT=1), write full child output under cwd/.pi/pstack-child-output/ when truncated.",
        }),
      ),
      sessionMode: Type.Optional(
        Type.String({
          description:
            "ephemeral (default, --no-session) | isolated (--session-dir under .pi/pstack-child-sessions). Env PSTACK_CHILD_SESSION overrides default.",
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
      const rawModel =
        params.model ??
        resolveRoleModel(role, parentModel) ??
        parentModel;
      const modelNorm = normalizeModelSelector(rawModel, parentModel);
      if (!modelNorm.ok) {
        throw new Error(modelNorm.error);
      }
      const model = modelNorm.model;
      const tools = resolveTools(role, params);
      const poteto = params.poteto === true || role === "poteto-agent";
      const readonlyApplied = Boolean(tools && tools.every((t) => (READONLY_TOOLS as readonly string[]).includes(t)));
      const sessionMode =
        params.sessionMode === "isolated" || params.sessionMode === "ephemeral"
          ? params.sessionMode
          : undefined;

      const childInput = {
        task: params.task,
        model,
        cwd: params.cwd,
        role,
        poteto,
        tools,
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        skillPath: poteto ? POTETO_SKILL : undefined,
        persistOutput: params.persistOutput === true,
        sessionMode,
      };

      if (params.background) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Spawning ${role} on ${model} in background${readonlyApplied ? " (readonly)" : ""}…`,
            },
          ],
          details: {},
        });
        const job = enqueueBackgroundChild(childInput, ctx.cwd, parentModel, (done) => {
          const body =
            done.result != null
              ? `### pstack_spawn background complete (${done.id}, ${done.result.role ?? role}, ${done.result.model}, exit ${done.result.exitCode}, status=${done.status}${done.result.outputPath ? `, full=${done.result.outputPath}` : ""})\n\n${done.result.output}`
              : `### pstack_spawn background ${done.status} (${done.id}): ${done.error ?? "(no result)"}`;
          pi.sendUserMessage(body, { deliverAs: "followUp" });
        });
        const stats = childConcurrencyStats();
        return {
          content: [
            {
              type: "text",
              text: `Background job ${job.id} started (role=${role}, model=${model}${readonlyApplied ? ", readonly" : ""}). Completion will arrive as a follow-up. Poll with pstack_jobs action=status|await id=${job.id}. Concurrency ${stats.active}/${stats.cap} (waiting ${stats.waiting}). Jobs remain queryable for this session.`,
            },
          ],
          details: {
            jobId: job.id,
            status: job.status,
            background: true,
            readonly: readonlyApplied,
            concurrency: stats,
          },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Spawning ${role} on ${model}${readonlyApplied ? " (readonly)" : ""}…`,
          },
        ],
        details: {},
      });

      const result: ChildTaskResult = await runChildTask(
        childInput,
        ctx.cwd,
        parentModel,
        signal,
      );

      return {
        content: [
          {
            type: "text",
            text: `### pstack_spawn (${result.role ?? role}, ${result.model}, exit ${result.exitCode}${result.outputPath ? `, full=${result.outputPath}` : ""})\n\n${result.output}`,
          },
        ],
        details: { result, readonly: readonlyApplied },
      };
    },
  });

  pi.registerTool({
    name: "pstack_jobs",
    label: "Pstack Jobs",
    description:
      "List, status, await, or abort detached pstack_spawn background jobs (session-scoped; survives follow-ups until session ends). Honest: jobs die on session_shutdown — not a durable daemon.",
    promptSnippet: "Poll or await background pstack_spawn jobs",
    promptGuidelines: [
      "After pstack_spawn with background:true, use pstack_jobs to check status or await completion if you need the result inline.",
      "Jobs persist across follow-ups within the same Pi session; they do not survive process exit.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | status | await | abort" }),
      id: Type.Optional(Type.String({ description: "Job id for status|await|abort" })),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS }),
      ),
    }),
    async execute(_id, params) {
      const action = params.action;
      if (action === "list") {
        const rows = listBackgroundJobs().map(
          (j) =>
            `${j.id} status=${j.status} role=${j.role ?? "?"} model=${j.model} started=${new Date(j.startedAt).toISOString()}${j.finishedAt ? ` finished=${new Date(j.finishedAt).toISOString()}` : ""}`,
        );
        const stats = childConcurrencyStats();
        const header = `concurrency ${stats.active}/${stats.cap} waiting=${stats.waiting}`;
        return {
          content: [
            {
              type: "text",
              text: rows.length ? `${header}\n${rows.join("\n")}` : `${header}\n(no background jobs)`,
            },
          ],
          details: { jobs: listBackgroundJobs().map((j) => j.id), concurrency: stats },
        };
      }
      if (action === "abort") {
        if (!params.id) throw new Error("id required for abort");
        const job = abortBackgroundJob(params.id);
        if (!job) throw new Error(`unknown job: ${params.id}`);
        return {
          content: [
            {
              type: "text",
              text: `abort requested; job ${params.id} status=${job.status}`,
            },
          ],
          details: { id: params.id, status: job.status },
        };
      }
      if (!params.id) throw new Error("id required for status|await");
      if (action === "status") {
        const job = getBackgroundJob(params.id);
        if (!job) throw new Error(`unknown job: ${params.id}`);
        const tail =
          job.result != null
            ? `\n\nexit ${job.result.exitCode}${job.result.outputPath ? ` full=${job.result.outputPath}` : ""}\n${job.result.output.slice(0, 8000)}`
            : job.error
              ? `\n\nerror: ${job.error}`
              : "";
        return {
          content: [
            {
              type: "text",
              text: `${job.id} status=${job.status} role=${job.role ?? "?"} model=${job.model}${tail}`,
            },
          ],
          details: { job },
        };
      }
      if (action === "await") {
        const job = await awaitBackgroundJob(params.id, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const out = job.result?.output ?? job.error ?? "(no output)";
        return {
          content: [
            {
              type: "text",
              text: `### pstack_jobs await (${job.id}, status=${job.status})\n\n${out}`,
            },
          ],
          details: { job },
        };
      }
      throw new Error("action must be list|status|await|abort");
    },
  });
}
