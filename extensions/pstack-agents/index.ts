import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createAgentParseWarningReporter, loadTaskContext, parseTaskInput, piToolSourcePaths, resolveResumeExecution } from "./agents.ts";
import { parseRunId, type RunId, type RunStatus } from "./contracts.ts";
import {
  GOAL_ENTRY_TYPE,
  GOAL_NOTICE_TYPE,
  MAX_IDLE_CONTINUATIONS,
  createGoal,
  goalStateFromBranch,
  nextGoalContinuation,
  updateGoal,
  type GoalState,
} from "./goals.ts";
import {
  NOTIFICATION_TYPE,
  createRunStore,
  completedRunAttempts,
  deliveredNotificationIds,
  launchEntriesFromBranch,
  MAX_SHELL_TIMEOUT_MS,
  parseShellInput,
  recordLaunch,
  runDirectoryForSession,
  type AwaitResult,
  type LaunchEntry,
  type RunNotification,
  type RunReceipt,
  type RunStore,
  type AgentRunRequest,
} from "./runs.ts";
import { createWorktree } from "./worktrees.ts";
import { compileSafeRegex } from "./regex-safety.js";

const MAX_WAIT_MS = 2_147_483_647;
const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));

const TaskParameters = Type.Union([
  Type.Object({
    description: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    subagent_type: Type.String({ minLength: 1 }),
    model: Type.Optional(Type.String()),
    resume: Type.Optional(Type.String()),
    readonly: Type.Optional(Type.Boolean()),
    run_in_background: Type.Optional(Type.Boolean()),
    attachments: Type.Optional(Type.Array(Type.String())),
    environment: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("cloud")])),
    cloud_base_branch: Type.Optional(Type.String()),
    machine: Type.Optional(Type.Unknown()),
    cloud_requested_environment_build_id: Type.Optional(Type.Unknown()),
    interrupt: Type.Optional(Type.Literal(false)),
    output: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({ resume: Type.String({ minLength: 1 }), interrupt: Type.Literal(true) }, { additionalProperties: false }),
]);

type TaskParameters = Static<typeof TaskParameters>;

const ShellParameters = Type.Object({
  command: Type.String({ minLength: 1 }),
  working_directory: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SHELL_TIMEOUT_MS })),
  is_background: Type.Optional(Type.Boolean()),
  output_notification: Type.Optional(Type.String({ maxLength: 1024 })),
  hard_timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SHELL_TIMEOUT_MS })),
}, { additionalProperties: false });

type ShellParameters = Static<typeof ShellParameters>;

const SubagentAwaitParameters = Type.Object({
  agent_id: Type.String({ minLength: 1 }),
  timeout_ms: Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS }),
}, { additionalProperties: false });

type SubagentAwaitParameters = Static<typeof SubagentAwaitParameters>;

const AwaitParameters = Type.Union([
  Type.Object({
    task_id: Type.String({ minLength: 1 }),
    block_until_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })),
    regex: Type.Optional(Type.String({ maxLength: 1024 })),
  }, { additionalProperties: false }),
  Type.Object({
    agent_id: Type.String({ minLength: 1 }),
    block_until_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS })),
    regex: Type.Optional(Type.String({ maxLength: 1024 })),
  }, { additionalProperties: false }),
]);

type AwaitParameters = Static<typeof AwaitParameters>;

const CreateGoalParameters = Type.Object({ objective: Type.String({ minLength: 1 }) }, { additionalProperties: false });
type CreateGoalParameters = Static<typeof CreateGoalParameters>;

const UpdateGoalParameters = Type.Object({
  status: Type.Union([Type.Literal("ACTIVE"), Type.Literal("PAUSED"), Type.Literal("COMPLETE"), Type.Literal("CLEARED")]),
}, { additionalProperties: false });
type UpdateGoalParameters = Static<typeof UpdateGoalParameters>;

let runStore: RunStore | undefined;
const reportAgentParseWarning = createAgentParseWarningReporter();

function getRunStore(): RunStore {
  if (!runStore) throw new Error("pstack-agents run store is not initialized");
  return runStore;
}

