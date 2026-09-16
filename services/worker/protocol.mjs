/**
 * Wire validation for the hosted worker protocol. The worker never executes an
 * unvalidated body, so every field the executor reads is checked here first.
 *
 * `parentOwnership` is the canonical placement field. `parentSessionCwd` is kept
 * as a legacy alias because the pstack_task client emitted it before the hosted
 * protocol existed; validation reads either and normalizes to parentOwnership.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isValidRunId } from "./store.mjs";

export const MAX_BODY_BYTES = 256 * 1024;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const FILESYSTEM = Object.freeze(["read-only", "workspace-write"]);
const SHELL = Object.freeze(["none", "restricted", "full"]);
const GIT = Object.freeze(["read", "branch-write", "push", "merge"]);
const NETWORK = Object.freeze(["none", "allowed"]);
const ENVIRONMENT = Object.freeze(["local", "hosted"]);
const ISOLATION = Object.freeze([
  "session",
  "process",
  "worktree",
  "container",
  "vm",
  "remote",
]);
const POLICY_AXES = Object.freeze([
  "filesystem",
  "shell",
  "git",
  "network",
  "integrations",
  "environment",
  "background",
  "isolation",
]);
const POLICY_ENUMS = Object.freeze({
  filesystem: FILESYSTEM,
  shell: SHELL,
  git: GIT,
  network: NETWORK,
  environment: ENVIRONMENT,
  isolation: ISOLATION,
});
const ENVELOPE_KEYS = Object.freeze([
  "runId",
  "idempotencyKey",
  "parentOwnership",
  "parentSessionCwd",
  "upstreamRevision",
  "pluginVersion",
  "task",
  "role",
  "model",
  "thinkingLevel",
  "policy",
  "capabilities",
  "secretRefs",
  "isolation",
  "timeoutMs",
  "reportSchema",
]);

function invalid(message) {
  return { ok: false, message };
}

function valid(value) {
  return { ok: true, value };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function readOptionalString(value, fallback) {
  return isNonEmptyString(value) ? value : fallback;
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?(?::[A-Za-z0-9-]{1,32})?$/;

function withinRoot(real, root) {
  if (real === root) return true;
  const rel = relative(root, real);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Contain the child cwd against the worker workspace root. Both sides are
 * realpath-resolved so a symlink inside the root cannot point outside it, and a
 * non-existent cwd is rejected before it reaches spawn.
 */
function validateWorkspaceCwd(cwd, workspaceRoot) {
  let root;
  try {
    root = realpathSync(resolve(workspaceRoot));
  } catch {
    return invalid("the worker workspace root is not an accessible directory");
  }
  let real;
  try {
    real = realpathSync(resolve(cwd));
  } catch {
    return invalid("parentOwnership.cwd must be an existing directory inside the workspace root");
  }
  if (!withinRoot(real, root)) {
    return invalid("parentOwnership.cwd must stay inside the worker workspace root");
  }
  return valid(real);
}

function validateIdentity(body) {
  if (!isValidRunId(body.runId)) {
    return invalid("runId must match /^[A-Za-z0-9._-]{1,64}$/");
  }
  if (!isNonEmptyString(body.idempotencyKey) || body.idempotencyKey.length > 200) {
    return invalid("idempotencyKey must be a non-empty string of at most 200 characters");
  }
  if (!isNonEmptyString(body.task)) return invalid("task must be a non-empty string");
  if (!isNonEmptyString(body.role)) return invalid("role must be a non-empty string");
  if (!isNonEmptyString(body.model) || !MODEL_PATTERN.test(body.model)) {
    return invalid("model must be a provider/model[:level] selector or an alias such as inherit-parent");
  }
  return valid({ runId: body.runId, idempotencyKey: body.idempotencyKey });
}

function validatePolicyEnums(raw) {
  return Object.entries(POLICY_ENUMS).reduce(
    (acc, [axis, allowed]) => {
      if (!acc.ok) return acc;
      const value = raw[axis];
      if (typeof value !== "string" || !allowed.includes(value)) {
        return invalid(`policy.${axis} must be one of ${allowed.join(", ")}`);
      }
      return valid({ ...acc.value, [axis]: value });
    },
    valid({}),
  );
}

function validateIntegrations(value) {
  if (value === "none" || value === "inherit") return valid(value);
  if (Array.isArray(value) && value.every((entry) => isNonEmptyString(entry))) {
    return valid([...value]);
  }
  return invalid("policy.integrations must be none, inherit, or an array of capability names");
}

