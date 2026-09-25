import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { parseRunId, parseRunStatus, parseRunnerJsonl, type RunId, type RunStatus, type ShellLine } from "./contracts.ts";
import type { AgentLaunchRequest } from "./agents.ts";
import type { WorktreeResult } from "./worktrees.ts";
import { compileSafeRegex, regexMatchesLine } from "./regex-safety.js";

export const RUN_ENTRY_TYPE = "pstack-agents/run";
export const NOTIFICATION_TYPE = "pstack-agents/notice";
export const MAX_SHELL_TIMEOUT_MS = 604800000;

export type ParentOwner = {
  sessionId: string;
  sessionFile: string;
  branchLeafAtLaunch: string | null;
  toolCallId: string;
  depth: number;
};

export type AgentRunRequest = AgentLaunchRequest & {
  environment: "local" | "cloud";
  cloudBaseBranch?: string;
  worktree?: WorktreeResult;
};

export type ShellRunRequest = {
  kind: "shell";
  command: string;
  cwd: string;
  outputNotification?: string;
  timeout?: number;
  hardTimeout?: number;
};

export type ShellToolInput = {
  command: string;
  working_directory?: string;
  timeout?: number;
  hard_timeout?: number;
  is_background?: boolean;
  output_notification?: string;
};

export type ParsedShellInput = { request: ShellRunRequest; runInBackground: boolean };

export type RunRequest = AgentRunRequest | ShellRunRequest;

export type LaunchEntry = {
  kind: "launch";
  id: RunId;
  attempt: number;
  requestKey: string;
  owner: ParentOwner;
  request: RunRequest;
  runInBackground: boolean;
  createdAt: number;
};

export type LaunchIndexEntry = {
  id: RunId;
  attempt: number;
  requestKey: string;
  owner: ParentOwner;
  requestKind: "agent" | "shell";
  agentName?: string;
  environment?: "local" | "cloud";
  cloudBaseBranch?: string;
  worktreeBaseCommit?: string;
  runInBackground: boolean;
  createdAt: number;
};

export function parseShellInput(input: unknown, cwd: string): ParsedShellInput {
  if (!isRecord(input) || typeof input.command !== "string" || input.command.trim() === "") throw new Error("Shell requires a non-empty command");
  const workingDirectory = input.working_directory === undefined ? cwd : input.working_directory;
  if (typeof workingDirectory !== "string") throw new Error("Shell working_directory must be a path string");
  const resolvedCwd = path.resolve(cwd, workingDirectory);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedCwd);
  } catch {
    throw new Error(`Shell working_directory does not exist: ${resolvedCwd}`);
  }
  if (!stats.isDirectory()) throw new Error(`Shell working_directory is not a directory: ${resolvedCwd}`);

  const parseTimeout = (value: unknown, field: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_SHELL_TIMEOUT_MS) {
      throw new Error(`Shell ${field} must be an integer between 1 and ${MAX_SHELL_TIMEOUT_MS} milliseconds`);
    }
    return value;
  };
  let outputNotification: string | undefined;
  if (input.output_notification !== undefined) {
    if (typeof input.output_notification !== "string") throw new Error("Shell output_notification must be a regular expression string");
    compileSafeRegex(input.output_notification, "Shell output_notification");
    outputNotification = input.output_notification;
  }
  if (input.is_background !== undefined && typeof input.is_background !== "boolean") throw new Error("Shell is_background must be a boolean");
  return {
    request: {
      kind: "shell",
      command: input.command,
      cwd: resolvedCwd,
      outputNotification,
      timeout: parseTimeout(input.timeout, "timeout"),
      hardTimeout: parseTimeout(input.hard_timeout, "hard_timeout"),
    },
    runInBackground: input.is_background === true,
  };
}

export type RunReceipt =
  | { kind: "agent"; agent_id: RunId; status: RunStatus["state"]; transcript: string; worktree?: { path: string; branch: string } }
  | { kind: "shell"; task_id: RunId; status: RunStatus["state"]; outputLog: string };

