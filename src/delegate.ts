import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { root } from "../lib/catalog.ts";
import {
  type Budget,
  crossJudge,
  type Effort,
  effort,
  isRole,
  judgeRole,
  modelFor,
  type Role,
  type RoleConfig,
  selectPanel,
} from "../lib/models.ts";
import { pool, type PoolResult } from "../lib/pool.ts";
import { blindTranscript, readPaths } from "../lib/transcript.ts";
import { errorMessage } from "../lib/validation.ts";
import { gitIn } from "./git.ts";
import { availableWorkerModels, readConfig, workerExtensions, workerIsolation } from "./models.ts";
import { type ParentDiff, saveParentDiff } from "./parent-diff.ts";
import { artifacts, fail, piBin, result, stringEnum } from "./support.ts";
import { createWorktree } from "./worktrees.ts";

const modes = ["single", "swarm", "arena", "interrogate"] as const;
type Mode = (typeof modes)[number];

interface WorkerRole {
  alwaysReadOnly: boolean;
  modelRole: Role;
  contract?: string;
}
const reviewer = (contract: string): WorkerRole => ({
  alwaysReadOnly: true,
  modelRole: "judgment and prose",
  contract,
});
export const workerRoles = new Map<string, WorkerRole>([
  [
    "poteto-agent",
    { alwaysReadOnly: false, modelRole: "feature, refactoring", contract: "poteto-agent.md" },
  ],
  ["comment-sicko", reviewer("comment-sicko.md")],
  ["ci-watcher", reviewer("ci-watcher.md")],
  ["quality-agent", reviewer("quality-agent.md")],
  ["general-purpose", { alwaysReadOnly: false, modelRole: "judgment and prose" }],
]);
const panelModelRoles: Partial<Record<Mode, Role>> = {
  arena: "arena runners",
  interrogate: "interrogate reviewers",
  swarm: "swarm workers",
};

const parameters = Type.Object({
  mode: stringEnum(modes),
  tasks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8 }),
  role: Type.Optional(Type.String()),
  modelRole: Type.Optional(Type.String()),
  readOnly: Type.Optional(Type.Boolean()),
  rubric: Type.Optional(Type.String()),
  base: Type.Optional(Type.String()),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
});
type DelegateParams = Static<typeof parameters>;

function resolveWorkers(
  p: DelegateParams,
  config: RoleConfig,
  parent: string,
  available: ReadonlySet<string>,
) {
  const role = p.role ?? (p.mode === "single" ? "poteto-agent" : "general-purpose");
  const worker = workerRoles.get(role);
  if (!worker) fail("Unknown worker role");
  const modelRole = p.modelRole ?? panelModelRoles[p.mode] ?? worker.modelRole;
  if (!isRole(modelRole)) fail("Unknown model role");
  const readOnly = worker.alwaysReadOnly || p.mode === "interrogate" || p.readOnly !== false;
  if (p.mode !== "swarm" && p.tasks.length !== 1)
    fail("Single, arena and interrogate require one shared task");
  if (p.mode === "arena" && !p.rubric?.trim()) fail("Arena requires a common evaluation rubric");
  const choices = config.roles[modelRole];
  const panel = p.mode === "arena" || p.mode === "interrogate";
  if (panel && choices.length < 2) fail("Configure at least two panel seats in /setup-pstack");
  const tasks = panel ? choices.flatMap(() => p.tasks) : p.tasks;
  const models = selectPanel(config, modelRole, tasks.length).map((m) => modelFor(m, parent));
  assertReachable(available, models);
  const judge = p.mode === "arena" ? crossJudge(config, parent, models, available) : undefined;
  if (p.mode === "arena" && !judge)
    fail(
      `Configure an available judge from another provider than the parent and all candidates in /setup-pstack. Configured pool: ${config.roles[judgeRole].join(", ") || "(empty)"}.`,
    );
  const workers = tasks.flatMap((task, i) =>
    models.slice(i, i + 1).map((model) => ({ task, model })),
  );
  return { role, modelRole, readOnly, workers, judge };
}

export function workerArgs(options: {
  model: string;
  thinking: Effort;
  readOnly: boolean;
  extension?: string | undefined;
  sessionDir: string;
  sessionId: string;
  prompt: string;
}) {
  return [
    "--print",
    ...workerIsolation,
    ...(options.extension ? ["-e", options.extension] : []),
    "--tools",
    options.readOnly ? "read,grep,find,ls" : "read,grep,find,ls,bash,edit,write",
    "--session-dir",
    options.sessionDir,
    "--session-id",
    options.sessionId,
    "--model",
    options.model,
    "--thinking",
    options.thinking,
    "--",
    options.prompt,
  ];
}