function parentModel(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function isHeadless(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return !ctx.hasUI || ctx.mode === "json" || ctx.mode === "print";
}

function runtimeDepth(): number {
  const value = process.env.PSTACK_AGENTS_DEPTH;
  if (value === undefined || value === "") return 0;
  const depth = Number(value);
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("PSTACK_AGENTS_DEPTH must be a non-negative integer");
  return depth;
}

function runtimeNestingAllowed(depth: number): boolean {
  return depth === 0 || process.env.PSTACK_AGENTS_NESTING_ALLOWED === "true";
}

type ParentSessionStorage = { sessionDir: string; sessionFile: string };

function parentSessionStorage(ctx: ExtensionContext): ParentSessionStorage {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) return { sessionDir: ctx.sessionManager.getSessionDir(), sessionFile };
  const sessionDir = path.join(os.tmpdir(), "pstack-agents", String(process.pid));
  return { sessionDir, sessionFile: path.join(sessionDir, "parent.jsonl") };
}

function createRunStoreForContext(ctx: ExtensionContext): RunStore {
  const invocation = resolvePiInvocation();
  return createRunStore({
    ...parentSessionStorage(ctx),
    sessionId: ctx.sessionManager.getSessionId(),
    runnerPath,
    piCommand: invocation.command,
    piArgsPrefix: invocation.argsPrefix,
    cwd: ctx.cwd,
  });
}

function resolvePiInvocation(): { command: string; argsPrefix: string[] } {
  const cliScript = process.argv[1];
  if (cliScript && path.isAbsolute(cliScript) && fs.existsSync(cliScript)) {
    return { command: process.execPath, argsPrefix: [cliScript] };
  }
  return { command: "pi", argsPrefix: [] };
}

function toolResult(text: string, details: unknown, usage?: Usage) {
  return { content: [{ type: "text" as const, text }], details, ...(usage === undefined ? {} : { usage }) };
}

function isTerminal(status: RunStatus): boolean {
  return status.state === "completed" || status.state === "failed" || status.state === "stopped";
}

function throwIfFailedStatus(status: RunStatus, label: "Task" | "Shell" | "Run"): void {
  if (status.state === "failed") throw new Error(status.error ?? `${label} ${status.id} failed (${status.stopReason})`);
}

function describeStatus(status: RunStatus): string {
  switch (status.state) {
    case "starting": return "starting";
    case "running": return `running (pid ${status.pid})`;
    case "completed": return `completed (exit ${status.exitCode})`;
    case "failed": return `failed (${status.stopReason}${status.error ? `: ${status.error}` : ""})`;
    case "stopped": return `stopped${status.signal ? ` (${status.signal})` : ""}`;
  }
}

function boundedTaskOutput(output: string, transcript: string): string {
  const truncated = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  return truncated.truncated
    ? `${truncated.content}\n\n[Output truncated. Full transcript: ${transcript}]`
    : truncated.content;
}

function boundedShellOutput(output: string, outputLog: string): string {
  const truncated = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  return truncated.truncated
    ? `${truncated.content}\n\n[Output truncated. Full log: ${outputLog}]`
    : truncated.content;
}

function shellResultText(id: RunId, status: RunStatus, store: RunStore): string {
  const output = store.outputText(id);
  const outputLog = store.outputLog(id);
  const heading = `Shell ${describeStatus(status)}. Output log: ${outputLog}`;
  const excerpt = boundedShellOutput(output, outputLog);
  return excerpt ? `${heading}\n\n${excerpt}` : heading;
}

function taskReceiptText(receipt: RunReceipt): string {
  if (receipt.kind === "agent") {
    const worktree = receipt.worktree ? `\nWorktree: ${receipt.worktree.path} (branch ${receipt.worktree.branch})` : "";
    const output = receipt.outputReference ? `\nOutput reference: ${receipt.outputReference}` : "";
    return `Task started. agent_id: ${receipt.agent_id}\nStatus: ${receipt.status}\nTranscript: ${receipt.transcript}${output}${worktree}`;
  }
  return `Shell started. task_id: ${receipt.task_id}\nStatus: ${receipt.status}\nOutput log: ${receipt.outputLog}`;
}