export type AwaitResult =
  | { state: "matched"; id: RunId; status: RunStatus; sequence: number; line: string }
  | { state: "terminal"; id: RunId; status: RunStatus }
  | { state: "timeout"; id: RunId; status: RunStatus }
  | { state: "detached"; id: RunId; status: RunStatus };

export type RunNotification = {
  notificationId: string;
  id: RunId;
  attempt: number;
  kind: "agent" | "shell";
  event: "running" | "output" | "completed";
  status: RunStatus;
  line?: ShellLine;
  text?: string;
  transcript?: string;
  outputLog?: string;
};

export type RunStore = {
  idForRequestKey(requestKey: string): RunId;
  requestKey(owner: ParentOwner): string;
  findLaunchByRequestKey(branch: readonly SessionEntry[], requestKey: string): LaunchIndexEntry | undefined;
  latestLaunch(branch: readonly SessionEntry[], id: RunId): LaunchIndexEntry | undefined;
  prepare(entry: LaunchEntry): void;
  start(entry: LaunchEntry): Promise<RunReceipt>;
  resume(entry: LaunchEntry): Promise<RunReceipt>;
  ensure(id: RunId): Promise<RunReceipt>;
  status(id: RunId): Promise<RunStatus>;
  /** `detachOnAbort`: an aborted Await leaves the run going; an aborted foreground Task interrupts it. */
  wait(id: RunId, timeoutMs?: number, regex?: RegExp, signal?: AbortSignal, detachOnAbort?: boolean): Promise<AwaitResult>;
  interrupt(id: RunId): Promise<void>;
  transcript(id: RunId): string;
  outputLog(id: RunId): string;
  outputText(id: RunId): string;
  finalOutput(id: RunId): string;
  usage(id: RunId, attempt: number): Usage | undefined;
  claimUsage(id: RunId, attempt: number): Usage | undefined;
  reconcile(branch: readonly SessionEntry[], notify: (notification: RunNotification) => void, includeRunning: boolean): Promise<void>;
  observe(options: {
    branch: () => readonly SessionEntry[];
    notify: (notification: RunNotification) => void;
    notificationsEnabled?: boolean;
    onChange: () => void;
    onError: (error: Error) => void;
  }): void;
  closeWatchers(): void;
};

type RunnerRequest = {
  version: 1;
  id: RunId;
  attempt: number;
  requestKey: string;
  request: RunRequest;
  transcript: string;
  piCommand: string;
  piArgsPrefix: string[];
  parentRun?: { directory: string; attempt: number };
};

