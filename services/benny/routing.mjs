/**
 * Normalization and routing configuration for the benny receiver.
 *
 * A Slack-shaped body and a generic webhook body become one record shape. The
 * channel picks an intent from the durable config at ~/.pi/agent/benny.json, so
 * the local agent drains a wake line that already knows whether it is a triage
 * or a repro run.
 *
 * The raw source event id is never stored. Records carry a SHA-256 key derived
 * from source and sourceEventId, which is also the duplicate key.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { eventIdForKey, randomEventId } from "./store.mjs";

export const INTENTS = Object.freeze(["triage", "repro", "ignore"]);
export const DEFAULT_INTENT = "triage";
export const CONFIG_FILE_NAME = "benny.json";
export const OWNED_CONFIG_KEYS = Object.freeze(["routes", "defaultIntent"]);
export const CHANNEL_MAX_LENGTH = 200;

export function defaultConfigDir() {
  return process.env.PSTACK_BENNY_CONFIG_DIR ?? join(homedir(), ".pi", "agent");
}

export function configPathOf(options = {}) {
  return resolve(options.dir ?? defaultConfigDir(), CONFIG_FILE_NAME);
}

export function defaultConfig() {
  return { routes: [], defaultIntent: DEFAULT_INTENT };
}

export function isValidIntent(intent) {
  return INTENTS.includes(intent);
}

export function isValidChannel(channel) {
  if (typeof channel !== "string") return false;
  if (channel.length === 0 || channel.length > CHANNEL_MAX_LENGTH) return false;
  return !/[\u0000-\u001f\u007f]/.test(channel);
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ok(value) {
  return { ok: true, value };
}

function fail(message) {
  return { ok: false, message };
}

export function validateConfig(config) {
  if (!isPlainObject(config)) throw new Error("benny config must be a JSON object");
  const routes = config.routes ?? [];
  if (!Array.isArray(routes)) throw new Error("benny config routes must be an array");
  for (const [index, route] of routes.entries()) {
    if (!isPlainObject(route)) throw new Error(`benny config route ${index} must be an object`);
    if (!isValidChannel(route.channel)) {
      throw new Error(`benny config route ${index} needs a channel string`);
    }
    if (!isValidIntent(route.intent)) {
      throw new Error(`benny config route ${index} intent must be one of ${INTENTS.join(", ")}`);
    }
  }
  if (config.defaultIntent !== undefined && !isValidIntent(config.defaultIntent)) {
    throw new Error(`benny config defaultIntent must be one of ${INTENTS.join(", ")}`);
  }
  return config;
}

/** Read the config and keep every key the user owns, including unknown ones. */
export function loadConfig(options = {}) {
  const path = configPathOf(options);
  if (!existsSync(path)) return { path, exists: false, config: defaultConfig() };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`benny config at ${path} is not valid JSON: ${detail}`);
  }
  const config = validateConfig(parsed);
  return { path, exists: true, config: { ...defaultConfig(), ...config } };
}

function pickOwned(update) {
  return OWNED_CONFIG_KEYS.reduce((acc, key) => {
    if (!isPlainObject(update) || !Object.prototype.hasOwnProperty.call(update, key)) return acc;
    return { ...acc, [key]: update[key] };
  }, {});
}

/** Merge only the keys this service owns; every other key survives untouched. */
export function writeConfig(update, options = {}) {
  const current = loadConfig(options);
  const merged = validateConfig({ ...current.config, ...pickOwned(update) });
  const path = current.path;
  mkdirSync(dirname(path), { recursive: true });
  const noise = randomBytes(4).toString("hex");
  const temp = join(dirname(path), `.${CONFIG_FILE_NAME}.${process.pid}.${noise}.tmp`);
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`atomic config write failed at ${path}: ${detail}`);
  }
  return merged;
}

/** Channel route first, then the configured default, then triage. */
export function resolveIntent(config, channel) {
  const routes = Array.isArray(config?.routes) ? config.routes : [];
  const match = routes.find((route) => route.channel === channel);
  if (match && isValidIntent(match.intent)) return match.intent;
  return isValidIntent(config?.defaultIntent) ? config.defaultIntent : DEFAULT_INTENT;
}

/**
 * Hash key for duplicate detection. A record stores the key, never the raw
 * source event id, and the event id is derived from the key so a redelivery of
 * the same source event resolves to the same record.
 */
export function sourceEventKeyOf(source, sourceEventId) {
  const id = textOrNull(sourceEventId);
  if (id === null) return null;
  return createHash("sha256").update(`${source}|${id}`).digest("hex");
}

function buildRecord(fields, options) {
  const now = options.now ?? (() => Date.now());
  const sourceEventKey = sourceEventKeyOf(fields.source, fields.sourceEventId);
  return {
    eventId: sourceEventKey === null ? randomEventId() : eventIdForKey(sourceEventKey),
    source: fields.source,
    sourceEventKey,
    channel: fields.channel ?? null,
    threadTs: fields.threadTs ?? null,
    text: typeof fields.text === "string" ? fields.text : "",
    user: fields.user ?? null,
    receivedAt: new Date(now()).toISOString(),
    intent: resolveIntent(options.config ?? defaultConfig(), fields.channel ?? null),
  };
}

/** {type, event_id, event:{channel, ts, text, user, thread_ts?}} -> one record. */
export function normalizeSlackEvent(body, options = {}) {
  if (!isPlainObject(body)) return fail("body must be a JSON object");
  const event = body.event;
  if (!isPlainObject(event)) return fail("slack payload requires an event object");
  if (textOrNull(body.event_id) === null) return fail("slack payload requires a non-empty event_id");
  if (!isValidChannel(event.channel)) return fail("slack event requires a channel string");
  const ts = textOrNull(event.ts);
  if (ts === null) return fail("slack event requires a ts for thread association");
  const threadTs = textOrNull(event.thread_ts) ?? ts;
  return ok(
    buildRecord(
      {
        source: "slack",
        sourceEventId: body.event_id,
        channel: event.channel,
        threadTs,
        text: typeof event.text === "string" ? event.text : "",
        user: textOrNull(event.user),
      },
      options,
    ),
  );
}

/** {eventId?, source?, payload} -> the same record shape, source defaults to webhook. */
export function normalizeWebhookEvent(source, body, options = {}) {
  if (!isPlainObject(body)) return fail("body must be a JSON object");
  const payload = isPlainObject(body.payload) ? body.payload : null;
  const ts = textOrNull(payload?.ts) ?? textOrNull(body.ts);
  return ok(
    buildRecord(
      {
        source: textOrNull(body.source) ?? textOrNull(source) ?? "webhook",
        sourceEventId: textOrNull(body.eventId) ?? textOrNull(payload?.eventId),
        channel: textOrNull(payload?.channel) ?? textOrNull(body.channel),
        threadTs: textOrNull(payload?.threadTs) ?? textOrNull(payload?.thread_ts) ?? ts,
        text: textOrNull(payload?.text) ?? textOrNull(body.text) ?? "",
        user: textOrNull(payload?.user) ?? textOrNull(body.user),
      },
      options,
    ),
  );
}