function notifyRun(pi: ExtensionAPI, notification: RunNotification, ctx: ExtensionContext): void {
  const heading = notification.event === "running"
    ? `${notification.kind === "agent" ? "Task" : "Shell"} ${notification.id} is still running.`
    : notification.event === "output"
      ? `Shell ${notification.id} matched output line ${notification.line?.sequence ?? "?"}: ${notification.line?.line ?? ""}`
      : `${notification.kind === "agent" ? "Task" : "Shell"} ${notification.id} ${describeStatus(notification.status)}.`;
  const references = [
    notification.transcript ? `Transcript: ${notification.transcript}` : undefined,
    notification.outputLog ? `Output log: ${notification.outputLog}` : undefined,
    notification.event === "completed" && notification.text
      ? notification.kind === "agent" && notification.transcript
        ? boundedTaskOutput(notification.text, notification.transcript)
        : notification.text
      : undefined,
  ].filter((value): value is string => value !== undefined);
  pi.sendMessage({
    customType: NOTIFICATION_TYPE,
    content: [heading, ...references].join("\n\n"),
    display: true,
    details: {
      notificationId: notification.notificationId,
      runId: notification.id,
      attempt: notification.attempt,
      event: notification.event,
      status: notification.status,
      sequence: notification.line?.sequence,
    },
  }, { triggerTurn: true, ...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }) });
}

function latestRuns(branch: readonly SessionEntry[]) {
  const byId = new Map<RunId, ReturnType<typeof launchEntriesFromBranch>[number]>();
  for (const launch of launchEntriesFromBranch(branch)) {
    const current = byId.get(launch.id);
    if (!current || current.attempt < launch.attempt) byId.set(launch.id, launch);
  }
  return [...byId.values()];
}

