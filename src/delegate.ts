import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { BackgroundWorkers } from "./background.ts";
import { gitIn } from "./git.ts";
import { srcDir } from "./lib/catalog.ts";
import {
  type Budget,
  crossJudge,
  effort,
  isRole,
  judgeRole,
  modelFor,
  type Role,
  type RoleConfig,
  selectPanel,
} from "./lib/models.ts";
import { pool, type PoolResult } from "./lib/pool.ts";
import { blindTranscript, readPaths } from "./lib/transcript.ts";
import { errorMessage, isRecord, parseJson } from "./lib/validation.ts";
import {
  availableWorkerModels,
  modelName,
  readConfig,
  workerExtensions,
  workerIsolation,
} from "./models.ts";
import { type ParentDiff, saveParentDiff } from "./parent-diff.ts";
import { artifacts, fail, piBin, result, stringEnum } from "./support.ts";
import { type ActiveWorktrees, createWorktree } from "./worktrees.ts";

const modes = ["single", "swarm", "arena", "interrogate"] as const;
type Mode = (typeof modes)[number];

interface WorkerRole {
  alwaysReadOnly: boolean;
  modelRole: Role;
  contract?: string;
  /** Runs shell commands in the parent's checkout, without edit tools or a worktree. */
  shell?: boolean;
}
export const workerRoles = new Map<string, WorkerRole>([
  [
    "poteto-agent",
    { alwaysReadOnly: false, modelRole: "feature, refactoring", contract: "poteto-agent.md" },
  ],
  // Comment Sicko deletes comments itself, in its own worktree; it never edits application code.
  [
    "comment-sicko",
    { alwaysReadOnly: false, modelRole: "judgment and prose", contract: "comment-sicko.md" },
  ],
  // Upstream's CI watcher runs gh and git on the parent's branch, on the fast model.
  [
    "ci-watcher",
    { alwaysReadOnly: true, shell: true, modelRole: "swarm workers", contract: "ci-watcher.md" },
  ],
  [
    "thermo-nuclear-code-quality-review",
    {
      alwaysReadOnly: true,
      modelRole: "judgment and prose",
      contract: "thermo-nuclear-code-quality-review.md",
    },
  ],
  ["general-purpose", { alwaysReadOnly: false, modelRole: "judgment and prose" }],
]);
const panelModelRoles: Partial<Record<Mode, Role>> = {
  arena: "arena runners",
  interrogate: "interrogate reviewers",
  swarm: "swarm workers",
};

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Thinking = (typeof thinkingLevels)[number];
const parameters = Type.Object({
  mode: stringEnum(modes),
  tasks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8 }),
  role: Type.Optional(Type.String()),
  modelRole: Type.Optional(Type.String()),
  model: Type.Optional(
    Type.String({
      description:
        "Exact provider/model ID, or auto or inherit-parent, for single and swarm workers. Panels use their configured seats.",
    }),
  ),
  models: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 8,
      description:
        "Exact provider/model IDs or aliases: one per seat for arena and interrogate, in place of the configured panel, or one per task for swarm, such as a model race.",
    }),
  ),
  thinking: Type.Optional(stringEnum(thinkingLevels)),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return at once with each worker's id and sessionDir and let it run, with no time limit, until it exits. Check it with pstack_workers. Single and swarm only.",
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "A prior worker's sessionDir. Continues that worker's session in its checkout with the task as the next message. Mode single only.",
    }),
  ),
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
  // Interrogate adversaries prove each finding by running it in their own worktree.
  const readOnly = worker.alwaysReadOnly || (p.mode !== "interrogate" && p.readOnly !== false);
  if (p.mode !== "swarm" && p.tasks.length !== 1)
    fail("Single, arena and interrogate require one shared task");
  if (p.mode === "arena" && !p.rubric?.trim()) fail("Arena requires a common evaluation rubric");
  const panel = p.mode === "arena" || p.mode === "interrogate";
  const choices = panel ? (p.models ?? config.roles[modelRole]) : config.roles[modelRole];
  if (panel && (p.model || p.thinking))
    fail("Panel seats use their configured models and levels; omit model and thinking");
  if (panel && choices.length < 2) fail("A panel needs at least two seats");
  const tasks = panel ? choices.flatMap(() => p.tasks) : p.tasks;
  const models = workerModels(p, { panel, choices, count: tasks.length }, config, modelRole).map(
    (m) => modelFor(m, parent),
  );
  assertReachable(available, models);
  const judge = p.mode === "arena" ? crossJudge(config, parent, available) : undefined;
  const workers = tasks.flatMap((task, i) =>
    models.slice(i, i + 1).map((model) => ({ task, model })),
  );
  const shell = readOnly && worker.shell === true;
  return { role, modelRole, readOnly, shell, workers, judge, thinking: p.thinking };
}