type StoreOptions = {
  sessionDir: string;
  sessionFile: string;
  sessionId: string;
  runnerPath: string;
  piCommand: string;
  piArgsPrefix: string[];
  cwd: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function terminal(status: RunStatus): boolean {
  return status.state === "completed" || status.state === "failed" || status.state === "stopped";
}

function atomicWrite(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const descriptor = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  let directoryDescriptor: number | undefined;
  try {
    directoryDescriptor = fs.openSync(directory, "r");
    fs.fsyncSync(directoryDescriptor);
  } finally {
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
  }
}

function runIndexEntry(value: unknown): LaunchIndexEntry | undefined {
  if (!isRecord(value) || value.kind !== "launch") return undefined;
  const id = parseRunId(value.id);
  const attempt = value.attempt;
  const requestKey = value.requestKey;
  const createdAt = value.createdAt;
  const owner = value.owner;
  const request = value.request;
  if (!id || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) return undefined;
  if (typeof requestKey !== "string" || requestKey === "" || !finiteNumber(createdAt) || !isRecord(owner) || !isRecord(request)) return undefined;
  if (typeof owner.sessionId !== "string" || typeof owner.sessionFile !== "string" || typeof owner.toolCallId !== "string") return undefined;
  if (owner.branchLeafAtLaunch !== null && typeof owner.branchLeafAtLaunch !== "string") return undefined;
  if (typeof owner.depth !== "number" || !Number.isSafeInteger(owner.depth) || owner.depth < 0) return undefined;
  if (request.kind !== "agent" && request.kind !== "shell") return undefined;
  if (typeof value.runInBackground !== "boolean") return undefined;
  const agentName = request.kind === "agent" && isRecord(request.agent) && typeof request.agent.name === "string" ? request.agent.name : undefined;
  const environment = request.kind === "agent" && (request.environment === "local" || request.environment === "cloud") ? request.environment : undefined;
  const cloudBaseBranch = request.kind === "agent" && typeof request.cloudBaseBranch === "string" ? request.cloudBaseBranch : undefined;
  const worktreeBaseCommit = request.kind === "agent" && isRecord(request.worktree) && typeof request.worktree.baseCommit === "string" ? request.worktree.baseCommit : undefined;
  return {
    id,
    attempt,
    requestKey,
    owner: {
      sessionId: owner.sessionId,
      sessionFile: owner.sessionFile,
      branchLeafAtLaunch: owner.branchLeafAtLaunch,
      toolCallId: owner.toolCallId,
      depth: owner.depth,
    },
    requestKind: request.kind,
    agentName,
    environment,
    cloudBaseBranch,
    worktreeBaseCommit,
    runInBackground: value.runInBackground,
    createdAt,
  };
}

export function launchEntriesFromBranch(branch: readonly SessionEntry[]): LaunchIndexEntry[] {
  const entries: LaunchIndexEntry[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== RUN_ENTRY_TYPE) continue;
    const parsed = runIndexEntry(entry.data);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

export function deliveredNotificationIds(branch: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "custom_message" || entry.customType !== NOTIFICATION_TYPE || !isRecord(entry.details)) continue;
    if (typeof entry.details.notificationId === "string") ids.add(entry.details.notificationId);
  }
  return ids;
}

export function shouldNotify(options: {
  notificationId: string;
  delivered: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
}): boolean {
  return !options.delivered.has(options.notificationId) && !options.inFlight.has(options.notificationId);
}

export function recordLaunch(pi: Pick<ExtensionAPI, "appendEntry">, entry: LaunchEntry): void {
  pi.appendEntry(RUN_ENTRY_TYPE, entry);
}

function getText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function finalAssistantOutput(directory: string): string {
  const lastAssistantMessage = readRecords(directory).messages.filter((message) => message.role === "assistant").at(-1);
  return lastAssistantMessage ? getText(lastAssistantMessage) : "";
}

function statusFromContents(contents: string, id: RunId, attempt: number, createdAt: number): RunStatus {
  const status = parseRunStatus(JSON.parse(contents));
  if (status?.id === id && status.attempt === attempt) return status;
  return { state: "starting", id, attempt, updatedAt: createdAt };
}

function toolResultsByCallId(branch: readonly SessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    ids.add(entry.message.toolCallId);
  }
  return ids;
}

export function completedRunAttempts(branch: readonly SessionEntry[]): Set<string> {
  const attempts = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || !isRecord(entry.message.details)) continue;
    const details = entry.message.details;
    const id = parseRunId(details.runId);
    const status = isRecord(details.status) ? details.status : undefined;
    const attempt = details.attempt ?? status?.attempt;
    if (id && details.completed === true && Number.isSafeInteger(attempt) && Number(attempt) > 0) attempts.add(`${id}:${attempt}`);
  }
  return attempts;
}

function parseRunNotificationRegex(requestPath: string): RegExp | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || !isRecord(raw.request) || raw.request.kind !== "shell" || typeof raw.request.outputNotification !== "string") return undefined;
  try {
    return compileSafeRegex(raw.request.outputNotification, "Shell output_notification");
  } catch {
    return undefined;
  }
}

