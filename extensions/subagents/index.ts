/**
 * pstack_spawn — single isolated Pi child agent.
 * Maps Cursor Task / subagent_type → role + child process.
 * background omit/undefined → detach (default); background:false → sync-await.
 * resumeSessionDir / resumeJobId continue prior child via --session-dir + --continue/-c
 * (Pi continueRecent; no parent-history dump). sessionDir surfaced in spawn/jobs replies.
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
  resolveResumeSessionDirParam,
  resolveTools,
  runChildTask,
  wantsBackground,
  type ChildTaskResult,
} from "./child-runner.ts";

export {
  AUTO_READONLY_ROLES,
  resolveResumeSessionDirParam,
  resolveTools,
  wantsBackground,
} from "./child-runner.ts";
import { normalizeModelSelector, resolveRoleModel } from "../models/config.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POTETO_SKILL = resolve(PACKAGE_ROOT, "skills", "poteto-mode", "SKILL.md");

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
      `Spawn one isolated Pi child agent. Use role poteto-agent for playbook delegates, comment-sicko for comment review (auto-readonly), investigator for read-only investigation, general for independent workers/reviewers. Default background (omit or true) detaches and posts a follow-up on completion; pass background:false for sync-await. resumeSessionDir / resumeJobId continue a prior child via --session-dir + --continue/-c (fail closed if missing; no parent-history dump). Replies include sessionDir for Orchestrate reattach. Global child concurrency cap: ${MAX_CONCURRENCY} (env PSTACK_MAX_CONCURRENCY; shared with swarm/arena). Output cap ${MAX_OUTPUT_BYTES} bytes (env PSTACK_MAX_OUTPUT_BYTES; persistOutput or PSTACK_PERSIST_OUTPUT=1 writes full text under .pi/pstack-child-output/). Default sessionMode=isolated (--session-dir; extensions/skills discover, no --no-extensions). ephemeral uses --no-session. inheritParentTools defaults on when tools unset and getActiveTools() is non-empty (pass false to disable; explicit tools[] always wins). Readonly roles still force READONLY_TOOLS. Pi cannot inherit parent MCP/history — documented flags only. persistOutput defaults on for long children (timeout>=5m) and background.`,
    promptSnippet: "Spawn an isolated Pi child agent (pstack delegate)",
    promptGuidelines: [
      "Use pstack_spawn for local child agents (Pi has no Cursor Task).",
      "Use role poteto-agent for code-writing playbook delegates; comment-sicko for /no-comments (auto-readonly); investigator for investigation playbook children (auto-readonly); general for reviewers.",
      "Prefer / default background: omit background or pass true to detach (job id + completion follow-up). Sync-await requires explicit background:false. Use pstack_jobs to list/await across follow-ups in this session.",
      "pstack_swarm / pstack_arena are intentional sync gather/barrier tools; for background fan-out + drain use N× pstack_spawn (default background) then pstack_jobs.",
      "Resume a prior child with resumeSessionDir (path to its --session-dir) or resumeJobId (in-session job with recorded sessionDir); child argv uses --continue/-c + --session-dir (not dir-only). sessionDir is returned in spawn/jobs replies for standing-store reattach. Still paste standing orders / self-contained brief — no parent-history dump.",
      "inheritParentTools defaults on when tools unset and getActiveTools() is non-empty; pass inheritParentTools:false to disable. Explicit tools[] wins. Readonly roles force READONLY_TOOLS.",
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
      tools: Type.Optional(Type.Array(Type.String(), { description: "Child tool allowlist (overrides inheritParentTools)" })),
      inheritParentTools: Type.Optional(
        Type.Boolean({
          description:
            "Default on when tools unset and getActiveTools() returns a non-empty list. Pass false to disable inherit. Explicit tools[] always wins. Readonly roles still force READONLY_TOOLS.",
        }),
      ),
      readonly: Type.Optional(
        Type.Boolean({
          description: `If true, restrict child to Pi read-only builtins: ${READONLY_TOOLS.join(",")}. Auto-true for comment-sicko and investigator.`,
        }),
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Default true when omitted: detach (job id + completion follow-up). Pass false for sync-await. Use pstack_jobs to poll/await detached jobs within this session.",
        }),
      ),
      persistOutput: Type.Optional(
        Type.Boolean({
          description:
            "If true, always persist truncated output to disk. Default: on for background and timeout>=5m (override with false or PSTACK_PERSIST_OUTPUT=0).",
        }),
      ),
      sessionMode: Type.Optional(
        Type.String({
          description:
            "isolated (default, --session-dir) | ephemeral (--no-session). Env PSTACK_CHILD_SESSION overrides. Pi has no parent MCP/history inheritance; children still load package extensions/skills.",
        }),
      ),
      resumeSessionDir: Type.Optional(
        Type.String({
          description:
            "Absolute or cwd-relative path to a prior child --session-dir. Passes --continue/-c so Pi continueRecent loads the child transcript (not SessionManager.create). Fail closed if missing. Do not dump parent history; keep the task brief self-contained.",
        }),
      ),
      resumeJobId: Type.Optional(
        Type.String({
          description:
            "In-session background job id whose recorded sessionDir should be resumed. Fails if unknown or sessionDir missing; prefer resumeSessionDir after process restart.",
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
      // Explicit caller model: refuse invalid bare slugs (no silent parent fallback).
      // Role-resolved / default paths may map or fall back.
      const modelNorm = params.model
        ? normalizeModelSelector(rawModel, parentModel, { allowFallbackToParent: false })
        : normalizeModelSelector(rawModel, parentModel);
      if (!modelNorm.ok) {
        throw new Error(modelNorm.error);
      }
      const model = modelNorm.model;
      let parentTools: string[] | undefined;
      try {
        parentTools = pi.getActiveTools?.() ?? undefined;
      } catch {
        parentTools = undefined;
      }
      const tools = resolveTools(role, params, parentTools);
      const poteto = params.poteto === true || role === "poteto-agent";
      const readonlyApplied = Boolean(tools && tools.every((t) => (READONLY_TOOLS as readonly string[]).includes(t)));
      const sessionMode =
        params.sessionMode === "isolated" || params.sessionMode === "ephemeral"
          ? params.sessionMode
          : undefined;
      const resumeSessionDir = resolveResumeSessionDirParam({
        resumeSessionDir: params.resumeSessionDir,
        resumeJobId: params.resumeJobId,
        sessionMode,
      });
      const background = wantsBackground(params.background);

      const childInput = {
        task: params.task,
        model,
        cwd: params.cwd,
        role,
        poteto,
        tools,
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        skillPath: poteto ? POTETO_SKILL : undefined,
        persistOutput:
          params.persistOutput === true
            ? true
            : params.persistOutput === false
              ? false
              : background
                ? true
                : undefined,
        sessionMode,
        resumeSessionDir,
      };

      if (background) {
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
          const sessDir = done.result?.sessionDir ?? done.sessionDir;
          const sess = sessDir ? `, sessionDir=${sessDir}` : "";
          const body =
            done.result != null
              ? `### pstack_spawn background complete (${done.id}, ${done.result.role ?? role}, ${done.result.model}, exit ${done.result.exitCode}, status=${done.status}${done.result.outputPath ? `, full=${done.result.outputPath}` : ""}${sess})\n\n${done.result.output}`
              : `### pstack_spawn background ${done.status} (${done.id}${sess}): ${done.error ?? "(no result)"}`;
          pi.sendUserMessage(body, { deliverAs: "followUp" });
        });
        const stats = childConcurrencyStats();
        const sessionDirNote = job.sessionDir ? ` sessionDir=${job.sessionDir}` : "";
        return {
          content: [
            {
              type: "text",
              text: `Background job ${job.id} started (role=${role}, model=${model}${readonlyApplied ? ", readonly" : ""}${sessionDirNote}). Completion will arrive as a follow-up. Poll with pstack_jobs action=status|await id=${job.id}. Concurrency ${stats.active}/${stats.cap} (waiting ${stats.waiting}). Jobs remain queryable for this session.`,
            },
          ],
          details: {
            jobId: job.id,
            status: job.status,
            background: true,
            readonly: readonlyApplied,
            concurrency: stats,
            sessionDir: job.sessionDir,
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

      const sessionDirNote = result.sessionDir ? `, sessionDir=${result.sessionDir}` : "";
      return {
        content: [
          {
            type: "text",
            text: `### pstack_spawn (${result.role ?? role}, ${result.model}, exit ${result.exitCode}${result.outputPath ? `, full=${result.outputPath}` : ""}${sessionDirNote})\n\n${result.output}`,
          },
        ],
        details: { result, readonly: readonlyApplied, sessionDir: result.sessionDir },
      };
    },
  });

  pi.registerTool({
    name: "pstack_jobs",
    label: "Pstack Jobs",
    description:
      "List, status, await, abort/cancel detached pstack_spawn background jobs (session-scoped; survives follow-ups until session ends). Honest: jobs die on session_shutdown — not a durable daemon.",
    promptSnippet: "Poll or await background pstack_spawn jobs",
    promptGuidelines: [
      "After pstack_spawn (default background / omit), use pstack_jobs to check status or await completion if you need the result inline. Sync-await uses background:false.",
      "Jobs persist across follow-ups within the same Pi session; they do not survive process exit.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | status | await | abort | cancel" }),
      id: Type.Optional(Type.String({ description: "Job id for status|await|abort" })),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS }),
      ),
    }),
    async execute(_id, params) {
      const action = params.action;
      if (action === "list") {
        const jobs = listBackgroundJobs();
        const rows = jobs.map(
          (j) =>
            `${j.id} status=${j.status} role=${j.role ?? "?"} model=${j.model} started=${new Date(j.startedAt).toISOString()}${j.finishedAt ? ` finished=${new Date(j.finishedAt).toISOString()}` : ""}${j.sessionDir ? ` sessionDir=${j.sessionDir}` : ""}`,
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
          details: {
            jobs: jobs.map((j) => ({ id: j.id, status: j.status, sessionDir: j.sessionDir })),
            concurrency: stats,
          },
        };
      }
      if (action === "abort" || action === "cancel") {
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
        const sessionDirNote = job.sessionDir ? ` sessionDir=${job.sessionDir}` : "";
        return {
          content: [
            {
              type: "text",
              text: `${job.id} status=${job.status} role=${job.role ?? "?"} model=${job.model}${sessionDirNote}${tail}`,
            },
          ],
          details: { job, sessionDir: job.sessionDir },
        };
      }
      if (action === "await") {
        const job = await awaitBackgroundJob(params.id, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const out = job.result?.output ?? job.error ?? "(no output)";
        const sessionDirNote = job.sessionDir ? `, sessionDir=${job.sessionDir}` : "";
        return {
          content: [
            {
              type: "text",
              text: `### pstack_jobs await (${job.id}, status=${job.status}${sessionDirNote})\n\n${out}`,
            },
          ],
          details: { job, sessionDir: job.sessionDir },
        };
      }
      throw new Error("action must be list|status|await|abort|cancel");
    },
  });
}
