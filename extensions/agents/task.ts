/**
 * pstack_task — the policy-complete child-agent entrypoint (mandate sections 7 and 8).
 *
 * pstack_spawn stays the byte-compatible compat alias. This tool compiles a
 * multidimensional PstackTaskPolicy first, derives the child tool allowlist and
 * thinking level from it, and forwards the compiled policy to the child as
 * PSTACK_CHILD_POLICY where policy-guard.ts enforces it.
 *
 * environment=hosted hands the envelope to the hosted worker service. It never
 * silently downgrades to a local child: a hosted run has different durability
 * semantics, so a missing PSTACK_HOSTED_URL is an error, not a fallback.
 */
import { randomBytes } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MAX_TIMEOUT_MS, wantsBackground, type ChildTaskInput } from "../subagents/child-runner.ts";
import {
  containSpawnPath,
  prepareChildInput,
  runPreparedChild,
  type ChildToolReply,
  type SpawnOnUpdate,
} from "../subagents/index.ts";
import { buildTaskEnvelope, postTask } from "../hosted/client.ts";
import { createIsolatedWorktree } from "../worktree/helpers.ts";
import {
  compileTaskPolicy,
  describePolicy,
  ENVIRONMENT_VALUES,
  FILESYSTEM_VALUES,
  GIT_VALUES,
  ISOLATION_VALUES,
  NETWORK_VALUES,
  resolvePolicyTools,
  resolveThinkingLevel,
  SHELL_VALUES,
  type PstackTaskPolicy,
} from "./policy.ts";
import { THINKING_LEVELS } from "../models/budget.ts";

export interface TaskPermissions {
  filesystem?: string;
  shell?: string;
  git?: string;
  network?: string;
  integrations?: string | string[];
  environment?: string;
  background?: boolean;
  isolation?: string;
}

export interface TaskParams {
  prompt: string;
  subagent_type?: string;
  modelRole?: string;
  model?: string;
  thinkingLevel?: string;
  readonly?: boolean;
  run_in_background?: boolean;
  environment?: string;
  cloud_base_branch?: string;
  cwd?: string;
  worktree?: boolean;
  permissions?: TaskPermissions;
  isolation?: string;
  timeoutMs?: number;
  sessionMode?: string;
  resumeSessionDir?: string;
  resumeJobId?: string;
  tools?: string[];
  persistOutput?: boolean;
  inheritParentTools?: boolean;
}

export interface TaskContext {
  readonly cwd: string;
  readonly model: { provider: string; id: string } | undefined;
  readonly isProjectTrusted?: () => boolean;
}

interface WorktreeAllocation {
  path: string;
  branch: string;
}

interface HostedResult {
  runId: string;
  status: number;
  text: string;
}

const TASK_DESCRIPTION =
  "Run one pstack child agent under a compiled multidimensional policy. subagent_type picks the behavior role and its default policy (comment-sicko, investigator, poteto-agent, general); modelRole picks the model config entry. The eight policy dimensions are filesystem, shell, git, network, integrations, environment, background, and isolation. Integrations are independent of the filesystem axis: an investigator keeps integrations inherited while its filesystem is read-only. environment=hosted requires PSTACK_HOSTED_URL and runs on the worker service; there is no silent local fallback. worktree:true allocates an isolated git worktree and returns its path for parent cleanup. Child output caps at 50KB / 2000 lines; when truncated the trailing lines name the full-output path.";

const TASK_PROMPT_GUIDELINES = [
  "Reach for pstack_task when a child needs an explicit policy; pstack_spawn remains the compat alias with role-derived defaults only.",
  "pstack_task subagent_type is the behavior role (general default) and selects the policy defaults; modelRole is the model-config role and defaults to subagent_type.",
  "pstack_task policy dimensions are independent. Filesystem read-only does not imply integrations none: investigator defaults keep integrations inherited, because the upstream why/reflect work needs MCP-style capabilities while the tree stays untouched.",
  "pstack_task explicit readonly:true forces filesystem read-only, shell none, and git read. worktree:true forces isolation worktree. environment:hosted forces isolation remote unless a stronger container/vm sandbox was requested.",
  "pstack_task permissions overrides any axis by name; top-level readonly, worktree, environment, isolation, and run_in_background win over the permissions object.",
  "pstack_task thinkingLevel is forwarded as `--thinking <level>`; when omitted, the level embedded in a provider/id:level selector applies.",
  "The pstack_task compiled policy is passed to the child as PSTACK_CHILD_POLICY and enforced by the child's policy guard, so argv is a hint and the guard is the boundary.",
  "pstack_task hosted runs need PSTACK_HOSTED_URL (services/worker). A missing URL is an error that names the prerequisite; the local path is not parity.",
];