/** Each worker's model: a panel's seats, a swarm's per-task models, one model, or the role's. */
function workerModels(
  p: DelegateParams,
  batch: { panel: boolean; choices: string[]; count: number },
  config: RoleConfig,
  modelRole: Role,
) {
  if (batch.panel) return batch.choices;
  if (p.models) {
    if (p.mode !== "swarm" || p.models.length !== batch.count)
      fail("Outside a panel, models takes one entry per swarm task");
    if (p.model) fail("Pass model or models, not both");
    return p.models;
  }
  const { model } = p;
  if (model) return Array.from({ length: batch.count }, () => model);
  return selectPanel(config, modelRole, batch.count);
}

const readTools = "read,grep,find,ls";
export function workerArgs(options: {
  model: string;
  thinking: Thinking;
  readOnly: boolean;
  shell?: boolean | undefined;
  extension?: string | undefined;
  sessionDir: string;
  sessionId: string;
  prompt: string;
}) {
  return [
    "--print",
    // A read-only worker has no MCP tools; a writing worker keeps the parent's, as in upstream.
    ...workerIsolation.filter((flag) => options.readOnly || flag !== "--no-mcp"),
    ...(options.extension ? ["-e", options.extension] : []),
    "--tools",
    options.readOnly
      ? `${readTools}${options.shell ? ",bash" : ""}`
      : `${readTools},bash,edit,write`,
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
  thinking?: Thinking | undefined;
  id?: string;
  shell?: boolean | undefined;
}
interface RunnerOptions {
  dir: string;
  budget: Budget;
  extensions: ReadonlyMap<string, string>;
  rubric: string | undefined;
  base: string | undefined;
  timeoutMs?: number;
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
    `Parent diff artifact (changes since ${diff.base}, including commits, tracked changes and untracked files): ${diff.path}. Write worktrees start at the selected committed base and do not include uncommitted changes.`,
    diff.omitted.length &&
      `Untracked files omitted from the artifact (too large, too many or unreadable): ${diff.omitted.slice(0, 50).join(", ")}${more}.`,
  ];
}

async function workerPrompt(request: WorkerRequest, options: RunnerOptions) {
  const kickoffPath = join(srcDir, "skills", "poteto-mode", "worker.md");
  const contract = workerRoles.get(request.role)?.contract;
  return [
    `Read ${kickoffPath} before anything else.`,
    await readFile(kickoffPath, "utf8"),
    contract
      ? (await readFile(join(srcDir, "agents", contract), "utf8")).replace(/^---\n[^]*?\n---\n/, "")
      : "Independent scoped worker.",
    request.role === "poteto-agent" &&
      (await readFile(join(srcDir, "skills", "poteto-mode", "SKILL.md"), "utf8")),
    `Assigned task: ${request.task}`,
    options.rubric && `Finish predicate / rubric: ${options.rubric}`,
    ...diffNotes(options.diff),
  ]
    .filter(Boolean)
    .join("\n");
}

async function singleTranscript(sessionDir: string) {
  const sessions = (await readdir(sessionDir, { recursive: true })).filter((path) =>
    path.endsWith(".jsonl"),
  );
  const [session, ...others] = sessions;
  return session !== undefined && !others.length ? join(sessionDir, session) : null;
}

interface WorkerRecord {
  id: string;
  sessionDir: string;
  cwd: string;
  model: string;
  readOnly: boolean;
  shell?: boolean | undefined;
  thinking: Thinking;
  extension?: string | undefined;
}
const isThinking = (value: unknown): value is Thinking =>
  thinkingLevels.some((level) => level === value);
const isWorkerRecord = (value: unknown): value is WorkerRecord =>
  isRecord(value) &&
  ["id", "sessionDir", "cwd", "model"].every((key) => typeof value[key] === "string") &&
  typeof value["readOnly"] === "boolean" &&
  isThinking(value["thinking"]);

async function execWorker(
  pi: ExtensionAPI,
  options: Pick<RunnerOptions, "signal" | "progress" | "timeoutMs">,
  worker: WorkerRecord,
  run: { thinking: Thinking; prompt: string; report: string },
) {
  const args = workerArgs({
    model: worker.model,
    readOnly: worker.readOnly,
    shell: worker.shell,
    extension: worker.extension,
    sessionDir: worker.sessionDir,
    sessionId: worker.id,
    thinking: run.thinking,
    prompt: run.prompt,
  });
  options.progress(`Running ${worker.id}`);
  const exec = await pi.exec(piBin, args, {
    cwd: worker.cwd,
    timeout: options.timeoutMs ?? 30 * 60 * 1000,
    maxBuffer: 4 * 1024 * 1024,
    ...(options.signal && { signal: options.signal }),
  });
  await Promise.all([
    writeFile(run.report, exec.stdout, { mode: 0o600 }),
    writeFile(run.report.replace(/\.txt$/, ".stderr.txt"), exec.stderr, { mode: 0o600 }),
  ]);
  if (exec.code !== 0 || exec.truncated || exec.killed)
    fail(`Worker ${worker.id} failed (${exec.code}); inspect ${run.report}`);
  return {
    report: run.report,
    transcript: await singleTranscript(worker.sessionDir),
    sessionDir: worker.sessionDir,
    summary: exec.stdout.slice(-6000),
  };
}

