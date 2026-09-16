/**
 * pstack_run — the /loop controller tool. It owns the durable RunRecord and
 * delegates all phase logic to the pure reducer. The heartbeat extension stays
 * the only timer owner: arm/stop go through armProgrammaticLoop and
 * stopProgrammaticLoop.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { armProgrammaticLoop, stopProgrammaticLoop } from "../heartbeat/index.ts";
import { isLoopMode, validateWatcherArgv, type LoopMode } from "../heartbeat/state.ts";
import {
  initialRecord,
  isTerminalPhase,
  reduceRun,
  type IgnoredEvent,
  type RunEffect,
  type RunEvent,
  type RunPhase,
  type RunRecord,
  type RunReduction,
} from "./fsm.ts";
import { latestRun, listRuns, loadRun, runPath, saveRun } from "./run-store.ts";
import { createArmedRunsCell } from "./armed-runs.ts";

const MANDATED_ACTIONS = [
  "arm",
  "state",
  "iterate",
  "verify",
  "discard",
  "inconclusive",
  "checkpoint",
  "blocked",
  "handoff",
  "stop",
  "list",
] as const;

interface RunToolParams {
  action: string;
  runId?: string;
  predicate?: string;
  intervalSeconds?: number;
  maxFires?: number;
  plateauLimit?: number;
  mode?: string;
  watchArgv?: string[];
  step?: string;
  evidence?: string;
  verification?: string;
  commit?: string;
  reason?: string;
  endpoint?: string;
  predicateMet?: boolean;
  remoteRequired?: boolean;
}

type ActionHandler = (
  pi: ExtensionAPI,
  params: RunToolParams,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>>;

type EventsFor = (record: RunRecord) => RunEvent[];

function requireRunId(params: RunToolParams): string {
  const runId = params.runId?.trim();
  if (!runId) throw new Error("runId required for this action");
  return runId;
}

function requirePredicate(params: RunToolParams): string {
  const predicate = params.predicate?.trim();
  if (!predicate) throw new Error("predicate required to arm a run");
  return predicate;
}

function requireInterval(params: RunToolParams): number {
  const seconds = params.intervalSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    throw new Error("intervalSeconds required to arm a run");
  }
  return Math.max(5, seconds);
}

function requireEvidence(params: RunToolParams): string {
  const evidence = params.evidence?.trim();
  if (!evidence) throw new Error("evidence required to verify an iteration");
  return evidence;
}

/**
 * runPath applies the exact check saveRun applies, so a rejected id is caught
 * before any side effect instead of by the store write afterwards.
 */
function requireStorableRunId(runId: string): string {
  runPath(runId);
  return runId;
}

function armPrompt(record: RunRecord): string {
  return [
    `[pstack_run ${record.runId}] predicate: ${record.predicate}`,
    `phase: ${record.phase}`,
    "Take the smallest evidence-justified action, then report back with pstack_run action=iterate and action=verify carrying evidence.",
    "Never claim the predicate is met without a predicate_met evidence string.",
  ].join("\n");
}

function wakePrompt(record: RunRecord, reason: string): string {
  return `[pstack_run ${record.runId} wake: ${reason}] predicate: ${record.predicate} | phase: ${record.phase}`;
}

function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function describeRun(record: RunRecord): string {
  return [
    `${record.runId} phase=${record.phase} iterations=${record.iterations.length}`,
    `discards=${record.consecutiveDiscards} fires=${record.fires}/${record.maxFires}`,
    `predicate=${record.predicate}`,
  ].join(" ");
}

function formatRun(record: RunRecord, effects: RunEffect[], ignored: readonly IgnoredEvent[]): string {
  const notes = effects.filter((effect) => effect.type === "notify").map((effect) => effect.message);
  const lines = [
    describeRun(record),
    ...(record.blockedReason ? [`blockedReason: ${record.blockedReason}`] : []),
    ...notes,
    ...ignoredLines(ignored),
  ];
  return lines.join("\n");
}

function ignoredLines(ignored: readonly IgnoredEvent[]): string[] {
  const groups = ignored.reduce<Array<{ phase: RunPhase; events: string[] }>>((acc, entry) => {
    const last = acc.at(-1);
    if (last?.phase === entry.phase) {
      return [...acc.slice(0, -1), { phase: last.phase, events: [...last.events, entry.event] }];
    }
    return [...acc, { phase: entry.phase, events: [entry.event] }];
  }, []);
  return groups.map((group) => `ignored ${group.events.join(", ")} in phase ${group.phase}`);
}