interface WorkerRequest {
  task: string;
  model: string;
  index: number;
  readOnly: boolean;
  role: string;
  modelRole: Role;
}
interface RunnerOptions {
  dir: string;
  budget: Budget;
  extensions: ReadonlyMap<string, string>;
  rubric: string | undefined;
  base: string | undefined;
  diff: ParentDiff | undefined;
  signal: AbortSignal | undefined;
  progress: (message: string) => void;
}

function diffNotes(diff: ParentDiff | undefined) {
  if (!diff)
    return [
      "Parent diff artifact unavailable; uncommitted parent changes are not described anywhere.",
    ];
  const more = diff.omitted.length > 50 ? ` and ${diff.omitted.length - 50} more` : "";
  return [
    `Parent diff artifact (tracked changes and untracked files): ${diff.path}. Write worktrees start at the selected committed base and do not include uncommitted changes.`,
    diff.omitted.length &&
      `Untracked files omitted from the artifact (too large, too many or unreadable): ${diff.omitted.slice(0, 50).join(", ")}${more}.`,
  ];
}

async function workerPrompt(request: WorkerRequest, options: RunnerOptions) {
  const kickoffPath = join(root, "agents", "worker.md");
  const contract = workerRoles.get(request.role)?.contract;
  return [
    `Read ${kickoffPath} before anything else.`,
    await readFile(kickoffPath, "utf8"),
    contract
      ? await readFile(join(root, "agents", contract), "utf8")
      : "Independent scoped worker.",
    request.role === "poteto-agent" &&
      (await readFile(join(root, "skills", "poteto-mode", "SKILL.md"), "utf8")),
    `Assigned task: ${request.task}`,
    options.rubric && `Finish predicate / rubric: ${options.rubric}`,
    ...diffNotes(options.diff),
    "Return evidence and artifact paths; do not perform external side effects.",
  ]
    .filter(Boolean)
    .join("\n");
}

function createRunner(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  active: Set<string>,
  options: RunnerOptions,
) {
  return async (request: WorkerRequest) => {
    const { dir, signal } = options;
    if (signal?.aborted) fail("Cancelled");
    const { index, readOnly, model, modelRole } = request;
    const id = `worker-${index + 1}-${randomUUID().slice(0, 8)}`;
    const tree = readOnly
      ? { path: ctx.cwd, base: null }
      : await createWorktree(gitIn(pi, ctx.cwd, signal), ctx, id, options.base);
    if (!readOnly) active.add(tree.path);
    try {
      const sessionDir = join(dir, id);
      await mkdir(sessionDir, { mode: 0o700 });
      const args = workerArgs({
        model,
        thinking: effort(modelRole, options.budget, model),
        readOnly,
        extension: options.extensions.get(model),
        sessionDir,
        sessionId: id,
        prompt: await workerPrompt(request, options),
      });
      options.progress(`Running ${id}`);
      const run = await pi.exec(piBin, args, {
        cwd: tree.path,
        timeout: 30 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
        ...(signal && { signal }),
      });
      const report = join(dir, `${id}.txt`);
      await Promise.all([
        writeFile(report, run.stdout, { mode: 0o600 }),
        writeFile(join(dir, `${id}.stderr.txt`), run.stderr, { mode: 0o600 }),
      ]);
      if (run.code !== 0 || run.truncated || run.killed)
        fail(`Worker ${id} failed (${run.code}); inspect ${report}`);
      const sessions = (await readdir(sessionDir, { recursive: true })).filter((path) =>
        path.endsWith(".jsonl"),
      );
      const [session, ...others] = sessions;
      const transcript = session !== undefined && !others.length ? join(sessionDir, session) : null;
      return {
        id,
        model,
        ...tree,
        report,
        transcript,
        sessionDir,
        summary: run.stdout.slice(-6000),
      };
    } finally {
      if (!readOnly) active.delete(tree.path);
    }
  };
}

