/**
 * Durable event store for the benny receiver.
 *
 * One JSON file per event under <stateDir>/events/<eventId>.json. Writes are
 * atomic (temp file beside the target, then rename), so a crash never replaces
 * a good record with a half-written one. The record lands on disk before the
 * wake line is appended, so a failed append leaves the event pending and the
 * next delivery of the same source event retries it.
 *
 * The agent-facing wake line is the same shape extensions/benny writes:
 * {ts, intent, payload}. pstack_benny_wake drains it unchanged.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const EVENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const EVENT_STATES = Object.freeze(["pending", "processed"]);

export function defaultStateDir() {
  return (
    process.env.PSTACK_BENNY_STATE_DIR ?? join(homedir(), ".pi", "agent", "pstack", "benny-events")
  );
}

export function defaultWakeFile() {
  return process.env.PSTACK_BENNY_WAKE_FILE ?? join(homedir(), ".pi", "agent", "pstack-benny-wakes.jsonl");
}

export function isValidEventId(eventId) {
  if (typeof eventId !== "string") return false;
  if (eventId === "." || eventId === ".." || eventId.includes("..")) return false;
  return EVENT_ID_PATTERN.test(eventId);
}

/** A fresh event id, used when a source supplies no stable event id. */
export function randomEventId() {
  return `evt-${randomBytes(12).toString("hex")}`;
}

/** Deterministic event id for a hashed source event key. */
export function eventIdForKey(sourceEventKey) {
  return `evt-${String(sourceEventKey).slice(0, 32)}`;
}

export function isWakeDelivered(record) {
  return typeof record?.wakeAppendedAt === "string" && record.wakeAppendedAt.length > 0;
}

/** The line appended to the wake file. Only normalized, secret-free fields. */
export function wakeLineFor(record, ts) {
  const payload = {
    source: record.source,
    eventId: record.eventId,
    channel: record.channel,
    threadTs: record.threadTs,
    text: record.text,
    user: record.user,
    receivedAt: record.receivedAt,
    intent: record.intent,
  };
  return JSON.stringify({ ts, intent: record.intent, payload });
}

function assertEventId(eventId) {
  if (!isValidEventId(eventId)) throw new Error(`invalid eventId: ${String(eventId)}`);
}