function runResult(
  record: RunRecord,
  effects: RunEffect[],
  ignored: readonly IgnoredEvent[],
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: formatRun(record, effects, ignored) }],
    details: { run: record, effects, ignored },
  };
}

/**
 * The run reducer emits a `wake` effect from its `heartbeat` and `event_wake`
 * transitions, and it is what tells the agent that a run waiting on an event has
 * resumed. Dropping it here would leave the record advanced and the agent
 * unwoken, which is the silent local downgrade the run contract forbids, so the
 * consumer keeps pace with the producer.
 */
function applyEffect(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: RunRecord,
  effect: RunEffect,
): void {
  if (effect.type === "wake") {
    pi.sendUserMessage(wakePrompt(record, effect.reason), { deliverAs: "followUp" });
    return;
  }
  if (effect.type === "notify") {
    ctx.ui.notify(effect.message, "info");
    return;
  }
  if (effect.type === "stop") {
    stopProgrammaticLoop(record.runId);
    return;
  }
  if (effect.type === "handoff") {
    ctx.ui.notify(`run ${record.runId} hosted handoff recorded for ${effect.endpoint}; no local continuation`, "info");
  }
}

interface RunStep {
  record: RunRecord;
  effects: RunEffect[];
  ignored: IgnoredEvent[];
}

function reduceAndSave(params: RunToolParams, eventsFor: EventsFor): RunStep {
  const runId = requireRunId(params);
  const record = loadRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  const now = Date.now();
  const reduced = eventsFor(record).reduce<RunReduction>(
    (acc, event) => {
      const step = reduceRun(acc.record, event, now);
      return {
        record: step.record,
        effects: [...acc.effects, ...step.effects],
        ignored: [...(acc.ignored ?? []), ...(step.ignored ?? [])],
      };
    },
    { record, effects: [], ignored: [] },
  );
  return { record: saveRun(reduced.record), effects: reduced.effects, ignored: reduced.ignored ?? [] };
}

function iterateEvents(params: RunToolParams): RunEvent[] {
  const action = params.step?.trim() || params.reason?.trim() || "iterate";
  return [{ type: "iteration_started", action }];
}

function verifyEvents(record: RunRecord, params: RunToolParams): RunEvent[] {
  const evidence = requireEvidence(params);
  const verification = params.verification?.trim() || "verify";
  const commit = params.commit?.trim();
  const verified: RunEvent = { type: "iteration_verified", verification, evidence, ...(commit ? { commit } : {}) };
  if (params.predicateMet !== true) return [verified];
  const tail: RunEvent[] = record.phase === "CHECK_PREDICATE" ? [] : [{ type: "checkpoint" }, { type: "predicate_checked" }];
  return [verified, ...tail, { type: "predicate_met", evidence }];
}

function discardEvents(params: RunToolParams): RunEvent[] {
  return [{ type: "iteration_discarded", reason: params.reason?.trim() || "no improvement", evidence: params.evidence?.trim() ?? "" }];
}

function inconclusiveEvents(params: RunToolParams): RunEvent[] {
  return [{ type: "iteration_inconclusive", reason: params.reason?.trim() || "no determination", evidence: params.evidence?.trim() ?? "" }];
}

function checkpointEvents(record: RunRecord): RunEvent[] {
  if (record.phase === "COMMIT_IF_ADVANCED_OR_DISCARD") return [{ type: "checkpoint" }];
  if (record.phase === "CHECKPOINT") return [{ type: "predicate_checked" }];
  if (record.phase === "CHECK_PREDICATE") return [{ type: "predicate_unmet" }];
  // The reducer refuses this in any other phase, which is how an out-of-phase
  // checkpoint reports itself instead of reading as a state change.
  return [{ type: "checkpoint" }];
}

function blockedEvents(params: RunToolParams): RunEvent[] {
  const reason = params.reason?.trim();
  if (!reason) throw new Error("reason required to mark a run blocked");
  return [{ type: "mark_blocked", reason }];
}