const TASK_PERMISSIONS = Type.Object(
  {
    filesystem: Type.Optional(StringEnum(FILESYSTEM_VALUES, { description: "read-only | workspace-write" })),
    shell: Type.Optional(StringEnum(SHELL_VALUES, { description: "none | restricted | full" })),
    git: Type.Optional(StringEnum(GIT_VALUES, { description: "read | branch-write | push | merge" })),
    network: Type.Optional(StringEnum(NETWORK_VALUES, { description: "none | allowed" })),
    integrations: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description: "none | inherit | [source-control, issue-tracker, long-form-docs, team-chat, observability, error-tracking, analytics, browser-ui, cli-tui]",
      }),
    ),
    environment: Type.Optional(StringEnum(ENVIRONMENT_VALUES, { description: "local | hosted" })),
    background: Type.Optional(
      Type.Boolean({ description: "Policy background flag; run_in_background wins when set." }),
    ),
    isolation: Type.Optional(
      StringEnum(ISOLATION_VALUES, { description: "session | process | worktree | container | vm | remote" }),
    ),
  },
  { additionalProperties: false },
);

const TASK_PARAMETERS = Type.Object({
  prompt: Type.String({ description: "Complete self-contained brief for the child", minLength: 1 }),
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Behavior role: poteto-agent | comment-sicko | investigator | general (default general). Selects the role policy defaults.",
    }),
  ),
  modelRole: Type.Optional(
    Type.String({ description: "Model-config role for resolveRoleModel; defaults to subagent_type." }),
  ),
  model: Type.Optional(
    Type.String({
      description: "provider/model, or inherit-parent / auto. Else the modelRole config applies. Bare marketing slugs refused.",
    }),
  ),
  thinkingLevel: Type.Optional(
    StringEnum(THINKING_LEVELS, { description: "off | minimal | low | medium | high | xhigh | max; forwarded as --thinking." }),
  ),
  readonly: Type.Optional(
    Type.Boolean({
      description: "Force filesystem read-only, shell none, and git read for this child.",
    }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "Detach with a job id and a completion follow-up. Omitted, poteto-agent detaches and every other role sync-awaits.",
    }),
  ),
  environment: Type.Optional(
    StringEnum(ENVIRONMENT_VALUES, { description: "local (default) | hosted (requires PSTACK_HOSTED_URL; services/worker)." }),
  ),
  cloud_base_branch: Type.Optional(
    Type.String({ description: "Base ref for a requested worktree or hosted run." }),
  ),
  cwd: Type.Optional(Type.String({ description: "Child working directory; worktree:true replaces it." })),
  worktree: Type.Optional(
    Type.Boolean({ description: "Allocate an isolated git worktree and use it as the child cwd." }),
  ),
  permissions: Type.Optional(TASK_PERMISSIONS),
  isolation: Type.Optional(
    StringEnum(ISOLATION_VALUES, { description: "session | process | worktree | container | vm | remote" }),
  ),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS })),
  sessionMode: Type.Optional(
    StringEnum(["isolated", "ephemeral"] as const, { description: "isolated (default, --session-dir) | ephemeral (--no-session)." }),
  ),
  resumeSessionDir: Type.Optional(
    Type.String({ description: "Path to a prior child --session-dir; fail closed when missing (--continue)." }),
  ),
  resumeJobId: Type.Optional(
    Type.String({ description: "In-session background job id whose recorded sessionDir should be resumed." }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), { description: "Explicit child tool allowlist; wins over the policy-derived list." }),
  ),
  persistOutput: Type.Optional(Type.Boolean({ description: "Persist truncated output to disk." })),
  inheritParentTools: Type.Optional(
    Type.Boolean({ description: "Inherit the parent tool list when the policy does not decide one; default on." }),
  ),
});

/** Merge role defaults with the tool params into one frozen policy. */
export function compilePolicyFromParams(params: TaskParams, role: string): PstackTaskPolicy {
  const permissions = params.permissions;
  const background =
    params.run_in_background ??
    permissions?.background ??
    wantsBackground(undefined, role === "poteto-agent");
  return compileTaskPolicy(
    {
      ...permissions,
      environment: params.environment ?? permissions?.environment,
      isolation: params.isolation ?? permissions?.isolation,
      readonly: params.readonly,
      worktree: params.worktree,
      background,
    },
    role,
  );
}

function readParentTools(pi: ExtensionAPI, inheritParentTools?: boolean): string[] | undefined {
  if (inheritParentTools === false) return undefined;
  try {
    return pi.getActiveTools?.() ?? undefined;
  } catch {
    return undefined;
  }
}

