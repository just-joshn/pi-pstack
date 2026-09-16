/**
 * pstack_spawn — single isolated Pi child agent.
 * Maps Cursor Task / subagent_type → role + child process.
 * background omit/undefined → role-aware: poteto-agent (or poteto:true) detaches,
 * every other role sync-awaits. Explicit background:true/false always wins.
 * resumeSessionDir / resumeJobId continue prior child via --session-dir + --continue/-c
 * (Pi continueRecent; no parent-history dump). sessionDir surfaced in spawn/jobs replies.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { stripAtPrefix } from "../lib/paths.ts";
import { allowedCwdRoots, assertPathContainment } from "../lib/path-contain.ts";
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
  type BackgroundJob,
  type ChildTaskInput,
  type ChildTaskResult,
} from "./child-runner.ts";

export {
  AUTO_READONLY_ROLES,
  resolveResumeSessionDirParam,
  resolveTools,
  wantsBackground,
} from "./child-runner.ts";
import { normalizeModelSelector, projectConfigCwd, resolveRoleModel } from "../models/config.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POTETO_SKILL = resolve(PACKAGE_ROOT, "skills", "poteto-mode", "SKILL.md");

/**
 * Inputs shared by pstack_spawn and pstack_task; the task tool adds policy on top.
 * Optionals carry an explicit `| undefined` because callers resolve them from
 * other optional values and pass the result straight through.
 */
export interface SpawnParams {
  task: string;
  model?: string | undefined;
  /** Config role for model resolution. pstack_task splits this from the behavior role. */
  modelRole?: string | undefined;
  cwd?: string | undefined;
  role?: string | undefined;
  poteto?: boolean | undefined;
  tools?: string[] | undefined;
  readonly?: boolean | undefined;
  inheritParentTools?: boolean | undefined;
  timeoutMs?: number | undefined;
  persistOutput?: boolean | undefined;
  background?: boolean | undefined;
  sessionMode?: string | undefined;
  resumeSessionDir?: string | undefined;
  resumeJobId?: string | undefined;
}

export interface PreparedChild {
  childInput: ChildTaskInput;
  model: string;
  role: string;
  readonlyApplied: boolean;
  background: boolean;
}

function resolveChildModel(
  params: SpawnParams,
  role: string,
  parentModel: string,
  trustedConfigCwd: string | undefined,
): string {
  const modelRole = params.modelRole ?? role;
  const rawModel =
    params.model ?? resolveRoleModel(modelRole, parentModel, 0, trustedConfigCwd) ?? parentModel;
  const modelNorm = params.model
    ? normalizeModelSelector(rawModel, parentModel, { allowFallbackToParent: false })
    : normalizeModelSelector(rawModel, parentModel);
  if (!modelNorm.ok) throw new Error(modelNorm.error);
  return modelNorm.model;
}

function resolveChildToolList(params: SpawnParams, role: string, pi: ExtensionAPI): string[] | undefined {
  let parentTools: string[] | undefined;
  try {
    parentTools = pi.getActiveTools?.() ?? undefined;
  } catch {
    parentTools = undefined;
  }
  return resolveTools(
    role,
    {
      ...(params.tools !== undefined ? { tools: params.tools } : {}),
      ...(params.readonly !== undefined ? { readonly: params.readonly } : {}),
      ...(params.inheritParentTools !== undefined ? { inheritParentTools: params.inheritParentTools } : {}),
    },
    parentTools,
  );
}

/** Resolve a caller-supplied spawn path against the workspace root, honoring the documented allowlist. */
export function containSpawnPath(requested: string | undefined, root: string, label: string): string | undefined {
  if (requested === undefined) return undefined;
  return assertPathContainment(requested, { root, label, allowedRoots: allowedCwdRoots(root) });
}

/**
 * Shared prepare step for pstack_spawn and pstack_task. Refactored from
 * prepareChildInputFromParams so both tools call one implementation; observable
 * pstack_spawn behavior (model resolution, tools, session, background) is unchanged.
 */