type RunWorker = ReturnType<typeof createRunner>;
type WorkerReport = Awaited<ReturnType<RunWorker>>;
async function judgeArena(
  dir: string,
  outputs: PoolResult<WorkerReport>[],
  rubric: string | undefined,
  judge: string,
  run: RunWorker,
) {
  if (!outputs.every((entry) => entry.status === "fulfilled"))
    return { status: "INCONCLUSIVE: a candidate failed" };
  const candidates = outputs.map((entry) => entry.value);
  const blindDir = join(dir, "blinded");
  await mkdir(blindDir, { mode: 0o700 });
  const files = await Promise.all(
    candidates.map(async ({ model, transcript }, i) => {
      if (!transcript) return null;
      const projection = blindTranscript(await readFile(transcript, "utf8"), model);
      if (!projection.trim()) return null;
      const path = join(blindDir, `candidate-${i + 1}.jsonl`);
      await writeFile(path, projection, { mode: 0o600 });
      return path;
    }),
  );
  if (!files.every((path) => path !== null))
    return { status: "INCONCLUSIVE: missing or empty candidate transcript" };
  const worktrees = candidates
    .map((candidate, i) => `Candidate ${i + 1}: ${candidate.path}`)
    .join("; ");
  const assessment = await run({
    task: `Judge these ${files.length} anonymous candidate message transcripts: ${files.join(", ")}. Read every file in full, including tool results; rubric: ${rubric}. Rank by actual evidence; note missing artifacts or unverifiable claims. For write candidates, inspect candidate worktrees if necessary: ${worktrees}. Do not infer provider identity.`,
    model: judge,
    index: candidates.length,
    readOnly: true,
    role: "general-purpose",
    modelRole: judgeRole,
  });
  const reads = new Set(
    assessment.transcript ? readPaths(await readFile(assessment.transcript, "utf8")) : [],
  );
  const readAudit = files.map((path) => ({ path, read: reads.has(path) }));
  return {
    ...assessment,
    readAudit,
    status: readAudit.every((entry) => entry.read)
      ? "reviewed"
      : "INCONCLUSIVE: judge did not read every projected transcript",
  };
}

function assertReachable(available: ReadonlySet<string>, models: string[]) {
  const unreachable = [...new Set(models)].filter((model) => !available.has(model));
  if (unreachable.length)
    fail(
      `Workers load no extension except the one that provides their model. Unavailable in the current worker scope: ${unreachable.join(", ")}. Choose an available model in /setup-pstack.`,
    );
}

export function registerDelegation(pi: ExtensionAPI, active: Set<string>) {
  pi.registerTool({
    name: "pstack_delegate",
    label: "Pstack Pi workers",
    description:
      "Run independent native Pi CLI sessions: single, swarm, arena or interrogate. Read-only by default; write workers use detached worktrees. Child sessions and reports are retained.",
    parameters,
    async execute(_id, p, signal, onUpdate, ctx) {
      const config = await readConfig();
      if (!ctx.model) fail("Select a parent model first");
      const parent = `${ctx.model.provider}/${ctx.model.id}`;
      const extensions = await workerExtensions(pi, ctx, signal);
      const available = new Set(availableWorkerModels(ctx, extensions));
      const { role, modelRole, readOnly, workers, judge } = resolveWorkers(
        p,
        config,
        parent,
        available,
      );
      if (
        !readOnly &&
        (!ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Authorize isolated write workers?",
            `${workers.length} worker(s), detached worktrees from ${p.base ?? "HEAD"}. Workers can execute shell commands; worktrees are not a security sandbox.`,
          )))
      )
        fail("Write delegation not authorized");
      const dir = join(artifacts(ctx), "workers", randomUUID());
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const run = createRunner(pi, ctx, active, {
        dir,
        signal,
        diff: await saveParentDiff(pi, ctx.cwd, dir, signal),
        budget: config.budget,
        extensions,
        base: p.base,
        rubric: p.rubric,
        progress: (message) => onUpdate?.(result(message)),
      });
      const outputs = await pool(workers, p.concurrency ?? 3, ({ task, model }, index) =>
        run({ task, index, model, readOnly, role, modelRole }),
      );
      const judgment =
        judge &&
        (await judgeArena(dir, outputs, p.rubric, judge, run).catch((error: unknown) => ({
          status: "INCONCLUSIVE: could not complete arena judgment",
          model: judge,
          error: errorMessage(error),
        })));
      return result({
        outputs,
        judgment,
        dir,
        warning:
          "Local workers only. Review actual artifacts and rerun acceptance checks; report text is not proof.",
      });
    },
  });
}