function handoffEvents(params: RunToolParams): RunEvent[] {
  const endpoint = params.endpoint?.trim();
  if (!endpoint) throw new Error("endpoint required for a hosted handoff");
  return [{ type: "handoff_requested", endpoint }];
}

interface PreparedArm {
  record: RunRecord;
  effects: RunEffect[];
  mode: LoopMode;
  intervalSeconds: number;
}

/**
 * Arm is validate-then-commit: every input is checked here, before the loop
 * store or the run store is touched, so a rejected arm cannot leave a live
 * timer behind. The commit then runs durable record, timer, process registry.
 * A residual failure leaves an inspectable run row, never an invisible loop.
 */
function prepareArm(params: RunToolParams): PreparedArm {
  const runId = requireStorableRunId(params.runId?.trim() || generateRunId());
  const predicate = requirePredicate(params);
  const intervalSeconds = requireInterval(params);
  const watchArgv = params.watchArgv ?? [];
  const mode = params.mode ?? (watchArgv.length ? "dynamic" : "interval");
  if (!isLoopMode(mode)) throw new Error("mode must be interval|settle|watcher|dynamic");
  validateWatcherArgv(mode, watchArgv);
  const now = Date.now();
  const base = initialRecord({
    runId,
    now,
    maxFires: params.maxFires,
    plateauLimit: params.plateauLimit,
    remoteRequired: params.remoteRequired,
  });
  const defined = reduceRun(base, { type: "predicate_defined", predicate }, now);
  return { record: defined.record, effects: defined.effects, mode, intervalSeconds };
}

function armRun(params: RunToolParams): AgentToolResult<unknown> {
  const prepared = prepareArm(params);
  saveRun(prepared.record);
  armProgrammaticLoop({
    id: prepared.record.runId,
    mode: prepared.mode,
    prompt: armPrompt(prepared.record),
    intervalSeconds: prepared.intervalSeconds,
    maxFires: prepared.record.maxFires,
    watchArgv: params.watchArgv,
  });
  armedRunIds.arm(prepared.record.runId);
  return runResult(prepared.record, prepared.effects, []);
}

function stateRun(params: RunToolParams): AgentToolResult<unknown> {
  const runId = params.runId?.trim();
  const record = runId ? loadRun(runId) : latestRun();
  if (!record) throw new Error(runId ? `unknown run ${runId}` : "no runs recorded");
  return runResult(record, [], []);
}

function listRun(): AgentToolResult<unknown> {
  const runs = listRuns();
  const text = runs.length === 0 ? "(no runs)" : runs.map(describeRun).join("\n");
  return { content: [{ type: "text", text }], details: { runs, count: runs.length } };
}

function stopRun(params: RunToolParams): AgentToolResult<unknown> {
  const runId = requireRunId(params);
  const stopped = stopProgrammaticLoop(runId);
  const text = stopped ? `stopped ${runId}` : `no armed loop for ${runId}`;
  return { content: [{ type: "text", text }], details: { runId, stopped } };
}

async function applyEvents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  params: RunToolParams,
  eventsFor: EventsFor,
): Promise<AgentToolResult<unknown>> {
  const reduced = reduceAndSave(params, eventsFor);
  for (const effect of reduced.effects) applyEffect(pi, ctx, reduced.record, effect);
  return runResult(reduced.record, reduced.effects, reduced.ignored);
}

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  arm: (_pi, params) => Promise.resolve(armRun(params)),
  state: (_pi, params) => Promise.resolve(stateRun(params)),
  list: () => Promise.resolve(listRun()),
  iterate: (pi, params, ctx) => applyEvents(pi, ctx, params, () => iterateEvents(params)),
  verify: (pi, params, ctx) => applyEvents(pi, ctx, params, (record) => verifyEvents(record, params)),
  discard: (pi, params, ctx) => applyEvents(pi, ctx, params, () => discardEvents(params)),
  inconclusive: (pi, params, ctx) => applyEvents(pi, ctx, params, () => inconclusiveEvents(params)),
  checkpoint: (pi, params, ctx) => applyEvents(pi, ctx, params, (record) => checkpointEvents(record)),
  blocked: (pi, params, ctx) => applyEvents(pi, ctx, params, () => blockedEvents(params)),
  handoff: (pi, params, ctx) => applyEvents(pi, ctx, params, () => handoffEvents(params)),
  stop: (_pi, params) => Promise.resolve(stopRun(params)),
};