function parentRunFromEnvironment(): RunnerRequest["parentRun"] {
  const directory = process.env.PSTACK_AGENTS_PARENT_RUN_DIRECTORY;
  const rawAttempt = process.env.PSTACK_AGENTS_PARENT_RUN_ATTEMPT;
  if (directory === undefined && rawAttempt === undefined) return undefined;
  const attempt = Number(rawAttempt);
  if (!directory || !path.isAbsolute(directory) || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Invalid pstack-agents parent run environment");
  }
  return { directory, attempt };
}

function runnerRequestPath(runDirectory: string, attempt: number): string {
  return path.join(runDirectory, "requests", `${attempt}.json`);
}

function runDirectory(sessionDir: string, id: RunId): string {
  return path.join(sessionDir, "pstack-agents", id);
}

export function runDirectoryForSession(sessionDir: string, id: RunId): string {
  return runDirectory(sessionDir, id);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function readRecords(directory: string): ReturnType<typeof parseRunnerJsonl> {
  try {
    return parseRunnerJsonl(fs.readFileSync(path.join(directory, "events.jsonl"), "utf8"));
  } catch {
    return parseRunnerJsonl("");
  }
}

export function createRunStore(options: StoreOptions): RunStore {
  const watchers = new Map<RunId, fs.FSWatcher>();
  const notificationInFlight = new Set<string>();
  const completionWaits = new Set<string>();
  const attemptKey = (id: RunId, attempt: number): string => `${id}:${attempt}`;
  let observers: {
    branch: () => readonly SessionEntry[];
    notify: (notification: RunNotification) => void;
    notificationsEnabled: boolean;
    onChange: () => void;
    onError: (error: Error) => void;
  } | undefined;

  const indexEntries = (branch: readonly SessionEntry[]): LaunchIndexEntry[] => {
    const byId = new Map<RunId, LaunchIndexEntry>();
    for (const entry of launchEntriesFromBranch(branch)) {
      const current = byId.get(entry.id);
      if (!current || current.attempt < entry.attempt) byId.set(entry.id, entry);
    }
    return [...byId.values()];
  };

  const findLaunch = (branch: readonly SessionEntry[], id: RunId): LaunchIndexEntry => {
    const launch = indexEntries(branch).find((entry) => entry.id === id);
    if (!launch) throw new Error(`Unknown Task or Shell id: ${id}`);
    return launch;
  };

  const transcriptPath = (id: RunId, parentSessionFile = options.sessionFile): string => {
    const parentBase = parentSessionFile.endsWith(".jsonl") ? parentSessionFile.slice(0, -6) : parentSessionFile;
    return path.join(path.dirname(parentSessionFile), path.basename(parentBase), id, "session.jsonl");
  };

  const runStatus = (launch: LaunchIndexEntry): RunStatus => {
    const directory = runDirectory(options.sessionDir, launch.id);
    try {
      return statusFromContents(fs.readFileSync(path.join(directory, "status.json"), "utf8"), launch.id, launch.attempt, launch.createdAt);
    } catch {
      return { state: "starting", id: launch.id, attempt: launch.attempt, updatedAt: launch.createdAt };
    }
  };

  const atomicJson = (filePath: string, value: unknown): void => atomicWrite(filePath, `${JSON.stringify(value)}\n`);

  const acknowledgementPath = (id: RunId, notificationId: string): string => {
    const digest = createHash("sha256").update(notificationId).digest("hex");
    return path.join(runDirectory(options.sessionDir, id), "acks", `${digest}.json`);
  };

  const acknowledge = (id: RunId, notificationId: string): void => {
    atomicJson(acknowledgementPath(id, notificationId), { notificationId, acknowledgedAt: Date.now() });
  };

  const isAcknowledged = (id: RunId, notificationId: string): boolean => fs.existsSync(acknowledgementPath(id, notificationId));

  const emitNotification = (notification: RunNotification, delivered: ReadonlySet<string>, notify: (notification: RunNotification) => void): void => {
    if (observers && !observers.notificationsEnabled) return;
    if (isAcknowledged(notification.id, notification.notificationId)) return;
    if (!shouldNotify({ notificationId: notification.notificationId, delivered, inFlight: notificationInFlight })) return;
    notificationInFlight.add(notification.notificationId);
    try {
      notify(notification);
      acknowledge(notification.id, notification.notificationId);
    } catch (error) {
      notificationInFlight.delete(notification.notificationId);
      throw error;
    }
  };

  const reconcile = async (branch: readonly SessionEntry[], notify: (notification: RunNotification) => void, includeRunning: boolean): Promise<void> => {
    const delivered = deliveredNotificationIds(branch);
    const completedToolCalls = toolResultsByCallId(branch);
    const completedAttempts = completedRunAttempts(branch);
    const latestEntries = indexEntries(branch);

    for (const launch of latestEntries) {
      const directory = runDirectory(options.sessionDir, launch.id);
      const status = runStatus(launch);
      const transcript = launch.requestKind === "agent" ? transcriptPath(launch.id, launch.owner.sessionFile) : undefined;
      const output = launch.requestKind === "shell" ? path.join(directory, "output.log") : undefined;
      if (includeRunning && (status.state === "starting" || status.state === "running")) {
        emitNotification({
          notificationId: `${launch.id}:${launch.attempt}:running`,
          id: launch.id,
          attempt: launch.attempt,
          kind: launch.requestKind,
          event: "running",
          status,
          transcript,
          outputLog: output,
        }, delivered, notify);
      }

      if (launch.requestKind === "shell" && launch.runInBackground) {
        const regex = parseRunNotificationRegex(runnerRequestPath(directory, launch.attempt));
        if (regex) {
          for (const line of readRecords(directory).shellLines) {
            if (!regexMatchesLine(regex, line.line)) continue;
            const notificationId = `${launch.id}:${launch.attempt}:line:${line.sequence}`;
            emitNotification({
              notificationId,
              id: launch.id,
              attempt: launch.attempt,
              kind: "shell",
              event: "output",
              status,
              line,
              outputLog: output,
            }, delivered, notify);
          }
        }
      }

      const key = attemptKey(launch.id, launch.attempt);
      if (!terminal(status) || completedAttempts.has(key) || completionWaits.has(key) || (!launch.runInBackground && completedToolCalls.has(launch.owner.toolCallId))) continue;
      emitNotification({
        notificationId: `${launch.id}:${launch.attempt}:completed`,
        id: launch.id,
        attempt: launch.attempt,
        kind: launch.requestKind,
        event: "completed",
        status,
        text: launch.requestKind === "agent" ? finalAssistantOutput(directory) : undefined,
        transcript,
        outputLog: output,
      }, delivered, notify);
    }
  };

  const statusResult = async (id: RunId): Promise<RunStatus> => {
    const branch = observers?.branch() ?? [];
    return runStatus(findLaunch(branch, id));
  };

  const requestPaths = (entry: LaunchEntry): { directory: string; requestPath: string; transcript: string } => {
    const directory = runDirectory(options.sessionDir, entry.id);
    const requestPath = runnerRequestPath(directory, entry.attempt);
    const transcript = entry.request.kind === "agent" ? transcriptPath(entry.id, entry.owner.sessionFile) : "";
    return { directory, requestPath, transcript };
  };

  const writeRequest = (entry: LaunchEntry): string => {
    const { directory, requestPath, transcript } = requestPaths(entry);
    ensurePrivateDirectory(directory);
    if (transcript) ensurePrivateDirectory(path.dirname(transcript));
    const request: RunnerRequest = {
      version: 1,
      id: entry.id,
      attempt: entry.attempt,
      requestKey: entry.requestKey,
      request: entry.request,
      transcript,
      piCommand: options.piCommand,
      piArgsPrefix: options.piArgsPrefix,
      parentRun: parentRunFromEnvironment(),
    };
    if (fs.existsSync(requestPath)) {
      let previous: unknown;
      try {
        previous = JSON.parse(fs.readFileSync(requestPath, "utf8"));
      } catch {
        throw new Error(`Run attempt ${entry.attempt} has a corrupt request file`);
      }
      if (!isRecord(previous) || previous.requestKey !== entry.requestKey) {
        throw new Error(`Run attempt ${entry.attempt} already belongs to another request`);
      }
      if (entry.attempt === 1 && !fs.existsSync(path.join(directory, "request.json"))) {
        atomicJson(path.join(directory, "request.json"), previous);
      }
      return requestPath;
    }
    atomicJson(requestPath, request);
    if (entry.attempt === 1) atomicJson(path.join(directory, "request.json"), request);
    return requestPath;
  };

  const launchRunnerAt = async (id: RunId, requestPath: string): Promise<void> => {
    const directory = runDirectory(options.sessionDir, id);
    const child = spawn(process.execPath, [options.runnerPath, directory, requestPath], {
      cwd: options.cwd,
      detached: true,
      shell: false,
      stdio: "ignore",
      env: process.env,
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", reject);
    });
  };

  const receipt = async (launch: LaunchIndexEntry): Promise<RunReceipt> => {
    const status = runStatus(launch);
    const directory = runDirectory(options.sessionDir, launch.id);
    if (launch.requestKind === "shell") return { kind: "shell", task_id: launch.id, status: status.state, outputLog: path.join(directory, "output.log") };
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(runnerRequestPath(directory, launch.attempt), "utf8"));
    } catch {
      throw new Error(`Run request for ${launch.id} is unavailable`);
    }
    const request = isRecord(raw) && isRecord(raw.request) && raw.request.kind === "agent" ? raw.request : undefined;
    const worktree = request && isRecord(request.worktree) && typeof request.worktree.path === "string" && typeof request.worktree.branch === "string"
      ? { path: request.worktree.path, branch: request.worktree.branch }
      : undefined;
    return {
      kind: "agent",
      agent_id: launch.id,
      status: status.state,
      transcript: transcriptPath(launch.id, launch.owner.sessionFile),
      worktree,
    };
  };

  const launch = async (entry: LaunchEntry): Promise<RunReceipt> => {
    const currentBranch = observers?.branch() ?? [];
    const existing = entry.attempt === 1 ? launchEntriesFromBranch(currentBranch).find((candidate) => candidate.requestKey === entry.requestKey) : undefined;
    const active = existing ?? runIndexEntry(entry);
    if (!active) throw new Error("Invalid Task or Shell launch entry");
    if (!active.runInBackground) completionWaits.add(attemptKey(active.id, active.attempt));
    if (active.id !== entry.id) throw new Error("Stable Task request key already belongs to another run ID");
    const requestPath = writeRequest(entry);
    if (!terminal(runStatus(active))) await launchRunnerAt(active.id, requestPath);
    if (observers) ensureWatcher(active.id);
    return receipt(active);
  };

  const ensureWatcher = (id: RunId): void => {
    if (!observers || watchers.has(id)) return;
    const directory = runDirectory(options.sessionDir, id);
    try {
      const watcher = fs.watch(directory, { persistent: false }, () => {
        if (!observers) return;
        const current = observers;
        current.onChange();
        void reconcile(current.branch(), current.notify, false).catch((error: unknown) => {
          current.onError(error instanceof Error ? error : new Error(String(error)));
        });
      });
      watcher.on("error", (error) => {
        watchers.delete(id);
        observers?.onError(error);
      });
      watchers.set(id, watcher);
    } catch (error) {
      observers.onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const store: RunStore = {
    idForRequestKey(requestKey) {
      if (requestKey === "") throw new Error("Request key must not be empty");
      const hash = createHash("sha256").update(`pstack-agents:${requestKey}`).digest("hex").slice(0, 32);
      const variant = ((Number.parseInt(hash.charAt(16), 16) & 3) | 8).toString(16);
      const raw = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20)}`;
      const id = parseRunId(raw);
      if (!id) throw new Error("Failed to derive a valid run ID from its request key");
      return id;
    },
    requestKey(owner) {
      if (owner.sessionId !== options.sessionId) throw new Error("Task owner does not belong to this session");
      return createHash("sha256").update(`${options.sessionId}\0${owner.toolCallId}`).digest("hex");
    },
    findLaunchByRequestKey(branch, requestKey) {
      return launchEntriesFromBranch(branch).find((entry) => entry.requestKey === requestKey);
    },
    latestLaunch(branch, id) {
      return indexEntries(branch).find((entry) => entry.id === id);
    },
    prepare(entry) {
      writeRequest(entry);
    },
    async start(entry) {
      return launch(entry);
    },
    async resume(entry) {
      const branch = observers?.branch() ?? [];
      const previous = launchEntriesFromBranch(branch)
        .filter((candidate) => candidate.id === entry.id && candidate.attempt < entry.attempt)
        .sort((a, b) => b.attempt - a.attempt)[0];
      if (!previous) throw new Error(`Unknown Task id: ${entry.id}`);
      if (entry.attempt !== previous.attempt + 1) throw new Error("Task resume attempt is not the next run attempt");
      if (previous.requestKind !== "agent" || entry.request.kind !== "agent") throw new Error("Only agent Tasks can be resumed");
      if (!terminal(runStatus(previous))) throw new Error("Task is still running and cannot be resumed");
      return launch(entry);
    },
    async ensure(id) {
      const launchEntry = findLaunch(observers?.branch() ?? [], id);
      const requestPath = runnerRequestPath(runDirectory(options.sessionDir, id), launchEntry.attempt);
      if (!fs.existsSync(requestPath)) throw new Error(`Run request for ${id} is unavailable`);
      if (!terminal(runStatus(launchEntry))) await launchRunnerAt(id, requestPath);
      if (observers) ensureWatcher(id);
      return receipt(launchEntry);
    },
    async status(id) {
      return statusResult(id);
    },
    async wait(id, timeoutMs, regex, signal, detachOnAbort = false) {
      const launchEntry = findLaunch(observers?.branch() ?? [], id);
      if (regex && launchEntry.requestKind !== "shell") throw new Error("Await regex is supported only for Shell tasks");
      if (timeoutMs !== undefined && (timeoutMs < 0 || !Number.isFinite(timeoutMs))) throw new Error("Await timeout must be a finite non-negative number");
      const directory = runDirectory(options.sessionDir, id);
      const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
      const stableRegex = regex
        ? compileSafeRegex(regex.source, "Await regex", regex.flags.replace(/[gy]/g, ""))
        : undefined;
      const key = attemptKey(id, launchEntry.attempt);
      completionWaits.add(key);

      return new Promise<AwaitResult>((resolve, reject) => {
        let settled = false;
        let watcher: fs.FSWatcher | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let poll: ReturnType<typeof setInterval> | undefined;
        const finish = (result: AwaitResult, terminalConsumed = false): void => {
          if (settled) return;
          settled = true;
          if (poll) clearInterval(poll);
          if (result.state !== "terminal" && !terminalConsumed) completionWaits.delete(key);
          watcher?.close();
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(result);
        };
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          if (poll) clearInterval(poll);
          completionWaits.delete(key);
          watcher?.close();
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        };
        const abort = (): void => {
          if (detachOnAbort) {
            const status = runStatus(findLaunch(observers?.branch() ?? [], id));
            return terminal(status)
              ? finish({ state: "terminal", id, status }, true)
              : finish({ state: "detached", id, status });
          }
          void store.interrupt(id).then(
            () => fail(new Error("Run wait was aborted")),
            (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
          );
        };
        const inspect = (): void => {
          if (settled) return;
          const status = runStatus(findLaunch(observers?.branch() ?? [], id));
          const records = readRecords(directory);
          if (stableRegex) {
            const match = records.shellLines.find((line) => regexMatchesLine(stableRegex, line.line));
            if (match) {
              const terminalConsumed = terminal(status);
              if (terminalConsumed) acknowledge(id, `${id}:${status.attempt}:completed`);
              return finish({ state: "matched", id, status, sequence: match.sequence, line: match.line }, terminalConsumed);
            }
          }
          if (terminal(status)) {
            acknowledge(id, `${id}:${status.attempt}:completed`);
            return finish({ state: "terminal", id, status }, true);
          }
          if (deadline !== undefined && Date.now() >= deadline) return finish({ state: "timeout", id, status });
        };

        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          // A pending tool call must keep a headless child alive: a non-persistent watcher and no timer
          // let Node exit with code 0 mid-wait, silently dropping the child's results.
          watcher = fs.watch(directory, { persistent: true }, inspect);
          watcher.on("error", fail);
          poll = setInterval(inspect, 2000);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (deadline !== undefined) timer = setTimeout(inspect, Math.max(0, deadline - Date.now()));
        inspect();
      });
    },
    async interrupt(id) {
      const launchEntry = findLaunch(observers?.branch() ?? [], id);
      if (terminal(runStatus(launchEntry))) return;
      const directory = runDirectory(options.sessionDir, id);
      const controlPath = path.join(directory, "control", `interrupt-${launchEntry.attempt}.json`);
      atomicJson(controlPath, { id, attempt: launchEntry.attempt, requestedAt: Date.now() });
    },
    transcript(id) {
      const launchEntry = findLaunch(observers?.branch() ?? [], id);
      return transcriptPath(id, launchEntry.owner.sessionFile);
    },
    outputLog(id) {
      return path.join(runDirectory(options.sessionDir, id), "output.log");
    },
    outputText(id) {
      try {
        return fs.readFileSync(path.join(runDirectory(options.sessionDir, id), "output.log"), "utf8");
      } catch {
        return "";
      }
    },
    finalOutput(id) {
      return finalAssistantOutput(runDirectory(options.sessionDir, id));
    },
    usage(id, attempt) {
      return readRecords(runDirectory(options.sessionDir, id)).usageByAttempt.get(attempt);
    },
    claimUsage(id, attempt) {
      const usage = readRecords(runDirectory(options.sessionDir, id)).usageByAttempt.get(attempt);
      if (!usage) return undefined;
      const notificationId = `usage:${attempt}`;
      const claimPath = acknowledgementPath(id, notificationId);
      fs.mkdirSync(path.dirname(claimPath), { recursive: true, mode: 0o700 });
      let descriptor: number;
      try {
        descriptor = fs.openSync(claimPath, "wx", 0o600);
      } catch (error) {
        if (isRecord(error) && error.code === "EEXIST") return undefined;
        throw error;
      }
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ notificationId, acknowledgedAt: Date.now() })}\n`);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      const directoryDescriptor = fs.openSync(path.dirname(claimPath), "r");
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
      return usage;
    },
    async reconcile(branch, notify, includeRunning) {
      await reconcile(branch, notify, includeRunning);
    },
    observe(input) {
      observers = { ...input, notificationsEnabled: input.notificationsEnabled ?? true };
      const branch = input.branch();
      for (const launchEntry of indexEntries(branch)) {
        ensureWatcher(launchEntry.id);
        void store.ensure(launchEntry.id).catch((error: unknown) => {
          input.onError(error instanceof Error ? error : new Error(String(error)));
        });
      }
      void reconcile(branch, input.notify, true).catch((error: unknown) => {
        input.onError(error instanceof Error ? error : new Error(String(error)));
      });
    },
    closeWatchers() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      observers = undefined;
    },
  };

  return store;
}