export function prepareChildInput(
  params: SpawnParams,
  ctx: {
    model: { provider: string; id: string };
    cwd: string;
    isProjectTrusted?: () => boolean;
  },
  pi: ExtensionAPI,
): PreparedChild {
  const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
  const role = params.role ?? "general";
  const model = resolveChildModel(params, role, parentModel, projectConfigCwd(ctx));
  const tools = resolveChildToolList(params, role, pi);
  const poteto = params.poteto === true || role === "poteto-agent";
  const readonlyApplied = Boolean(tools && tools.every((t) => (READONLY_TOOLS as readonly string[]).includes(t)));
  const sessionMode =
    params.sessionMode === "isolated" || params.sessionMode === "ephemeral"
      ? params.sessionMode
      : undefined;
  const rawResumeDir = stripAtPrefix(params.resumeSessionDir);
  const requestedResumeDir = resolveResumeSessionDirParam({
    ...(rawResumeDir !== undefined ? { resumeSessionDir: rawResumeDir } : {}),
    ...(params.resumeJobId !== undefined ? { resumeJobId: params.resumeJobId } : {}),
    ...(sessionMode !== undefined ? { sessionMode } : {}),
  });
  const resumeSessionDir = containSpawnPath(requestedResumeDir, ctx.cwd, "resumeSessionDir");
  const background = wantsBackground(params.background, poteto);
  const childCwd = containSpawnPath(stripAtPrefix(params.cwd), ctx.cwd, "pstack_spawn cwd");
  const persistOutput =
    params.persistOutput === true
      ? true
      : params.persistOutput === false
        ? false
        : background
          ? true
          : undefined;

  const childInput: ChildTaskInput = {
    task: params.task,
    model,
    role,
    poteto,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(childCwd !== undefined ? { cwd: childCwd } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(poteto ? { skillPath: POTETO_SKILL } : {}),
    ...(persistOutput !== undefined ? { persistOutput } : {}),
    ...(sessionMode !== undefined ? { sessionMode } : {}),
    ...(resumeSessionDir !== undefined ? { resumeSessionDir } : {}),
  };

  return { childInput, model, role, readonlyApplied, background };
}

function formatBackgroundJobResult(done: BackgroundJob, role: string, label: string): string {
  const sessDir = done.result?.sessionDir ?? done.sessionDir;
  const sess = sessDir ? `, sessionDir=${sessDir}` : "";
  return done.result != null
    ? `### ${label} background complete (${done.id}, ${done.result.role ?? role}, ${done.result.model}, exit ${done.result.exitCode}, status=${done.status}${done.result.outputPath ? `, full=${done.result.outputPath}` : ""}${sess})\n\n${done.result.output}`
    : `### ${label} background ${done.status} (${done.id}${sess}): ${done.error ?? "(no result)"}`;
}

function handleListAction(): ChildToolReply {
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
        type: "text" as const,
        text: rows.length ? `${header}\n${rows.join("\n")}` : `${header}\n(no background jobs)`,
      },
    ],
    details: {
      jobs: jobs.map((j) => ({ id: j.id, status: j.status, sessionDir: j.sessionDir })),
      concurrency: stats,
    },
  };
}

function handleAbortAction(jobId: string): ChildToolReply {
  const job = abortBackgroundJob(jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);
  return {
    content: [
      {
        type: "text" as const,
        text: `abort requested; job ${jobId} status=${job.status}`,
      },
    ],
    details: { id: jobId, status: job.status },
  };
}

function handleStatusAction(jobId: string): ChildToolReply {
  const job = getBackgroundJob(jobId);
  if (!job) throw new Error(`unknown job: ${jobId}`);
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
        type: "text" as const,
        text: `${job.id} status=${job.status} role=${job.role ?? "?"} model=${job.model}${sessionDirNote}${tail}`,
      },
    ],
    details: { job, sessionDir: job.sessionDir },
  };
}

async function handleAwaitAction(jobId: string, timeoutMs: number): Promise<ChildToolReply> {
  const job = await awaitBackgroundJob(jobId, timeoutMs);
  const out = job.result?.output ?? job.error ?? "(no output)";
  const sessionDirNote = job.sessionDir ? `, sessionDir=${job.sessionDir}` : "";
  return {
    content: [
      {
        type: "text" as const,
        text: `### pstack_jobs await (${job.id}, status=${job.status}${sessionDirNote})\n\n${out}`,
      },
    ],
    details: { job, sessionDir: job.sessionDir },
  };
}