async function executeRunTool(
  pi: ExtensionAPI,
  params: RunToolParams,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const handler = ACTION_HANDLERS[params.action];
  if (!handler) throw new Error(`action must be ${MANDATED_ACTIONS.join("|")}`);
  return handler(pi, params, ctx);
}

function runToolParameters() {
  return Type.Object({
    action: StringEnum(MANDATED_ACTIONS, {
      description: `One of ${MANDATED_ACTIONS.join(" | ")}`,
    }),
    runId: Type.Optional(Type.String({ description: "Run id; defaults to the latest run for state." })),
    predicate: Type.Optional(Type.String({ description: "Checkable finish predicate required by arm." })),
    intervalSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 86400, description: "Heartbeat interval required by arm." })),
    maxFires: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    plateauLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Consecutive non-advancing iterations before BLOCKED." })),
    mode: Type.Optional(
      StringEnum(["interval", "settle", "watcher", "dynamic"] as const, {
        description: "interval | settle | watcher | dynamic (default interval, dynamic when watchArgv is set).",
      }),
    ),
    watchArgv: Type.Optional(Type.Array(Type.String(), { description: "Event watcher argv [command, ...args] (no shell)." })),
    step: Type.Optional(Type.String({ description: "Smallest evidence-justified action for iterate." })),
    evidence: Type.Optional(Type.String({ description: "Evidence string; required by verify." })),
    verification: Type.Optional(Type.String({ description: "How the iteration was verified." })),
    commit: Type.Optional(Type.String({ description: "Commit or artifact ref for an advanced iteration." })),
    reason: Type.Optional(Type.String({ description: "Reason for discard, inconclusive, or blocked." })),
    endpoint: Type.Optional(Type.String({ description: "Hosted worker endpoint for handoff." })),
    predicateMet: Type.Optional(Type.Boolean({ description: "Set true with verify to assert the finish predicate holds; requires evidence." })),
    remoteRequired: Type.Optional(Type.Boolean({ description: "Mark the run as requiring the hosted runtime." })),
  });
}

export const SESSION_SHUTDOWN_BLOCK_REASON =
  "local runtime session ended without completion; hand off to a hosted worker or re-arm";

const armedRunIds = createArmedRunsCell();

/**
 * A local run's timer dies with the session, so a non-terminal record must not
 * keep reading WAIT. Block every run armed in this process and report which ones
 * moved to BLOCKED.
 */
export function blockArmedRunsOnSessionShutdown(reason: string): string[] {
  let blocked: string[] = [];
  for (const runId of armedRunIds.ids()) {
    const record = loadRun(runId);
    if (!record || isTerminalPhase(record.phase)) continue;
    const reduced = reduceRun(record, { type: "mark_blocked", reason }, Date.now());
    saveRun(reduced.record);
    stopProgrammaticLoop(runId);
    blocked = [...blocked, runId];
  }
  armedRunIds.disarmAll();
  return blocked;
}

export function registerLoopController(pi: ExtensionAPI): void {
  pi.on("session_shutdown", () => {
    blockArmedRunsOnSessionShutdown(SESSION_SHUTDOWN_BLOCK_REASON);
  });
  pi.registerTool({
    name: "pstack_run",
    label: "Pstack Run",
    description:
      "Drive the /loop run controller FSM with a durable run record. Actions: arm | state | iterate | verify | discard | inconclusive | checkpoint | blocked | handoff | stop | list. Completion requires an explicit predicate_met with evidence.",
    promptSnippet: "Drive a /loop run through its FSM with a durable record",
    promptGuidelines: [
      "Use pstack_run for autonomous-run and babysit work that needs a checkable finish predicate and a persisted run record.",
      "Only pstack_run verify with evidence counts as progress; three consecutive non-advancing iterations block the run on plateau.",
      "Complete a pstack_run only with verify predicateMet=true plus evidence; checkpoint advances the predicate check, and an unresolved predicate returns the run to WAIT.",
      "A pstack_run continuation the local runtime cannot provide is a hosted handoff, never a silent local downgrade.",
    ],
    parameters: runToolParameters(),
    execute: (id, params, _signal, _onUpdate, ctx) => executeRunTool(pi, params as RunToolParams, ctx),
  });
}