function parseEventRecord(text, source) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`corrupt event record at ${source}: ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`corrupt event record at ${source}: expected a JSON object`);
  }
  const record = parsed;
  if (!isValidEventId(record.eventId)) {
    throw new Error(`corrupt event record at ${source}: invalid eventId`);
  }
  if (!EVENT_STATES.includes(record.state)) {
    throw new Error(`corrupt event record at ${source}: unknown state ${String(record.state)}`);
  }
  if (typeof record.source !== "string" || typeof record.receivedAt !== "string") {
    throw new Error(`corrupt event record at ${source}: source and receivedAt must be strings`);
  }
  return record;
}

function storeContext(options) {
  const stateDir = resolve(options.stateDir ?? defaultStateDir());
  return {
    stateDir,
    eventsDir: join(stateDir, "events"),
    wakeFile: resolve(options.wakeFile ?? defaultWakeFile()),
    now: options.now ?? (() => Date.now()),
    appendLine: options.appendLine ?? ((file, text) => appendFileSync(file, text, "utf8")),
  };
}

function eventPathOf(ctx, eventId) {
  assertEventId(eventId);
  const file = resolve(ctx.eventsDir, `${eventId}.json`);
  if (!file.startsWith(ctx.eventsDir + sep)) {
    throw new Error(`eventId escapes the events directory: ${eventId}`);
  }
  return file;
}

function saveEventOf(ctx, record) {
  if (!isValidEventId(record?.eventId)) throw new Error("saveEvent requires a valid eventId");
  const file = eventPathOf(ctx, record.eventId);
  mkdirSync(dirname(file), { recursive: true });
  const noise = randomBytes(4).toString("hex");
  const temp = join(dirname(file), `.${record.eventId}.${process.pid}.${noise}.tmp`);
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`atomic save failed for event ${record.eventId}: ${detail}`);
  }
  return record;
}

function loadEventOf(ctx, eventId) {
  const file = eventPathOf(ctx, eventId);
  if (!existsSync(file)) return null;
  return parseEventRecord(readFileSync(file, "utf8"), file);
}

function listEventsOf(ctx, state) {
  if (state !== undefined && !EVENT_STATES.includes(state)) {
    throw new Error(`unknown event state: ${String(state)}`);
  }
  if (!existsSync(ctx.eventsDir)) return [];
  const names = readdirSync(ctx.eventsDir).filter((name) => name.endsWith(".json"));
  return names
    .map((name) =>
      parseEventRecord(readFileSync(join(ctx.eventsDir, name), "utf8"), join(ctx.eventsDir, name)),
    )
    .filter((record) => state === undefined || record.state === state)
    .toSorted((a, b) =>
      a.receivedAt === b.receivedAt
        ? a.eventId.localeCompare(b.eventId)
        : a.receivedAt.localeCompare(b.receivedAt),
    );
}

function findDuplicateOf(ctx, sourceEventKey) {
  if (typeof sourceEventKey !== "string" || sourceEventKey.length === 0) return null;
  return listEventsOf(ctx).find((record) => record.sourceEventKey === sourceEventKey) ?? null;
}

function markProcessedOf(ctx, eventId, result) {
  const current = loadEventOf(ctx, eventId);
  if (!current) return null;
  const at = new Date(ctx.now()).toISOString();
  return saveEventOf(ctx, {
    ...current,
    state: "processed",
    result: result ?? null,
    processedAt: at,
    updatedAt: at,
  });
}

function markWakeDeliveredOf(ctx, eventId, outcome) {
  const current = loadEventOf(ctx, eventId);
  if (!current) return null;
  const at = new Date(ctx.now()).toISOString();
  const delivered = outcome?.ok === true;
  return saveEventOf(ctx, {
    ...current,
    wakeAttempts: (current.wakeAttempts ?? 0) + 1,
    wakeAppendedAt: delivered ? at : (current.wakeAppendedAt ?? null),
    lastWakeError: delivered ? null : String(outcome?.error ?? "unknown wake failure"),
    updatedAt: at,
  });
}

/** Append one wake line. Failure is reported, never thrown, so the event survives. */
function appendWakeFileOf(ctx, line) {
  if (typeof line !== "string" || line.length === 0) {
    throw new Error("appendWakeFile requires a non-empty line");
  }
  const text = line.endsWith("\n") ? line : `${line}\n`;
  try {
    mkdirSync(dirname(ctx.wakeFile), { recursive: true });
    ctx.appendLine(ctx.wakeFile, text);
    return { ok: true, path: ctx.wakeFile };
  } catch (error) {
    return { ok: false, path: ctx.wakeFile, error: error instanceof Error ? error.message : String(error) };
  }
}

function deliverEventOf(ctx, api, eventId) {
  const current = loadEventOf(ctx, eventId);
  if (!current) return null;
  if (isWakeDelivered(current)) return current;
  const line = wakeLineFor(current, new Date(ctx.now()).toISOString());
  const appended = api.appendWakeFile(line);
  return markWakeDeliveredOf(ctx, eventId, appended.ok ? { ok: true } : { ok: false, error: appended.error });
}

/**
 * Bind a store to one state directory. Every method is synchronous, so the
 * duplicate check and the write cannot interleave inside one process.
 */
export function createEventStore(options = {}) {
  const ctx = storeContext(options);
  const api = {
    stateDir: ctx.stateDir,
    eventsDir: ctx.eventsDir,
    wakeFile: ctx.wakeFile,
    eventPath: (eventId) => eventPathOf(ctx, eventId),
    saveEvent: (record) => saveEventOf(ctx, record),
    loadEvent: (eventId) => loadEventOf(ctx, eventId),
    listEvents: (state) => listEventsOf(ctx, state),
    findDuplicate: (sourceEventKey) => findDuplicateOf(ctx, sourceEventKey),
    markProcessed: (eventId, result) => markProcessedOf(ctx, eventId, result),
    markWakeDelivered: (eventId, outcome) => markWakeDeliveredOf(ctx, eventId, outcome),
    appendWakeFile: (line) => appendWakeFileOf(ctx, line),
  };
  return { ...api, deliverEvent: (eventId) => deliverEventOf(ctx, api, eventId) };
}