function handleBackgroundSpawn(
  childInput: ChildTaskInput,
  ctx: { cwd: string },
  parentModel: string,
  role: string,
  model: string,
  readonlyApplied: boolean,
  onUpdate: SpawnOnUpdate,
  pi: ExtensionAPI,
  label = "pstack_spawn",
): ChildToolReply {
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
    pi.sendUserMessage(formatBackgroundJobResult(done, role, label), { deliverAs: "followUp" });
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

async function handleForegroundSpawn(
  childInput: ChildTaskInput,
  ctx: { cwd: string },
  parentModel: string,
  role: string,
  model: string,
  readonlyApplied: boolean,
  signal: AbortSignal | undefined,
  onUpdate: SpawnOnUpdate,
  label = "pstack_spawn",
): Promise<ChildToolReply> {
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
        text: `### ${label} (${result.role ?? role}, ${result.model}, exit ${result.exitCode}${result.outputPath ? `, full=${result.outputPath}` : ""}${sessionDirNote})\n\n${result.output}`,
      },
    ],
    details: { result, readonly: readonlyApplied, sessionDir: result.sessionDir },
  };
}

/** Structured reply shared by the spawn and task tools. */
export type ChildToolReply = AgentToolResult<Record<string, unknown>>;

export type SpawnOnUpdate = AgentToolUpdateCallback<Record<string, unknown>> | undefined;

export interface PreparedChildRun {
  prepared: PreparedChild;
  ctx: { cwd: string };
  parentModel: string;
  /** Reply header label; pstack_spawn keeps its default so its output is unchanged. */
  label?: string | undefined;
  signal?: AbortSignal | undefined;
  onUpdate?: SpawnOnUpdate;
  pi: ExtensionAPI;
}

/** Run one prepared child as either a detached job or an inline synchronous call. */
export async function runPreparedChild(run: PreparedChildRun): Promise<ChildToolReply> {
  const { childInput, model, role, readonlyApplied, background } = run.prepared;
  const label = run.label ?? "pstack_spawn";
  if (background) {
    return handleBackgroundSpawn(
      childInput,
      run.ctx,
      run.parentModel,
      role,
      model,
      readonlyApplied,
      run.onUpdate,
      run.pi,
      label,
    );
  }
  return handleForegroundSpawn(
    childInput,
    run.ctx,
    run.parentModel,
    role,
    model,
    readonlyApplied,
    run.signal,
    run.onUpdate,
    label,
  );
}

const SPAWN_DESCRIPTION =
  `Spawn one isolated Pi child agent. Use role poteto-agent for playbook delegates, comment-sicko for comment review (auto-readonly), investigator for read-only investigation, general for independent workers/reviewers. Background is role-aware: poteto-agent (or poteto:true) detaches by default and posts a follow-up on completion; every other role sync-awaits by default and returns the child's output inline. Pass background explicitly to override either default. resumeSessionDir / resumeJobId continue a prior child via --session-dir + --continue/-c (fail closed if missing; no parent-history dump). Replies include sessionDir for Orchestrate reattach. Global child concurrency cap: ${MAX_CONCURRENCY} (env PSTACK_MAX_CONCURRENCY; shared with swarm/arena). Output cap ${MAX_OUTPUT_BYTES} bytes and ${DEFAULT_MAX_LINES} lines (env PSTACK_MAX_OUTPUT_BYTES; persistOutput or PSTACK_PERSIST_OUTPUT=1 writes full text under .pi/pstack-child-output/). Default sessionMode=isolated (--session-dir; extensions/skills discover, no --no-extensions). ephemeral uses --no-session. inheritParentTools defaults on when tools unset and getActiveTools() is non-empty (pass false to disable; explicit tools[] always wins). Readonly roles still force READONLY_TOOLS. Pi cannot inherit parent MCP/history — documented flags only. persistOutput defaults on for long children (timeout>=5m) and background.`;