async function launchWorker(
  pi: ExtensionAPI,
  request: WorkerRequest,
  options: RunnerOptions,
  id: string,
  cwd: string,
) {
  const sessionDir = join(options.dir, id);
  await mkdir(sessionDir, { mode: 0o700 });
  const worker: WorkerRecord = {
    id,
    sessionDir,
    cwd,
    model: request.model,
    readOnly: request.readOnly,
    shell: request.shell,
    thinking: request.thinking ?? effort(request.modelRole, options.budget, request.model),
    extension: options.extensions.get(request.model),
  };
  await writeFile(join(sessionDir, "worker.json"), JSON.stringify(worker, null, 2), {
    mode: 0o600,
  });
  return execWorker(pi, options, worker, {
    thinking: worker.thinking,
    prompt: await workerPrompt(request, options),
    report: join(options.dir, `${id}.txt`),
  });
}

/** Continues a prior worker's own Pi session in its own checkout with a follow-up message. */
async function resumeWorker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  active: ActiveWorktrees,
  p: DelegateParams & { resume: string },
  options: Pick<RunnerOptions, "signal" | "progress">,
) {
  if (p.mode !== "single" || p.tasks.length !== 1 || p.model)
    fail("Resume takes mode single, one follow-up task, and no model");
  const workers = join(artifacts(ctx), "workers");
  const sessionDir = resolve(p.resume);
  if (!sessionDir.startsWith(workers + sep)) fail(`Resume a worker session under ${workers}`);
  const worker: unknown = parseJson(
    await readFile(join(sessionDir, "worker.json"), "utf8"),
    "worker record",
  );
  if (!isWorkerRecord(worker) || worker.sessionDir !== sessionDir) fail("Invalid worker record");
  const run = () =>
    execWorker(pi, options, worker, {
      thinking: p.thinking ?? worker.thinking,
      prompt: p.tasks.join("\n"),
      report: join(sessionDir, `resume-${randomUUID().slice(0, 8)}.txt`),
    });
  const output = worker.readOnly ? await run() : await active.hold(worker.cwd, run);
  const value = { id: worker.id, model: worker.model, path: worker.cwd, base: null, ...output };
  return { outputs: [{ status: "fulfilled", value }], dir: dirname(sessionDir) };
}

const workerId = (index: number) => `worker-${index + 1}-${randomUUID().slice(0, 8)}`;
/** A background worker runs until its process exits, as upstream's background subagents do. */
const backgroundTimeoutMs = 7 * 24 * 60 * 60 * 1000;