async function allocateTaskWorktree(
  policy: PstackTaskPolicy,
  params: TaskParams,
  parentCwd: string,
): Promise<WorktreeAllocation | undefined> {
  if (policy.isolation !== "worktree") return undefined;
  const slug = `task-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const base = params.cloud_base_branch?.trim() || "HEAD";
  return createIsolatedWorktree(parentCwd, slug, base);
}

async function runHostedTask(
  params: TaskParams,
  policy: PstackTaskPolicy,
  role: string,
  model: string,
  thinkingLevel: string | undefined,
  ctx: TaskContext,
  signal: AbortSignal | undefined,
): Promise<HostedResult> {
  const base = process.env.PSTACK_HOSTED_URL?.trim();
  if (!base) {
    throw new Error(
      "pstack_task environment=hosted requires PSTACK_HOSTED_URL pointing at the hosted worker (services/worker). " +
        "The local fallback is not parity: a hosted run needs the worker's durable run record and result stream. " +
        "Set PSTACK_HOSTED_URL or pass environment=\"local\".",
    );
  }
  const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const envelope = buildTaskEnvelope({
    runId,
    task: params.prompt,
    role,
    model,
    policy,
    parentCwd: ctx.cwd,
    thinkingLevel,
    timeoutMs: params.timeoutMs,
  });
  const reply = await postTask(envelope, { base, signal });
  return { runId, status: reply.status, text: reply.text };
}

function policyTrailer(policy: PstackTaskPolicy, thinkingLevel: string | undefined, worktree?: WorktreeAllocation): string {
  const level = thinkingLevel ?? "default";
  const tree = worktree ? `; worktree=${worktree.path} (branch ${worktree.branch})` : "";
  return `policy: ${describePolicy(policy)}; thinkingLevel=${level}${tree}`;
}

function withPolicyDetails(
  reply: ChildToolReply,
  policy: PstackTaskPolicy,
  thinkingLevel: string | undefined,
  worktree?: WorktreeAllocation,
): ChildToolReply {
  return {
    content: [...reply.content, { type: "text", text: policyTrailer(policy, thinkingLevel, worktree) }],
    details: {
      ...reply.details,
      policy,
      thinkingLevel: thinkingLevel ?? null,
      ...(worktree ? { worktree: worktree.path, worktreeBranch: worktree.branch } : {}),
    },
  };
}

function hostedReply(
  hosted: HostedResult,
  policy: PstackTaskPolicy,
  thinkingLevel: string | undefined,
  model: string,
  role: string,
): ChildToolReply {
  return {
    content: [
      { type: "text", text: hosted.text },
      { type: "text", text: policyTrailer(policy, thinkingLevel) },
    ],
    details: {
      hosted: true,
      runId: hosted.runId,
      status: hosted.status,
      model,
      role,
      policy,
      thinkingLevel: thinkingLevel ?? null,
    },
  };
}

async function executeTask(
  params: TaskParams,
  signal: AbortSignal | undefined,
  onUpdate: SpawnOnUpdate,
  ctx: TaskContext,
  pi: ExtensionAPI,
) {
  if (!ctx.model) throw new Error("pstack_task requires an active parent model");
  const parentModel = `${ctx.model.provider}/${ctx.model.id}`;
  const role = params.subagent_type ?? "general";
  const policy = compilePolicyFromParams(params, role);
  const parentTools = readParentTools(pi, params.inheritParentTools);
  const tools = resolvePolicyTools(policy, params.tools, parentTools);
  const prepared = prepareChildInput(
    {
      task: params.prompt,
      role,
      modelRole: params.modelRole,
      model: params.model,
      cwd: params.cwd,
      tools,
      inheritParentTools: params.inheritParentTools,
      timeoutMs: params.timeoutMs,
      persistOutput: params.persistOutput,
      background: policy.background,
      sessionMode: params.sessionMode,
      resumeSessionDir: params.resumeSessionDir,
      resumeJobId: params.resumeJobId,
    },
    { model: ctx.model, cwd: ctx.cwd, isProjectTrusted: ctx.isProjectTrusted },
    pi,
  );
  const thinkingLevel = resolveThinkingLevel(params, prepared.model);
  if (policy.environment === "hosted") {
    const hosted = await runHostedTask(params, policy, role, prepared.model, thinkingLevel, ctx, signal);
    return hostedReply(hosted, policy, thinkingLevel, prepared.model, role);
  }
  const worktree = await allocateTaskWorktree(policy, params, ctx.cwd);
  const childInput: ChildTaskInput = {
    ...prepared.childInput,
    policy,
    thinkingLevel,
    ...(worktree ? { cwd: containSpawnPath(worktree.path, ctx.cwd, "pstack_task worktree cwd") } : {}),
  };
  const reply = await runPreparedChild({
    prepared: { ...prepared, childInput },
    ctx,
    parentModel,
    label: "pstack_task",
    signal,
    onUpdate,
    pi,
  });
  return withPolicyDetails(reply, policy, thinkingLevel, worktree);
}

export function registerTask(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_task",
    label: "Pstack Task",
    description: TASK_DESCRIPTION,
    promptSnippet: "Run a pstack child agent under a compiled multidimensional policy",
    promptGuidelines: TASK_PROMPT_GUIDELINES,
    parameters: TASK_PARAMETERS,
    async execute(_id, params, signal, onUpdate, ctx) {
      return executeTask(params, signal, onUpdate, ctx, pi);
    },
  });
}