const SPAWN_PROMPT_GUIDELINES = [
      "Use pstack_spawn for local child agents (Pi has no Cursor Task).",
      "Use pstack_spawn role poteto-agent for code-writing playbook delegates; comment-sicko for /no-comments (auto-readonly); investigator for investigation playbook children (auto-readonly); general for reviewers.",
      "pstack_spawn background is role-aware: poteto-agent (or poteto:true) detaches by default (job id + completion follow-up, drained via pstack_jobs); every other role sync-awaits by default and returns the child's result inline. Pass background:true/false explicitly to override either default.",
      "pstack_swarm / pstack_arena are intentional sync gather/barrier tools; for background fan-out + drain use N× pstack_spawn (role: poteto-agent for a default-background delegate, or background:true explicitly) then pstack_jobs.",
      "Resume a prior pstack_spawn child with resumeSessionDir (path to its --session-dir) or resumeJobId (in-session job with recorded sessionDir); child argv uses --continue/-c + --session-dir (not dir-only). sessionDir is returned in spawn/jobs replies for standing-store reattach. Still paste standing orders / self-contained brief — no parent-history dump.",
      "pstack_spawn inheritParentTools defaults on when tools unset and getActiveTools() is non-empty; pass inheritParentTools:false to disable. Explicit tools[] wins. Readonly roles force READONLY_TOOLS.",
      "Pass pstack_spawn model as provider/id (or inherit-parent/auto). Bare marketing slugs are refused/mapped.",
      "Review pstack_spawn child output and diffs yourself before accepting work.",
      `pstack_spawn caps ${MAX_CONCURRENCY} concurrent children globally (foreground + background). Raise via PSTACK_MAX_CONCURRENCY.`,
];

const SPAWN_PARAMETERS = Type.Object({
      task: Type.String({ description: "Complete self-contained brief for the child", minLength: 1 }),
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
            "Role-aware default when omitted: poteto-agent (or poteto:true) detaches (job id + completion follow-up); every other role sync-awaits and returns inline. Pass true/false explicitly to override either default. Use pstack_jobs to poll/await detached jobs within this session.",
        }),
      ),
      persistOutput: Type.Optional(
        Type.Boolean({
          description:
            "If true, always persist truncated output to disk. Default: on for background and timeout>=5m (override with false or PSTACK_PERSIST_OUTPUT=0).",
        }),
      ),
      sessionMode: Type.Optional(
        StringEnum(["isolated", "ephemeral"] as const, {
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
});

function registerSpawnTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_spawn",
    label: "Pstack Spawn",
    description: SPAWN_DESCRIPTION,
    promptSnippet: "Spawn an isolated Pi child agent (pstack delegate)",
    promptGuidelines: SPAWN_PROMPT_GUIDELINES,
    parameters: SPAWN_PARAMETERS,
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new Error("pstack_spawn requires an active parent model");
      const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
      const prepared = prepareChildInput(
        params,
        { model: ctx.model, cwd: ctx.cwd, isProjectTrusted: () => ctx.isProjectTrusted() },
        pi,
      );
      return runPreparedChild({ prepared, ctx, parentModel, signal, onUpdate, pi });
    },
  });
}

function registerJobsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_jobs",
    label: "Pstack Jobs",
    description:
      "List, status, await, abort/cancel detached pstack_spawn background jobs (session-scoped; survives follow-ups until session ends). Honest: jobs die on session_shutdown — not a durable daemon.",
    promptSnippet: "Poll or await background pstack_spawn jobs",
    promptGuidelines: [
      "After a detached pstack_spawn (poteto-agent default, or explicit background:true), use pstack_jobs to check status or await completion. Every other role already returns inline by default.",
      "pstack_jobs records persist across follow-ups within the same Pi session; they do not survive process exit.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "status", "await", "abort", "cancel"] as const, {
        description: "list | status | await | abort | cancel",
      }),
      id: Type.Optional(Type.String({ description: "Job id for status|await|abort" })),
      timeoutMs: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS }),
      ),
    }),
    async execute(_id, params) {
      const action = params.action;
      if (action === "list") return handleListAction();
      if (action === "abort" || action === "cancel") {
        if (!params.id) throw new Error("id required for abort");
        return handleAbortAction(params.id);
      }
      if (!params.id) throw new Error("id required for status|await");
      if (action === "status") return handleStatusAction(params.id);
      if (action === "await") return handleAwaitAction(params.id, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      throw new Error("action must be list|status|await|abort|cancel");
    },
  });
}

export function registerSpawn(pi: ExtensionAPI): void {
  pi.on("session_shutdown", () => {
    // Jobs are session-scoped: abort in-flight children and drop the records so
    // a later session cannot list or resume a job from a dead runtime.
    abortAllBackgroundJobs();
  });
  registerSpawnTool(pi);
  registerJobsTool(pi);
}