function validatePolicy(raw) {
  if (!isPlainObject(raw)) return invalid("policy must be an object with the eight axes");
  const missing = POLICY_AXES.filter((axis) => !(axis in raw)).toSorted();
  if (missing.length) return invalid(`policy is missing axes: ${missing.join(", ")}`);
  const enums = validatePolicyEnums(raw);
  if (!enums.ok) return enums;
  const integrations = validateIntegrations(raw.integrations);
  if (!integrations.ok) return integrations;
  if (typeof raw.background !== "boolean") {
    return invalid("policy.background must be a boolean");
  }
  return valid({ ...enums.value, integrations: integrations.value, background: raw.background });
}

function validateParent(body, workspaceRoot) {
  if (body.parentOwnership !== undefined && !isPlainObject(body.parentOwnership)) {
    return invalid("parentOwnership must be an object");
  }
  const ownership = body.parentOwnership ?? {};
  const requested = ownership.cwd ?? body.parentSessionCwd ?? workspaceRoot;
  if (!isNonEmptyString(requested)) return invalid("parentOwnership.cwd must be a non-empty string");
  const sessionId = ownership.sessionId ?? "";
  if (typeof sessionId !== "string") return invalid("parentOwnership.sessionId must be a string");
  const cwd = validateWorkspaceCwd(requested, workspaceRoot);
  if (!cwd.ok) return cwd;
  return valid({ sessionId, cwd: cwd.value });
}

function validateTimeout(value) {
  if (value === undefined || value === null) return valid(DEFAULT_TIMEOUT_MS);
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    return invalid(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return valid(value);
}

function validateOptionals(body, policy, workspaceRoot) {
  const parent = validateParent(body, workspaceRoot);
  if (!parent.ok) return parent;
  const timeoutMs = validateTimeout(body.timeoutMs);
  if (!timeoutMs.ok) return timeoutMs;
  const capabilities = body.capabilities === undefined ? [] : body.capabilities;
  if (!isStringArray(capabilities)) return invalid("capabilities must be an array of strings");
  const secretRefs = body.secretRefs === undefined ? [] : body.secretRefs;
  if (!isStringArray(secretRefs)) return invalid("secretRefs must be an array of strings");
  const isolation = body.isolation ?? policy.isolation;
  if (!ISOLATION.includes(isolation)) {
    return invalid(`isolation must be one of ${ISOLATION.join(", ")}`);
  }
  const thinkingLevel = body.thinkingLevel ?? null;
  if (thinkingLevel !== null && typeof thinkingLevel !== "string") {
    return invalid("thinkingLevel must be a string or null");
  }
  return valid({
    parentOwnership: parent.value,
    timeoutMs: timeoutMs.value,
    capabilities: [...capabilities],
    secretRefs: [...secretRefs],
    isolation,
    thinkingLevel,
  });
}

/** Validate an untrusted POST /v1/tasks body; return the normalized envelope or a 400 message. */
export function validateTaskRequest(body, options = {}) {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  if (!isPlainObject(body)) return invalid("request body must be a JSON object");
  const unknown = Object.keys(body)
    .filter((key) => !ENVELOPE_KEYS.includes(key))
    .toSorted();
  if (unknown.length) return invalid(`unknown field(s): ${unknown.join(", ")}`);
  const identity = validateIdentity(body);
  if (!identity.ok) return identity;
  const policy = validatePolicy(body.policy);
  if (!policy.ok) return policy;
  const optionals = validateOptionals(body, policy.value, workspaceRoot);
  if (!optionals.ok) return optionals;
  const o = optionals.value;
  return valid({
    runId: identity.value.runId,
    idempotencyKey: identity.value.idempotencyKey,
    parentOwnership: o.parentOwnership,
    parentSessionCwd: o.parentOwnership.cwd,
    upstreamRevision: readOptionalString(body.upstreamRevision, "unknown"),
    pluginVersion: readOptionalString(body.pluginVersion, "unknown"),
    task: body.task,
    role: body.role,
    model: body.model,
    thinkingLevel: o.thinkingLevel,
    policy: policy.value,
    capabilities: o.capabilities,
    secretRefs: o.secretRefs,
    isolation: o.isolation,
    timeoutMs: o.timeoutMs,
    reportSchema: body.reportSchema ?? null,
  });
}