export async function closeRunStore(
  store: Pick<RunStore, "status" | "interrupt" | "closeWatchers">,
  branch: readonly SessionEntry[],
): Promise<void> {
  const errors: unknown[] = [];
  try {
    for (const launch of latestRuns(branch)) {
      if (launch.runInBackground) continue;
      try {
        const status = await store.status(launch.id);
        if (!isTerminal(status)) await store.interrupt(launch.id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      const messages = errors.map((error) => error instanceof Error ? error.message : String(error));
      throw new AggregateError(errors, `Failed to stop foreground pstack-agents runs: ${messages.join("; ")}`);
    }
  } finally {
    store.closeWatchers();
  }
}

async function refreshStatus(ctx: ExtensionContext, store: RunStore): Promise<void> {
  try {
    if (runStore !== store) return;
    const branch = ctx.sessionManager.getBranch();
    const runs = latestRuns(branch);
    const statuses = await Promise.all(runs.map(async (launch) => ({ launch, status: await store.status(launch.id) })));
    if (runStore !== store) return;
    const agents = statuses.filter(({ launch, status }) => launch.requestKind === "agent" && !isTerminal(status)).length;
    const shells = statuses.filter(({ launch, status }) => launch.requestKind === "shell" && !isTerminal(status)).length;
    const goal = goalStateFromBranch(branch);
    const parts = [
      agents ? `Agents ${agents} running` : undefined,
      shells ? `Shells ${shells} running` : undefined,
      goal.state === "ACTIVE" ? "Goal active" : goal.state === "PAUSED" ? "Goal paused" : undefined,
    ].filter((value): value is string => value !== undefined);
    ctx.ui.setStatus("pstack-agents", parts.length ? parts.join(" · ") : undefined);
  } catch (error) {
    if (runStore === store) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

async function hasPendingBackgroundRun(branch: readonly SessionEntry[], store: RunStore): Promise<boolean> {
  const delivered = deliveredNotificationIds(branch);
  const completed = completedRunAttempts(branch);
  for (const launch of latestRuns(branch)) {
    if (!launch.runInBackground) continue;
    const status = await store.status(launch.id);
    if (!isTerminal(status) || (!delivered.has(`${launch.id}:${launch.attempt}:completed`) && !completed.has(`${launch.id}:${launch.attempt}`))) return true;
  }
  return false;
}

function sendGoalNotice(pi: ExtensionAPI, notificationId: string, content: string, ctx: ExtensionContext, triggerTurn: boolean): void {
  pi.sendMessage({
    customType: GOAL_NOTICE_TYPE,
    content,
    display: true,
    details: { notificationId },
  }, { triggerTurn, ...(triggerTurn && !ctx.isIdle() ? { deliverAs: "followUp" as const } : {}) });
}

function updateGoalStatusLine(branch: readonly SessionEntry[], ctx: ExtensionContext): void {
  const goal = goalStateFromBranch(branch);
  if (goal.state === "ACTIVE" || goal.state === "PAUSED") {
    ctx.ui.setStatus("pstack-agents-goal", `Goal ${goal.state.toLowerCase()}: ${goal.objective}`);
  } else {
    ctx.ui.setStatus("pstack-agents-goal", undefined);
  }
}

type LaunchResultInput = Pick<LaunchEntry, "id" | "runInBackground">;

function launchReceiptResult(entry: LaunchResultInput, receipt: RunReceipt) {
  return toolResult(taskReceiptText(receipt), { ...receipt, runId: entry.id, completed: false });
}

function launchCompletedResult(id: RunId, status: RunStatus, receipt: RunReceipt, store: RunStore) {
  throwIfFailedStatus(status, receipt.kind === "agent" ? "Task" : "Shell");
  const text = receipt.kind === "agent"
    ? taskCompletionResultText(id, status, receipt, store)
    : shellResultText(id, status, store);
  const usage = receipt.kind === "agent" && isTerminal(status) ? store.claimUsage(id, status.attempt) : undefined;
  return toolResult(text, { ...receipt, runId: id, status, attempt: status.attempt, completed: isTerminal(status) }, usage);
}

async function waitForLaunch(
  entry: LaunchResultInput,
  receipt: RunReceipt,
  store: RunStore,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  if (entry.runInBackground && ctx.hasUI) {
    throwIfFailedStatus(await store.status(entry.id), receipt.kind === "agent" ? "Task" : "Shell");
    return launchReceiptResult(entry, receipt);
  }
  const result = await store.wait(entry.id, undefined, undefined, signal);
  return result.state === "terminal"
    ? launchCompletedResult(entry.id, result.status, receipt, store)
    : launchReceiptResult(entry, receipt);
}

async function launchAndWait(
  entry: LaunchEntry,
  pi: ExtensionAPI,
  store: RunStore,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  start: () => Promise<RunReceipt>,
) {
  store.prepare(entry);
  recordLaunch(pi, entry);
  return waitForLaunch(entry, await start(), store, ctx, signal);
}

async function executeTask(
  pi: ExtensionAPI,
  params: TaskParameters,
  toolCallId: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ReturnType<typeof toolResult>> {
  const store = getRunStore();
  const depth = runtimeDepth();
  const activeTools = pi.getActiveTools();
  const allTools = piToolSourcePaths(pi.getAllTools());
  const context = loadTaskContext({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    parentModel: parentModel(ctx),
    thinkingLevel: ctx.thinkingLevel,
    depth,
    nestingAllowed: runtimeNestingAllowed(depth),
    activeTools,
    allTools,
    onAgentParseWarning: (filePath, reason) => reportAgentParseWarning(
      ctx.sessionManager.getSessionId(),
      filePath,
      reason,
      (message) => ctx.ui.notify(message, "warning"),
    ),
  });
  const command = parseTaskInput(params, context);
  if (command.action === "interrupt") {
    await store.interrupt(command.id);
    const status = await store.status(command.id);
    throwIfFailedStatus(status, "Task");
    const usage = isTerminal(status) ? store.claimUsage(command.id, status.attempt) : undefined;
    return toolResult(`Interrupt requested for ${command.id}. Current status: ${describeStatus(status)}.`, { runId: command.id, status, completed: isTerminal(status) }, usage);
  }

  const storage = parentSessionStorage(ctx);
  const owner = {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: storage.sessionFile,
    branchLeafAtLaunch: ctx.sessionManager.getLeafId(),
    toolCallId,
    depth,
  };
  const requestKey = store.requestKey(owner);
  const branch = ctx.sessionManager.getBranch();
  const prior = store.findLaunchByRequestKey(branch, requestKey);
  if (prior) {
    const receipt = await store.ensure(prior.id);
    return waitForLaunch(prior, receipt, store, ctx, signal);
  }

  const id = command.action === "resume" ? command.id : store.idForRequestKey(requestKey);
  const previous = command.action === "resume" ? store.latestLaunch(branch, id) : undefined;
  let environment: "local" | "cloud";
  let cloudBaseBranch: string | undefined;
  if (command.action === "resume") {
    if (!previous || previous.requestKind !== "agent") throw new Error(`Unknown agent_id for resume: ${id}`);
    if (previous.agentName && previous.agentName !== command.request.agent.name) throw new Error(`Task ${id} belongs to agent ${previous.agentName}, not ${command.request.agent.name}`);
    const resumedExecution = resolveResumeExecution({
      id,
      previous,
      requested: { environment: command.environment, cloudBaseBranch: command.cloudBaseBranch },
    });
    environment = resumedExecution.environment;
    cloudBaseBranch = resumedExecution.cloudBaseBranch;
    if (environment === "cloud" && !previous.worktreeBaseCommit) throw new Error(`Task ${id} has no recorded worktree base and cannot be resumed safely`);
  } else {
    environment = command.environment;
    cloudBaseBranch = command.cloudBaseBranch;
  }

  let request: AgentRunRequest = { ...command.request, environment };
  if (environment === "cloud") {
    if (!cloudBaseBranch) throw new Error("environment cloud requires cloud_base_branch");
    const worktree = await createWorktree({
      repository: ctx.cwd,
      baseRef: cloudBaseBranch,
      runId: id,
      runDirectory: runDirectoryForSession(storage.sessionDir, id),
      expectedBaseCommit: previous?.worktreeBaseCommit,
    });
    request = { ...request, cloudBaseBranch, worktree };
  }

  const entry: LaunchEntry = {
    kind: "launch",
    id,
    attempt: previous ? previous.attempt + 1 : 1,
    requestKey,
    owner,
    request,
    runInBackground: command.runInBackground,
    createdAt: Date.now(),
  };
  return launchAndWait(entry, pi, store, ctx, signal, () => command.action === "resume" ? store.resume(entry) : store.start(entry));
}

function taskResultTextFromStore(id: RunId, status: RunStatus, receipt: Extract<RunReceipt, { kind: "agent" }>, store: RunStore): string {
  const output = store.finalOutput(id);
  const heading = `Task ${describeStatus(status)}. Transcript: ${receipt.transcript}`;
  const excerpt = boundedTaskOutput(output, receipt.transcript);
  return excerpt ? `${heading}\n\n${excerpt}` : heading;
}

async function executeShell(
  pi: ExtensionAPI,
  params: ShellParameters,
  toolCallId: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<ReturnType<typeof toolResult>> {
  const store = getRunStore();
  const parsed = parseShellInput(params, ctx.cwd);
  if (isHeadless(ctx) && parsed.runInBackground && parsed.request.outputNotification !== undefined) {
    throw new Error("Headless run: nothing can receive output notifications, so a background Shell wake cannot be armed here. Run a bounded foreground command, or run this from an interactive Pi session.");
  }
  if (isHeadless(ctx) && parsed.runInBackground && parsed.request.timeout === undefined && parsed.request.hardTimeout === undefined) {
    throw new Error("Headless run: an unbounded background Shell cannot be left running after the parent exits. Set timeout or hard_timeout, run a foreground command, or run this from an interactive Pi session.");
  }
  const owner = {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: parentSessionStorage(ctx).sessionFile,
    branchLeafAtLaunch: ctx.sessionManager.getLeafId(),
    toolCallId,
    depth: runtimeDepth(),
  };
  const requestKey = store.requestKey(owner);
  const branch = ctx.sessionManager.getBranch();
  const prior = store.findLaunchByRequestKey(branch, requestKey);
  if (prior) {
    const receipt = await store.ensure(prior.id);
    return waitForLaunch(prior, receipt, store, ctx, signal);
  }

  const entry: LaunchEntry = {
    kind: "launch",
    id: store.idForRequestKey(requestKey),
    attempt: 1,
    requestKey,
    owner,
    request: parsed.request,
    runInBackground: parsed.runInBackground,
    createdAt: Date.now(),
  };
  return launchAndWait(entry, pi, store, ctx, signal, () => store.start(entry));
}

function taskCompletionResultText(
  id: RunId,
  status: RunStatus,
  receipt: Extract<RunReceipt, { kind: "agent" }>,
  store: RunStore,
): string {
  const worktree = receipt.worktree ? `\nWorktree: ${receipt.worktree.path} (branch ${receipt.worktree.branch})` : "";
  if (receipt.outputReference) return `Task ${describeStatus(status)}. Output reference: ${receipt.outputReference}\nTranscript: ${receipt.transcript}${worktree}`;
  return `${taskResultTextFromStore(id, status, receipt, store)}${worktree}`;
}

function latestStatusText(result: AwaitResult): string {
  if (result.state === "matched") return `Matched output line ${result.sequence}: ${result.line}`;
  if (result.state === "timeout") return `Wait timed out. Current status: ${describeStatus(result.status)}.`;
  if (result.state === "detached") return `Wait detached. Run remains ${describeStatus(result.status)}.`;
  return describeStatus(result.status);
}

async function executeAwait(params: AwaitParameters | SubagentAwaitParameters, signal: AbortSignal | undefined): Promise<ReturnType<typeof toolResult>> {
  const subagentAwait = "timeout_ms" in params;
  const isAgent = "agent_id" in params;
  const rawId = isAgent ? params.agent_id : params.task_id;
  const id = parseRunId(rawId);
  if (!id) throw new Error(`Await requires a valid ${isAgent ? "agent_id" : "task_id"}`);
  const pattern = "regex" in params ? params.regex : undefined;
  if (isAgent && pattern !== undefined) throw new Error("Await regex is supported only for Shell tasks");
  const regex = pattern === undefined ? undefined : compileSafeRegex(pattern, "Await regex");
  const timeout = subagentAwait ? params.timeout_ms : params.block_until_ms;
  const store = getRunStore();
  const result = await store.wait(id, timeout, regex, signal, true);
  const status = result.status;
  throwIfFailedStatus(status, isAgent ? "Task" : "Shell");
  const completed = isTerminal(status);
  const transcript = isAgent ? store.transcript(id) : undefined;
  const outputLog = isAgent ? undefined : store.outputLog(id);
  const text = subagentAwait
    ? `Task ${id}: ${latestStatusText(result)}. Transcript: ${store.transcript(id)}`
    : `${isAgent ? "Task" : "Shell"} ${id}: ${latestStatusText(result)}${transcript ? `. Transcript: ${transcript}` : `. Output log: ${outputLog}`}`;
  const details = subagentAwait
    ? { agent_id: id, runId: id, status, transcript: store.transcript(id), completed }
    : {
        runId: id,
        status,
        completed,
        state: result.state,
        sequence: result.state === "matched" ? result.sequence : undefined,
        line: result.state === "matched" ? result.line : undefined,
        transcript,
        outputLog,
      };
  const usage = isTerminal(status) ? store.claimUsage(id, status.attempt) : undefined;
  return toolResult(text, details, usage);
}

function goalDisplay(goal: GoalState): string {
  if (goal.state === "none") return "No current goal.";
  return `${goal.state} goal ${goal.id}: ${goal.objective}\nConsecutive continuations without tool progress: ${goal.consecutiveContinuations}/${MAX_IDLE_CONTINUATIONS}.`;
}

export default function registerPstackAgents(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "Task",
    label: "Task",
    description: "Launch, resume, or interrupt an agent task. Tasks run in the foreground unless run_in_background is true.",
    promptSnippet: "Run or manage an agent task.",
    parameters: TaskParameters,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return executeTask(pi, params, toolCallId, signal, ctx);
    },
  });

  pi.registerTool({
    name: "SubagentAwait",
    label: "SubagentAwait",
    description: "Wait for an agent task to finish or for timeout_ms to expire. A wait timeout does not stop the task.",
    parameters: SubagentAwaitParameters,
    async execute(_toolCallId, params, signal) {
      return executeAwait(params, signal);
    },
  });

  pi.registerTool({
    name: "Shell",
    label: "Shell",
    description: "Run a shell command. Set is_background and output_notification to receive a notice on matching output and another on exit.",
    parameters: ShellParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return executeShell(pi, params, toolCallId, signal, ctx);
    },
  });

  pi.registerTool({
    name: "Await",
    label: "Await",
    description: "Wait for a task, an agent, or a matching Shell output line. A wait timeout does not stop the run.",
    parameters: AwaitParameters,
    async execute(_toolCallId, params, signal) {
      return executeAwait(params, signal);
    },
  });

  pi.registerTool({
    name: "CreateGoal",
    label: "CreateGoal",
    description: "Create the current branch goal from an objective.",
    parameters: CreateGoalParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (isHeadless(ctx)) throw new Error("CreateGoal requires an interactive TUI or RPC session.");
      const state = createGoal(pi, ctx.sessionManager.getBranch(), params.objective);
      updateGoalStatusLine(ctx.sessionManager.getBranch(), ctx);
      void refreshStatus(ctx, getRunStore());
      return toolResult(`Created ${goalDisplay(state)}`, state);
    },
  });

  pi.registerTool({
    name: "UpdateGoal",
    label: "UpdateGoal",
    description: "Change the current branch goal status to ACTIVE, PAUSED, COMPLETE, or CLEARED.",
    parameters: UpdateGoalParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = updateGoal(pi, ctx.sessionManager.getBranch(), params.status);
      updateGoalStatusLine(ctx.sessionManager.getBranch(), ctx);
      void refreshStatus(ctx, getRunStore());
      return toolResult(`Updated ${goalDisplay(state)}`, state);
    },
  });

  pi.registerCommand("goal", {
    description: "Show the current branch goal.",
    async handler(_args, ctx) {
      ctx.ui.notify(goalDisplay(goalStateFromBranch(ctx.sessionManager.getBranch())), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const previousStore = runStore;
    runStore = undefined;
    // session_shutdown already stopped the old session's foreground runs; this ctx belongs to the new session.
    previousStore?.closeWatchers();
    const store = createRunStoreForContext(ctx);
    runStore = store;
    store.observe({
      branch: () => ctx.sessionManager.getBranch(),
      notificationsEnabled: ctx.mode === "tui" || ctx.mode === "rpc",
      notify: (notification) => {
        if (runStore === store) notifyRun(pi, notification, ctx);
      },
      onChange: () => { void refreshStatus(ctx, store); },
      onError: (error) => {
        if (runStore === store) ctx.ui.notify(error.message, "error");
      },
    });
    await refreshStatus(ctx, store);
    if (runStore !== store) return;
    const branch = ctx.sessionManager.getBranch();
    updateGoalStatusLine(branch, ctx);
    if (isHeadless(ctx) || await hasPendingBackgroundRun(branch, store)) return;
    if (runStore !== store) return;
    const continuation = nextGoalContinuation(goalStateFromBranch(branch), branch);
    if (continuation.kind === "none") return;
    pi.appendEntry(GOAL_ENTRY_TYPE, continuation.event);
    sendGoalNotice(pi, continuation.notificationId, continuation.content, ctx, continuation.kind === "continue");
  });

  pi.on("agent_before_settle", async (_event, ctx) => {
    if (isHeadless(ctx)) return;
    const store = runStore;
    if (!store) return;
    const branch = ctx.sessionManager.getBranch();
    if (await hasPendingBackgroundRun(branch, store)) return;
    if (runStore !== store) return;
    const continuation = nextGoalContinuation(goalStateFromBranch(branch), branch);
    if (continuation.kind === "none") return;
    const entries = [
      { type: "custom" as const, customType: GOAL_ENTRY_TYPE, data: continuation.event },
      {
        type: "custom_message" as const,
        customType: GOAL_NOTICE_TYPE,
        content: continuation.content,
        display: true,
        details: { notificationId: continuation.notificationId },
      },
    ];
    return { entries, continue: continuation.kind === "continue" };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const store = runStore;
    runStore = undefined;
    if (!store) return;
    try {
      await closeRunStore(store, ctx.sessionManager.getBranch());
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
