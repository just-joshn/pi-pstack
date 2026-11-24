import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { isJobKind, type BennyKind } from "../lib/jobs.ts";
import { isRecord, parseJson } from "../lib/validation.ts";

interface BennyConfig {
  slackChannel: string;
  triageModel?: string;
  reproModel?: string;
  allowDraftPr?: boolean;
}
interface JobBase {
  cwd: string;
  instructions: string;
  tools: string[];
  model?: string;
  thinking?: string;
}
export type Job =
  | (JobBase & { kind: "custom" })
  | (JobBase & { kind: BennyKind; config: BennyConfig });
export interface JobEvent {
  channel: string;
  thread: string;
  eventId: string;
}

const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const nativeReads = new Set(["read", "grep", "find", "ls"]);
const nativeWrites = new Set(["edit", "write"]);
const requiredConfig = ["slackChannel", "tracker", "repository", "featureMap", "controlAdapter"];
const hasText = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const optionalModel = (value: unknown): value is string | undefined =>
  value === undefined || (hasText(value) && !value.startsWith("-") && !value.includes("\0"));
const isToolList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((t) => typeof t === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(t));
const isMcp = (name: string) => name.startsWith("mcp__");

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
const forbiddenWords = new Set([
  "merge",
  "squash",
  "rebase",
  "land",
  "deploy",
  "publish",
  "push",
  "commit",
  "delete",
  "destroy",
  "execute",
  "exec",
  "eval",
  "shell",
  "bash",
  "sh",
  "zsh",
  "terminal",
  "command",
  "cmd",
  "script",
  "codemode",
]);
const toolObjects = new Set(["tool", "tools"]);
const discoveryVerbs = new Set(["search", "find", "discover", "load"]);
const writeVerbs = new Set(["create", "update", "put", "write"]);
const repoObjects = new Set(["file", "files", "contents", "branch", "ref"]);
const prObjects = new Set(["pr", "pull"]);
const pairs = (name: string, verbs: Set<string>, objects: Set<string>) => {
  const all = words(name);
  return all.some((w) => verbs.has(w)) && all.some((w) => objects.has(w));
};
const forbidden = (tool: string) =>
  isMcp(tool) &&
  (words(tool).some((w) => forbiddenWords.has(w)) ||
    words(tool.split("__").at(-1) ?? "")[0] === "run" ||
    pairs(tool, discoveryVerbs, toolObjects) ||
    pairs(tool, writeVerbs, repoObjects));
const createsPr = (tool: string) => pairs(tool, writeVerbs, prObjects);

function bennyConfig(kind: BennyKind, tools: string[], cfg: unknown): BennyConfig {
  if (
    !isRecord(cfg) ||
    cfg.enabled !== true ||
    requiredConfig.some((key) => !hasText(cfg[key])) ||
    !hasText(cfg.slackChannel) ||
    !optionalModel(cfg.triageModel) ||
    !optionalModel(cfg.reproModel) ||
    (cfg.allowDraftPr !== undefined && typeof cfg.allowDraftPr !== "boolean")
  )
    throw Error("Benny configuration is incomplete or disabled");
  if (!tools.some(isMcp)) throw Error("Benny requires explicit scoped MCP tool names");
  if (tools.some((t) => !nativeReads.has(t) && !nativeWrites.has(t) && !isMcp(t)))
    throw Error("Benny permits only narrow native file and explicitly named MCP tools");
  if (kind === "benny-triage" && tools.some((t) => nativeWrites.has(t)))
    throw Error("Benny triage is read-only; native edit and write require benny-repro");
  if (tools.some(forbidden))
    throw Error(
      "Benny disallows general command execution and merge/push/deploy/delete or repository-write tools; configure narrowly scoped MCP tools instead",
    );
  const draftPr = kind === "benny-repro" && cfg.allowDraftPr === true;
  if (!draftPr && tools.some(createsPr))
    throw Error("Benny pull request tools require benny-repro with allowDraftPr");
  return { ...cfg, slackChannel: cfg.slackChannel };
}

export function configuredModel(job: Job): string | undefined {
  if (job.model || job.kind === "custom") return job.model;
  return job.kind === "benny-triage" ? job.config.triageModel : job.config.reproModel;
}

export async function readJob(path: string): Promise<Job> {
  const job = parseJson(await readFile(path, "utf8"), "job file");
  if (
    !isRecord(job) ||
    job.version !== 1 ||
    job.enabled !== true ||
    typeof job.cwd !== "string" ||
    !isAbsolute(job.cwd) ||
    !isJobKind(job.kind) ||
    !hasText(job.instructions) ||
    !isToolList(job.tools) ||
    !optionalModel(job.model) ||
    (job.thinking !== undefined &&
      (typeof job.thinking !== "string" || !thinkingLevels.has(job.thinking)))
  ) {
    throw Error(
      "Job must be reviewed, enabled, and specify an absolute cwd, explicit tool allowlist, and valid model options",
    );
  }
  const { cwd, kind, instructions, tools, model, thinking } = job;
  const base = { ...job, cwd, instructions, tools, model, thinking };
  return kind === "custom"
    ? { ...base, kind }
    : { ...base, kind, config: bennyConfig(kind, tools, job.config) };
}

export async function readEvent(
  job: Job,
  path: string | undefined,
  secret: string | undefined,
): Promise<JobEvent | null> {
  if (job.kind === "custom") return null;
  if (!path || !secret)
    throw Error("Benny requires an authenticated event and PSTACK_EVENT_SECRET");
  const envelope = parseJson(await readFile(path, "utf8"), "event envelope");
  if (
    !isRecord(envelope) ||
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string" ||
    !/^[0-9a-f]{64}$/i.test(envelope.signature)
  )
    throw Error("Invalid signed event envelope");
  const expected = createHmac("sha256", secret).update(envelope.payload).digest();
  if (!timingSafeEqual(expected, Buffer.from(envelope.signature, "hex")))
    throw Error("Event signature rejected");
  const event = parseJson(envelope.payload, "signed event payload");
  if (
    !isRecord(event) ||
    !hasText(event.channel) ||
    event.channel !== job.config.slackChannel ||
    !hasText(event.thread) ||
    !hasText(event.eventId)
  )
    throw Error("Event does not match configured immutable thread coordinates");
  if (job.kind === "benny-triage" && (event.type !== "report" || event.topLevel !== true)) {
    throw Error("Expected a top-level report");
  }
  if (
    job.kind === "benny-repro" &&
    (event.type !== "triage-marker" ||
      (event.classification !== "bug" && event.classification !== "performance") ||
      event.trusted !== true ||
      !hasText(event.ticket))
  )
    throw Error("Expected authenticated confirmed triage marker");
  const { channel, thread, eventId } = event;
  return { ...event, channel, thread, eventId };
}
