/**
 * Hosted worker client (mandate section 24). The hosted execution path lives in
 * services/worker; this module is the only place pstack talks to it.
 *
 * A missing PSTACK_HOSTED_URL is a hard error naming services/worker. There is
 * no local fallback: a hosted run has different durability semantics, so
 * relabeling a local child would be a lie.
 *
 * secretRefs travel as names only. This module never reads or sends a value.
 */
import { INTEGRATION_CATEGORIES, type PstackTaskPolicy } from "../agents/policy.ts";

const HOSTED_URL_ENV = "PSTACK_HOSTED_URL";
const WORKER_TOKEN_ENV = "PSTACK_WORKER_TOKEN";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ParentOwnership {
  sessionId: string;
  cwd: string;
}

export interface TaskEnvelope {
  runId: string;
  idempotencyKey: string;
  parentOwnership: ParentOwnership;
  /** Legacy alias for parentOwnership.cwd; kept for the pre-protocol client body. */
  parentSessionCwd: string;
  upstreamRevision: string;
  pluginVersion: string;
  task: string;
  role: string;
  model: string;
  thinkingLevel: string | null;
  policy: PstackTaskPolicy;
  capabilities: string[];
  secretRefs: string[];
  isolation: string;
  timeoutMs: number;
  reportSchema: unknown;
}

export interface TaskEnvelopeInput {
  runId: string;
  task: string;
  role: string;
  model: string;
  policy: PstackTaskPolicy;
  parentCwd: string;
  parentSessionId?: string;
  idempotencyKey?: string;
  thinkingLevel?: string;
  capabilities?: string[];
  secretRefs?: string[];
  isolation?: string;
  timeoutMs?: number;
  reportSchema?: unknown;
  upstreamRevision?: string;
  pluginVersion?: string;
}

export interface HostedReply {
  status: number;
  text: string;
  record: unknown;
}

export interface HostedRequestOptions {
  signal?: AbortSignal;
  base?: string;
}

function trimBase(raw: string): string {
  return raw.replace(/\/+$/, "");
}

/** The configured worker base URL, or undefined when unset. */
export function hostedBaseUrl(): string | undefined {
  const raw = process.env[HOSTED_URL_ENV]?.trim();
  if (!raw) return undefined;
  return trimBase(raw);
}

/** Fail closed when no worker is configured; name services/worker, never fall back. */
export function requireHostedBaseUrl(): string {
  const base = hostedBaseUrl();
  if (!base) {
    throw new Error(
      "hosted worker unavailable: set PSTACK_HOSTED_URL to the services/worker base URL. " +
        "There is no local fallback: the worker owns the durable run record and result stream.",
    );
  }
  return base;
}

function capabilitiesFor(policy: PstackTaskPolicy, explicit?: string[]): string[] {
  if (explicit?.length) return [...explicit];
  if (policy.integrations === "none") return [];
  if (Array.isArray(policy.integrations)) return [...policy.integrations];
  return [...INTEGRATION_CATEGORIES];
}

/** Map a compiled pstack policy into the wire envelope the worker validates. */
export function buildTaskEnvelope(input: TaskEnvelopeInput): TaskEnvelope {
  const cwd = input.parentCwd;
  const sessionId = input.parentSessionId ?? "";
  return {
    runId: input.runId,
    idempotencyKey: input.idempotencyKey ?? `idem-${input.runId}`,
    parentOwnership: { sessionId, cwd },
    parentSessionCwd: cwd,
    upstreamRevision: input.upstreamRevision ?? process.env.PSTACK_UPSTREAM_REVISION ?? "unknown",
    pluginVersion: input.pluginVersion ?? process.env.PSTACK_PLUGIN_VERSION ?? "unknown",
    task: input.task,
    role: input.role,
    model: input.model,
    thinkingLevel: input.thinkingLevel ?? null,
    policy: input.policy,
    capabilities: capabilitiesFor(input.policy, input.capabilities),
    secretRefs: [...(input.secretRefs ?? [])],
    isolation: input.isolation ?? input.policy.isolation,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    reportSchema: input.reportSchema ?? null,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function requestJson(
  method: string,
  path: string,
  payload: unknown,
  options: HostedRequestOptions,
): Promise<HostedReply> {
  const base = options.base ? trimBase(options.base) : requireHostedBaseUrl();
  const headers: Record<string, string> = { accept: "application/json" };
  if (payload !== undefined) headers["content-type"] = "application/json";
  const token = process.env[WORKER_TOKEN_ENV]?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = text ? ` ${text.slice(0, 500)}` : "";
    throw new Error(
      `pstack_task hosted worker ${method} ${path} failed: HTTP ${response.status} ${response.statusText}${detail}`,
    );
  }
  return { status: response.status, text, record: parseJson(text) };
}

export async function postTask(envelope: TaskEnvelope, options: HostedRequestOptions = {}): Promise<HostedReply> {
  return requestJson("POST", "/v1/tasks", envelope, options);
}

export async function getTask(runId: string, options: HostedRequestOptions = {}): Promise<HostedReply> {
  return requestJson("GET", `/v1/tasks/${encodeURIComponent(runId)}`, undefined, options);
}

export async function cancelTask(runId: string, options: HostedRequestOptions = {}): Promise<HostedReply> {
  return requestJson("POST", `/v1/tasks/${encodeURIComponent(runId)}/cancel`, undefined, options);
}