function createRunner(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  active: ActiveWorktrees,
  options: RunnerOptions,
) {
  return async (request: WorkerRequest) => {
    if (options.signal?.aborted) fail("Cancelled");
    const id = request.id ?? workerId(request.index);
    const tree = request.readOnly
      ? { path: ctx.cwd, base: null }
      : await createWorktree(gitIn(pi, ctx.cwd, options.signal), ctx, id, options.base);
    const work = async () => ({
      id,
      model: request.model,
      ...tree,
      ...(await launchWorker(pi, request, options, id, tree.path)),
    });
    return request.readOnly ? work() : active.hold(tree.path, work);
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
  const blindDir = join(dir, "blinded");
  await mkdir(blindDir, { mode: 0o700 });
  const projected = await Promise.all(
    outputs.map(async (entry, i) => {
      if (entry.status !== "fulfilled" || !entry.value.transcript) return null;
      const { model, transcript, path: worktree } = entry.value;
      const projection = blindTranscript(await readFile(transcript, "utf8"), model);
      if (!projection.trim()) return null;
      const path = join(blindDir, `candidate-${i + 1}.jsonl`);
      await writeFile(path, projection, { mode: 0o600 });
      return { path, label: `Candidate ${i + 1}: ${worktree}` };
    }),
  );
  // A candidate with no output drops out, and the judge scores the rest (upstream arena, Phase B).
  const dropouts = projected.flatMap((entry, i) => (entry ? [] : [`candidate-${i + 1}`]));
  const candidates = projected.filter((entry) => entry !== null);
  if (!candidates.length) return { status: "INCONCLUSIVE: every candidate dropped out", dropouts };
  const files = candidates.map((c) => c.path);
  const worktrees = candidates.map((c) => c.label).join("; ");
  const assessment = await run({
    task: `Judge these ${files.length} anonymous candidate message transcripts: ${files.join(", ")}. Read every file in full, including tool results; rubric: ${rubric}. Score each candidate on each rubric criterion from actual evidence, recommend a base, and note missing artifacts or unverifiable claims. For write candidates, inspect candidate worktrees if necessary: ${worktrees}. Do not infer provider identity.`,
    model: judge,
    index: outputs.length,
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
    dropouts,
    status: readAudit.every((entry) => entry.read)
      ? "reviewed"
      : "INCONCLUSIVE: judge did not read every projected transcript",
  };
}

const judgeOrInconclusive = (...args: Parameters<typeof judgeArena>) =>
  judgeArena(...args).catch((error: unknown) => ({
    status: "INCONCLUSIVE: could not complete arena judgment",
    model: args[3],
    error: errorMessage(error),
  }));

function assertReachable(available: ReadonlySet<string>, models: string[]) {
  const unreachable = [...new Set(models)].filter((model) => !available.has(model));
  if (unreachable.length)
    fail(
      `Workers load no extension except the one that provides their model. Unavailable in the current worker scope: ${unreachable.join(", ")}. Choose an available model in /setup-pstack.`,
    );
}

async function prepareBatch(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  p: DelegateParams,
  signal: AbortSignal | undefined,
  progress: (message: string) => void,
) {
  if (!ctx.model) fail("Select a parent model first");
  if (p.background && p.mode !== "single" && p.mode !== "swarm")
    fail("Background workers take mode single or swarm");
  const extensions = await workerExtensions(pi, ctx, signal);
  const listed = availableWorkerModels(ctx, extensions);
  const config = await readConfig(listed);
  const resolved = resolveWorkers(p, config, modelName(ctx.model), new Set(listed));
  const dir = join(artifacts(ctx), "workers", randomUUID());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const options: RunnerOptions = {
    dir,
    signal,
    diff: await saveParentDiff(pi, ctx.cwd, dir, signal),
    budget: config.budget,
    extensions,
    base: p.base,
    // Arena candidates see only the task; the rubric is the judge's (upstream arena, Phase A).
    rubric: p.mode === "arena" ? undefined : p.rubric,
    progress,
  };
  const { role, modelRole, readOnly, shell, thinking } = resolved;
  const requests = resolved.workers.map(({ task, model }, index) => {
    const id = workerId(index);
    return { task, index, model, readOnly, shell, role, modelRole, thinking, id };
  });
  return { dir, options, requests, judge: resolved.judge };
}

async function delegate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workers: { active: ActiveWorktrees; background: BackgroundWorkers },
  p: DelegateParams,
  signal: AbortSignal | undefined,
  progress: (message: string) => void,
) {
  const { dir, options, requests, judge } = await prepareBatch(pi, ctx, p, signal, progress);
  if (p.background) {
    const jobs = requests.map((request) => ({
      id: request.id,
      run: (stop: AbortSignal) =>
        createRunner(pi, ctx, workers.active, {
          ...options,
          signal: stop,
          timeoutMs: backgroundTimeoutMs,
        })(request),
    }));
    const started = workers.background.start(dir, jobs);
    const ids = started.map(({ id }) => ({ id, sessionDir: join(dir, id) }));
    return { background: ids, dir, next: "Check them with pstack_workers action list." };
  }
  const run = createRunner(pi, ctx, workers.active, options);
  const outputs = await pool(requests, p.concurrency ?? 3, run);
  const judgment =
    p.mode === "arena"
      ? judge
        ? await judgeOrInconclusive(dir, outputs, p.rubric, judge, run)
        : { status: "skipped: no available judge from a vendor other than the parent's" }
      : undefined;
  return {
    outputs,
    judgment,
    dir,
    warning:
      "Local workers only. Review actual artifacts and rerun acceptance checks; report text is not proof.",
  };
}

export function registerDelegation(
  pi: ExtensionAPI,
  active: ActiveWorktrees,
  background: BackgroundWorkers,
) {
  pi.registerTool({
    name: "pstack_delegate",
    label: "Pstack Pi workers",
    description:
      "Run independent native Pi CLI sessions: single, swarm, arena or interrogate. Read-only by default; write workers use detached worktrees. Child sessions and reports are retained.",
    parameters,
    async execute(_id, p, signal, onUpdate, ctx) {
      const progress = (message: string) => onUpdate?.(result(message));
      const { resume } = p;
      return result(
        resume === undefined
          ? await delegate(pi, ctx, { active, background }, p, signal, progress)
          : await resumeWorker(pi, ctx, active, { ...p, resume }, { signal, progress }),
      );
    },
  });
}
