/**
 * The /loop run controller as a pure reducer. No I/O, no timers: the reducer
 * returns the next record plus declarative effects the caller applies. The
 * heartbeat extension stays the single wake path.
 */
export const RUN_PHASES = [
  "DEFINE_PREDICATE",
  "WAIT_FOR_EVENT_OR_HEARTBEAT",
  "RESUME_OR_START_ITERATION",
  "ACT",
  "VERIFY",
  "COMMIT_IF_ADVANCED_OR_DISCARD",
  "CHECKPOINT",
  "CHECK_PREDICATE",
  "COMPLETE",
  "BLOCKED",
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export type RunVerdict = "advanced" | "discarded" | "inconclusive";

export interface RunIteration {
  n: number;
  startedAt: number;
  endedAt?: number;
  action: string;
  verification: string;
  verdict: RunVerdict;
  evidence: string;
  commit?: string;
}

export interface RunRemote {
  required: boolean;
  handedOff: boolean;
  endpoint?: string;
}

export interface RunRecord {
  runId: string;
  predicate: string;
  phase: RunPhase;
  createdAt: number;
  updatedAt: number;
  iterations: RunIteration[];
  consecutiveDiscards: number;
  fires: number;
  maxFires: number;
  plateauLimit: number;
  remote: RunRemote;
  completedAt?: number;
  blockedReason?: string;
  lastEventId?: string;
  eventIds: string[];
}

export type RunEvent =
  | { type: "predicate_defined"; predicate: string }
  | { type: "heartbeat" }
  | { type: "event_wake"; eventId?: string; reason?: string }
  | { type: "iteration_started"; action: string }
  | { type: "verification_started" }
  | { type: "iteration_verified"; verification: string; evidence: string; commit?: string }
  | { type: "iteration_discarded"; reason: string; evidence: string }
  | { type: "iteration_inconclusive"; reason: string; evidence: string }
  | { type: "checkpoint" }
  | { type: "predicate_checked" }
  | { type: "predicate_met"; evidence: string }
  | { type: "predicate_unmet" }
  | { type: "mark_blocked"; reason: string }
  | { type: "handoff_requested"; endpoint: string }
  | { type: "hosted_unavailable" }
  | { type: "stop" };

export type RunEffect =
  | { type: "wake"; reason: string }
  | { type: "notify"; message: string }
  | { type: "stop" }
  | { type: "handoff"; endpoint: string };

/**
 * An event the phase refused. The record is untouched, so without this marker a
 * caller cannot tell a handled event from a dropped one.
 */
export interface IgnoredEvent {
  event: RunEvent["type"];
  phase: RunPhase;
}

export interface RunReduction {
  record: RunRecord;
  effects: RunEffect[];
  ignored?: IgnoredEvent[];
}

export const DEFAULT_MAX_FIRES = 50;
export const DEFAULT_PLATEAU_LIMIT = 3;

export interface InitialRecordParams {
  runId: string;
  now: number;
  maxFires?: number | undefined;
  plateauLimit?: number | undefined;
  remoteRequired?: boolean | undefined;
  endpoint?: string | undefined;
}

export function initialRecord(params: InitialRecordParams): RunRecord {
  const required = params.remoteRequired === true;
  return {
    runId: params.runId,
    predicate: "",
    phase: "DEFINE_PREDICATE",
    createdAt: params.now,
    updatedAt: params.now,
    iterations: [],
    consecutiveDiscards: 0,
    fires: 0,
    maxFires: params.maxFires ?? DEFAULT_MAX_FIRES,
    plateauLimit: params.plateauLimit ?? DEFAULT_PLATEAU_LIMIT,
    remote: {
      required,
      handedOff: false,
      ...(params.endpoint ? { endpoint: params.endpoint } : {}),
    },
    eventIds: [],
  };
}

export function isRunPhase(value: unknown): value is RunPhase {
  return typeof value === "string" && RUN_PHASES.some((phase) => phase === value);
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return phase === "COMPLETE" || phase === "BLOCKED";
}

function notify(message: string): RunEffect {
  return { type: "notify", message };
}

function progressed(record: RunRecord, now: number, patch: Partial<RunRecord>): RunRecord {
  return { ...record, ...patch, updatedAt: now };
}

type Handler = (record: RunRecord, event: RunEvent, now: number) => RunReduction;

function payload<T extends RunEvent["type"]>(event: RunEvent, type: T): Extract<RunEvent, { type: T }> {
  return event as Extract<RunEvent, { type: T }>;
}

function ignored(record: RunRecord, event: RunEvent): RunReduction {
  return { record, effects: [], ignored: [{ event: event.type, phase: record.phase }] };
}

function plateauReason(record: RunRecord): string {
  return `plateau: ${record.plateauLimit} consecutive non-advancing iterations for predicate "${record.predicate}"`;
}

function verdictReduction(
  record: RunRecord,
  event: RunEvent,
  now: number,
  verdict: RunVerdict,
  patch: Partial<RunIteration>,
  report: RunEffect[],
): RunReduction {
  const open = record.iterations.at(-1);
  const wrongPhase = record.phase !== "ACT" && record.phase !== "VERIFY";
  if (wrongPhase || !open || open.endedAt !== undefined) return ignored(record, event);
  const closed: RunIteration = { ...open, endedAt: now, verdict, ...patch };
  const advanced = verdict === "advanced";
  const consecutiveDiscards = advanced ? 0 : record.consecutiveDiscards + 1;
  const next: RunRecord = {
    ...record,
    iterations: [...record.iterations.slice(0, -1), closed],
    consecutiveDiscards,
    updatedAt: now,
    phase: "COMMIT_IF_ADVANCED_OR_DISCARD",
  };
  if (!advanced && consecutiveDiscards >= record.plateauLimit) {
    return {
      record: { ...next, phase: "BLOCKED", blockedReason: plateauReason(record) },
      effects: [
        ...report,
        notify(`run ${record.runId} BLOCKED on plateau after ${consecutiveDiscards} non-advancing iterations`),
        { type: "stop" },
      ],
    };
  }
  return { record: next, effects: report };
}

const HANDLERS: Record<string, Handler> = {
  predicate_defined: (record, event, now) => {
    const { predicate } = payload(event, "predicate_defined");
    const trimmed = predicate.trim();
    if (!trimmed) return { record, effects: [notify("predicate_defined ignored: predicate required")] };
    if (record.phase !== "DEFINE_PREDICATE") {
      return { record, effects: [notify(`run ${record.runId} predicate already defined; finish conditions are not relaxed`)] };
    }
    return {
      record: progressed(record, now, { predicate: trimmed, phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" }),
      effects: [notify(`run ${record.runId} predicate defined: ${trimmed}`)],
    };
  },

  heartbeat: (record, event, now) => {
    if (record.phase !== "WAIT_FOR_EVENT_OR_HEARTBEAT") return ignored(record, event);
    return {
      record: progressed(record, now, { phase: "RESUME_OR_START_ITERATION", fires: record.fires + 1 }),
      effects: [{ type: "wake", reason: "heartbeat" }],
    };
  },

  event_wake: (record, event, now) => {
    const { eventId, reason } = payload(event, "event_wake");
    if (eventId !== undefined && record.eventIds.includes(eventId)) return ignored(record, event);
    if (record.phase !== "WAIT_FOR_EVENT_OR_HEARTBEAT") return ignored(record, event);
    const label = reason ?? eventId ?? "event";
    const seen = eventId === undefined ? record.eventIds : [...record.eventIds, eventId];
    return {
      record: progressed(record, now, {
        phase: "RESUME_OR_START_ITERATION",
        fires: record.fires + 1,
        eventIds: seen,
        ...(eventId === undefined ? {} : { lastEventId: eventId }),
      }),
      effects: [{ type: "wake", reason: label }],
    };
  },

  iteration_started: (record, event, now) => {
    const { action } = payload(event, "iteration_started");
    const trimmed = action.trim();
    if (!trimmed) return { record, effects: [notify("iteration_started ignored: action required")] };
    if (record.phase !== "RESUME_OR_START_ITERATION") return ignored(record, event);
    const n = record.iterations.length + 1;
    const iteration: RunIteration = {
      n,
      startedAt: now,
      action: trimmed,
      verification: "",
      verdict: "inconclusive",
      evidence: "",
    };
    return {
      record: progressed(record, now, { phase: "ACT", iterations: [...record.iterations, iteration] }),
      effects: [notify(`run ${record.runId} iteration ${n} started: ${trimmed}`)],
    };
  },

  verification_started: (record, event, now) => {
    if (record.phase !== "ACT") return ignored(record, event);
    return { record: progressed(record, now, { phase: "VERIFY" }), effects: [] };
  },

  iteration_verified: (record, event, now) => {
    const { verification, evidence, commit } = payload(event, "iteration_verified");
    const trimmed = evidence.trim();
    if (!trimmed) return { record, effects: [notify("iteration_verified ignored: evidence required")] };
    const report = [notify(`run ${record.runId} iteration ${record.iterations.length} advanced`)];
    return verdictReduction(record, event, now, "advanced", { verification, evidence: trimmed, ...(commit ? { commit } : {}) }, report);
  },

  iteration_discarded: (record, event, now) => {
    const { reason, evidence } = payload(event, "iteration_discarded");
    const report = [notify(`run ${record.runId} iteration ${record.iterations.length} discarded: ${reason}`)];
    return verdictReduction(record, event, now, "discarded", { evidence }, report);
  },

  iteration_inconclusive: (record, event, now) => {
    const { reason, evidence } = payload(event, "iteration_inconclusive");
    const report = [notify(`run ${record.runId} iteration ${record.iterations.length} inconclusive: ${reason}`)];
    return verdictReduction(record, event, now, "inconclusive", { evidence }, report);
  },

  checkpoint: (record, event, now) => {
    if (record.phase !== "COMMIT_IF_ADVANCED_OR_DISCARD") return ignored(record, event);
    return {
      record: progressed(record, now, { phase: "CHECKPOINT" }),
      effects: [notify(`run ${record.runId} checkpoint written at iteration ${record.iterations.length}`)],
    };
  },

  predicate_checked: (record, event, now) => {
    if (record.phase !== "CHECKPOINT") return ignored(record, event);
    return { record: progressed(record, now, { phase: "CHECK_PREDICATE" }), effects: [] };
  },

  predicate_met: (record, event, now) => {
    const { evidence } = payload(event, "predicate_met");
    if (record.phase !== "CHECK_PREDICATE") return ignored(record, event);
    const trimmed = evidence.trim();
    if (!trimmed) {
      return { record, effects: [notify(`run ${record.runId} predicate_met ignored: evidence required to claim completion`)] };
    }
    return {
      record: progressed(record, now, { phase: "COMPLETE", completedAt: now }),
      effects: [notify(`run ${record.runId} COMPLETE: predicate met with evidence`), { type: "stop" }],
    };
  },

  predicate_unmet: (record, event, now) => {
    if (record.phase !== "CHECK_PREDICATE") return ignored(record, event);
    return {
      record: progressed(record, now, { phase: "WAIT_FOR_EVENT_OR_HEARTBEAT" }),
      effects: [notify(`run ${record.runId} predicate unresolved; waiting for event or heartbeat`)],
    };
  },

  mark_blocked: (record, event, now) => {
    const { reason } = payload(event, "mark_blocked");
    const trimmed = reason.trim() || "unspecified";
    return {
      record: progressed(record, now, { phase: "BLOCKED", blockedReason: trimmed }),
      effects: [notify(`run ${record.runId} BLOCKED: ${trimmed}`), { type: "stop" }],
    };
  },

  handoff_requested: (record, event, now) => {
    const { endpoint } = payload(event, "handoff_requested");
    const trimmed = endpoint.trim();
    if (!trimmed) return { record, effects: [notify("handoff_requested ignored: endpoint required")] };
    const reason = `hosted handoff requested for ${trimmed}; the local runtime cannot continue this run until the hosted worker exists`;
    return {
      record: progressed(record, now, {
        phase: "BLOCKED",
        blockedReason: reason,
        remote: { required: true, handedOff: true, endpoint: trimmed },
      }),
      effects: [
        { type: "handoff", endpoint: trimmed },
        notify(`run ${record.runId} handed off to ${trimmed}; BLOCKED locally until the hosted worker exists`),
      ],
    };
  },

  hosted_unavailable: (record, event, now) => {
    if (!record.remote.required) {
      return { record, effects: [notify(`run ${record.runId} hosted_unavailable ignored: remote execution not required`)] };
    }
    const reason = "local runtime cannot continue a hosted run; the hosted worker is unavailable";
    return {
      record: progressed(record, now, { phase: "BLOCKED", blockedReason: reason }),
      effects: [notify(`run ${record.runId} BLOCKED: ${reason}`), { type: "stop" }],
    };
  },
};

export function reduceRun(record: RunRecord, event: RunEvent, now: number): RunReduction {
  if (isTerminalPhase(record.phase)) {
    return event.type === "stop" ? { record, effects: [{ type: "stop" }] } : ignored(record, event);
  }
  if (event.type === "stop") return { record, effects: [{ type: "stop" }] };
  const handler = HANDLERS[event.type];
  return handler ? handler(record, event, now) : ignored(record, event);
}
