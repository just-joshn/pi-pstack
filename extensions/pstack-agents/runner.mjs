import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { compileSafeRegex, regexMatchesLine } from "./regex-safety.js";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const terminalStates = new Set(["completed", "failed", "stopped"]);

function processBirth(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function processIsAlive(pid, birth) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const currentBirth = processBirth(pid);
  return currentBirth === undefined || birth === "unknown" || currentBirth === birth;
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
    }
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWrite(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  const descriptor = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  fsyncDirectory(directory);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function readMarker(markerPath) {
  try {
    const stats = fs.statSync(markerPath);
    return readJson(stats.isDirectory() ? path.join(markerPath, "owner.json") : markerPath);
  } catch {
    return undefined;
  }
}

function hasTerminalAttempt(runDirectory, attempt) {
  const status = readJson(path.join(runDirectory, "status.json"));
  return Boolean(status && terminalStates.has(status.state) && status.attempt === attempt);
}

function markerOwnerIsAlive(marker) {
  return Boolean(marker && typeof marker.pid === "number" && Number.isSafeInteger(marker.pid) && typeof marker.birth === "string" && processIsAlive(marker.pid, marker.birth));
}

function publishClaim(claimPath, owner) {
  const temporaryDirectory = `${claimPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
  try {
    atomicWrite(path.join(temporaryDirectory, "owner.json"), owner);
    fsyncDirectory(temporaryDirectory);
    try {
      fs.renameSync(temporaryDirectory, claimPath);
      fsyncDirectory(path.dirname(claimPath));
      return true;
    } catch (error) {
      if (!fs.existsSync(claimPath)) throw error;
      return false;
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function acquireRecoveryLock(lockPath, requestKey) {
  while (true) {
    const temporaryPath = `${lockPath}.tmp-${process.pid}-${randomUUID()}`;
    atomicWrite(temporaryPath, { pid: process.pid, birth: processBirth(process.pid) ?? "unknown", requestKey });
    try {
      fs.linkSync(temporaryPath, lockPath);
      fsyncDirectory(path.dirname(lockPath));
      return true;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }

    if (markerOwnerIsAlive(readJson(lockPath))) return false;
    const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, stalePath);
      fsyncDirectory(path.dirname(lockPath));
      fs.rmSync(stalePath, { force: true });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
}

function writeClaim(runDirectory, attempt, requestKey) {
  const attemptsDirectory = path.join(runDirectory, "attempts");
  const claimPath = path.join(attemptsDirectory, `${attempt}.claim`);
  const recoveryPath = path.join(attemptsDirectory, `${attempt}.recovered`);
  const recoveryLockPath = path.join(attemptsDirectory, `${attempt}.recovery-lock`);
  const owner = { pid: process.pid, birth: processBirth(process.pid) ?? "unknown", requestKey };
  fs.mkdirSync(attemptsDirectory, { recursive: true, mode: 0o700 });

  while (true) {
    if (hasTerminalAttempt(runDirectory, attempt)) return "active";
    if (fs.existsSync(recoveryPath)) {
      if (markerOwnerIsAlive(readMarker(recoveryPath))) return "active";
      if (!acquireRecoveryLock(recoveryLockPath, requestKey)) return "active";
      atomicWrite(recoveryPath, { ...owner, recoveredAt: Date.now() });
      return "recovered";
    }

    const claim = readMarker(claimPath);
    if (markerOwnerIsAlive(claim)) return "active";
    if (!fs.existsSync(claimPath)) {
      if (publishClaim(claimPath, owner)) return "claimed";
      continue;
    }

    if (!acquireRecoveryLock(recoveryLockPath, requestKey)) return "active";
    atomicWrite(recoveryPath, { ...owner, recoveredAt: Date.now() });
    return "recovered";
  }
}

function nextSequence(eventsPath) {
  let last = 0;
  try {
    for (const line of fs.readFileSync(eventsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (Number.isSafeInteger(event.sequence) && event.sequence > last) last = event.sequence;
      } catch {
      }
    }
  } catch {
  }
  return last;
}

function createRecorder(runDirectory) {
  const eventsPath = path.join(runDirectory, "events.jsonl");
  let sequence = nextSequence(eventsPath);
  return (event) => {
    const record = { sequence: ++sequence, at: Date.now(), ...event };
    const descriptor = fs.openSync(eventsPath, "a", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return record;
  };
}

function writeStatus(runDirectory, status, record) {
  atomicWrite(path.join(runDirectory, "status.json"), status);
  record(terminalStates.has(status.state) ? { type: "terminal", status } : { type: "status", status });
}

function statusStarting(request) {
  return { state: "starting", id: request.id, attempt: request.attempt, updatedAt: Date.now() };
}

function statusRunning(request, childPid) {
  const now = Date.now();
  return { state: "running", id: request.id, attempt: request.attempt, pid: childPid, startedAt: now, updatedAt: now };
}

function statusCompleted(request, stopReason) {
  return { state: "completed", id: request.id, attempt: request.attempt, exitCode: 0, stopReason, endedAt: Date.now() };
}

function statusFailed(request, exitCode, stopReason, error) {
  return { state: "failed", id: request.id, attempt: request.attempt, exitCode, stopReason, endedAt: Date.now(), ...(error ? { error } : {}) };
}

function statusStopped(request, signal) {
  return { state: "stopped", id: request.id, attempt: request.attempt, endedAt: Date.now(), ...(signal ? { signal } : {}) };
}

function signalRunGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch {
      }
    }
  }
}

function registerChildRun(parentRun, runDirectory, request) {
  if (parentRun === undefined) return undefined;
  if (!parentRun || typeof parentRun.directory !== "string" || !path.isAbsolute(parentRun.directory) || !Number.isSafeInteger(parentRun.attempt) || parentRun.attempt < 1) {
    throw new Error("Invalid parent run reference");
  }
  const registrationsDirectory = path.join(parentRun.directory, "children", String(parentRun.attempt));
  fs.mkdirSync(registrationsDirectory, { recursive: true, mode: 0o700 });
  const registrationPath = path.join(registrationsDirectory, `${request.id}.json`);
  atomicWrite(registrationPath, {
    id: request.id,
    attempt: request.attempt,
    pid: process.pid,
    birth: processBirth(process.pid) ?? "unknown",
    runDirectory,
  });
  if (fs.existsSync(path.join(registrationsDirectory, "closed"))) {
    fs.rmSync(registrationPath, { force: true });
    return false;
  }
  return registrationPath;
}

function stopChildRuns(runDirectory, attempt) {
  const registrationsDirectory = path.join(runDirectory, "children", String(attempt));
  fs.mkdirSync(registrationsDirectory, { recursive: true, mode: 0o700 });
  atomicWrite(path.join(registrationsDirectory, "closed"), { closedAt: Date.now() });
  let names;
  try {
    names = fs.readdirSync(registrationsDirectory);
  } catch {
    return;
  }

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const registrationPath = path.join(registrationsDirectory, name);
    const registration = readJson(registrationPath);
    if (!registration || typeof registration !== "object" || typeof registration.id !== "string" || typeof registration.pid !== "number" || !Number.isSafeInteger(registration.pid) || typeof registration.birth !== "string" || typeof registration.runDirectory !== "string" || !path.isAbsolute(registration.runDirectory) || !Number.isSafeInteger(registration.attempt) || registration.attempt < 1) {
      fs.rmSync(registrationPath, { force: true });
      continue;
    }
    if (hasTerminalAttempt(registration.runDirectory, registration.attempt) || !markerOwnerIsAlive(registration)) {
      fs.rmSync(registrationPath, { force: true });
      continue;
    }

    stopChildRuns(registration.runDirectory, registration.attempt);
    try {
      atomicWrite(path.join(registration.runDirectory, "control", `interrupt-${registration.attempt}.json`), {
        id: registration.id,
        attempt: registration.attempt,
        requestedAt: Date.now(),
      });
    } catch {
    }
    signalRunGroup(registration.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    const watcher = setInterval(() => {
      if (!markerOwnerIsAlive(registration)) {
        clearInterval(watcher);
        return;
      }
      if (Date.now() >= deadline) {
        signalRunGroup(registration.pid, "SIGKILL");
        clearInterval(watcher);
      }
    }, 100);
  }
}

function readText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function finalAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const event = messages[index];
    if (event && typeof event === "object" && event.role === "assistant") return readText(event);
  }
  return "";
}

function runAgent(request, runDirectory, record, finish) {
  const agent = request.request;
  const workingDirectory = agent.worktree?.path ?? agent.cwd;
  const systemPromptPath = path.join(runDirectory, `system-prompt-${request.attempt}.md`);
  const context = agent.projectContext.map((file) => `Context from ${file.path}\n\n${file.content}`).join("\n\n");
  const skillLocation = agent.declaredSkill ? `The \`${agent.declaredSkill.name}\` skill's \`SKILL.md\` is at \`${agent.declaredSkill.file}\`.` : "";
  const systemPrompt = [context, agent.agent.systemPrompt, skillLocation].filter(Boolean).join("\n\n");
  const cliArgs = [
    ...request.piArgsPrefix,
    "--mode", "json",
    "--session", request.transcript,
    "--model", agent.model,
    "--tools", agent.tools.join(","),
    "--no-extensions",
    ...agent.extensionPaths.flatMap((extensionPath) => ["-e", extensionPath]),
    "--no-context-files",
  ];
  if (agent.thinkingLevel) cliArgs.push("--thinking", agent.thinkingLevel);
  if (!agent.agent.inheritSkills) cliArgs.push("--no-skills");
  if (systemPrompt.trim()) {
    fs.writeFileSync(systemPromptPath, systemPrompt, { mode: 0o600 });
    cliArgs.push(agent.agent.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", systemPromptPath);
  }
  cliArgs.push("--", ...agent.attachments.map((attachment) => `@${attachment}`), `${agent.description}: ${agent.prompt}`);

  const child = spawn(request.piCommand, cliArgs, {
    cwd: workingDirectory,
    detached: false,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PSTACK_AGENTS_DEPTH: String(agent.depth),
      PSTACK_AGENTS_AGENT: agent.agent.name,
      PSTACK_AGENTS_NESTING_ALLOWED: String(agent.agent.allowNestedSubagents),
      PSTACK_AGENTS_RUN_ID: request.id,
      PSTACK_AGENTS_PARENT_RUN_DIRECTORY: runDirectory,
      PSTACK_AGENTS_PARENT_RUN_ATTEMPT: String(request.attempt),
    },
  });

  const messages = [];
  let stopReason;
  let errorMessage;
  let stdoutBuffer = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrChunks = [];
  const stderrPath = path.join(runDirectory, `stderr-${request.attempt}.log`);
  const baseStatus = statusStarting(request);
  writeStatus(runDirectory, baseStatus, record);
  writeStatus(runDirectory, statusRunning(request, child.pid ?? process.pid), record);

  const processLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "message_end" && event.message && typeof event.message === "object") {
      record({ type: "message", event: event.message });
      if (event.message.role === "assistant") {
        messages.push(event.message);
        if (typeof event.message.stopReason === "string") stopReason = event.message.stopReason;
        if (typeof event.message.errorMessage === "string") errorMessage = event.message.errorMessage;
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += stdoutDecoder.write(chunk);
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });
  child.stdout.on("end", () => {
    stdoutBuffer += stdoutDecoder.end();
    if (stdoutBuffer) processLine(stdoutBuffer);
  });
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.on("error", (error) => {
    errorMessage = error.message;
  });
  let interrupted = false;
  let killTimer;
  const interruptPath = path.join(runDirectory, "control", `interrupt-${request.attempt}.json`);
  const interruptWatcher = setInterval(() => {
    if (!interrupted && fs.existsSync(interruptPath)) {
      interrupted = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }
  }, 100);

  child.on("close", (code, signal) => {
    clearInterval(interruptWatcher);
    if (killTimer) clearTimeout(killTimer);
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (stderr) fs.writeFileSync(stderrPath, stderr, { mode: 0o600 });
    const output = finalAssistantText(messages);
    if (interrupted || signal === "SIGTERM" || signal === "SIGINT") return finish(statusStopped(request, signal ?? "SIGTERM"), output);
    if (code !== 0 || stopReason === "error" || stopReason === "aborted" || stopReason === "toolUse" || !messages.length) {
      const reason = stopReason === "aborted" ? "aborted" : code !== 0 ? "signal" : "error";
      const failure = stopReason === "toolUse"
        ? "Child Pi exited while a tool call was pending"
        : "Child Pi exited without a final assistant response";
      return finish(statusFailed(request, code && code !== 0 ? code : 1, reason, (errorMessage ?? stderr.trim()) || failure), output);
    }
    finish(statusCompleted(request, stopReason ?? "end"), output);
  });

  return child;
}

function runShell(request, runDirectory, record, finish, registerStop) {
  const shell = request.request;
  let notification;
  try {
    notification = shell.outputNotification ? compileSafeRegex(shell.outputNotification, "Shell output_notification") : undefined;
  } catch (error) {
    finish(statusFailed(request, 1, "error", error instanceof Error ? error.message : String(error)), "");
    return undefined;
  }
  const child = spawn(shell.command, { cwd: shell.cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let lineSequence = 0;
  let interrupted = false;
  let timedOut = false;
  let spawnError;
  const buffers = { stdout: "", stderr: "" };
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const outputPath = path.join(runDirectory, "output.log");
  const outputDescriptor = fs.openSync(outputPath, "a", 0o600);
  const timers = [];
  let killTimer;

  const emitLine = (stream, line) => {
    const matches = notification ? regexMatchesLine(notification, line) : false;
    const lineEvent = { type: "shell-line", lineSequence: ++lineSequence, stream, line };
    record({ ...lineEvent, notificationMatch: matches });
    fs.writeFileSync(outputDescriptor, `${line}\n`);
    fs.fsyncSync(outputDescriptor);
  };

  const consume = (stream, chunk) => {
    buffers[stream] += decoders[stream].write(chunk);
    const lines = buffers[stream].split("\n");
    buffers[stream] = lines.pop() ?? "";
    for (const line of lines) emitLine(stream, line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  const signalGroup = (signal) => signalProcessGroup(child, signal);
  const terminate = (signal) => {
    interrupted = true;
    signalGroup(signal);
    if (signal !== "SIGKILL" && !killTimer) killTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
  };
  const requestTimeout = () => {
    timedOut = true;
    signalGroup("SIGTERM");
    if (!killTimer) killTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
  };
  registerStop(terminate);

  const interruptPath = path.join(runDirectory, "control", `interrupt-${request.attempt}.json`);
  const interruptWatcher = setInterval(() => {
    if (!interrupted && fs.existsSync(interruptPath)) terminate("SIGTERM");
  }, 100);
  timers.push(interruptWatcher);

  if (shell.timeout !== undefined) timers.push(setTimeout(requestTimeout, shell.timeout));
  if (shell.hardTimeout !== undefined) timers.push(setTimeout(() => {
    timedOut = true;
    signalGroup("SIGKILL");
  }, shell.hardTimeout));

  const now = Date.now();
  writeStatus(runDirectory, { state: "starting", id: request.id, attempt: request.attempt, updatedAt: now }, record);
  writeStatus(runDirectory, { state: "running", id: request.id, attempt: request.attempt, pid: child.pid ?? process.pid, startedAt: now, updatedAt: now }, record);
  child.stdout.on("data", (chunk) => consume("stdout", chunk));
  child.stderr.on("data", (chunk) => consume("stderr", chunk));
  child.on("error", (error) => {
    spawnError = error.message;
    record({ type: "message", event: { type: "shell-error", message: error.message } });
  });
  child.on("close", (code, signal) => {
    for (const timer of timers) clearTimeout(timer);
    clearInterval(interruptWatcher);
    if (killTimer) clearTimeout(killTimer);
    for (const stream of ["stdout", "stderr"]) {
      buffers[stream] += decoders[stream].end();
      if (buffers[stream]) emitLine(stream, buffers[stream]);
    }
    fs.fsyncSync(outputDescriptor);
    fs.closeSync(outputDescriptor);
    if (interrupted) return finish(statusStopped(request, signal ?? "SIGTERM"), fs.readFileSync(outputPath, "utf8"));
    if (spawnError) return finish(statusFailed(request, code ?? 1, "error", spawnError), fs.readFileSync(outputPath, "utf8"));
    if (timedOut || code !== 0) {
      const reason = signal ? "signal" : "error";
      return finish(statusFailed(request, code ?? 1, reason, timedOut ? "Shell command timed out" : undefined), fs.readFileSync(outputPath, "utf8"));
    }
    finish(statusCompleted(request, "exit"), fs.readFileSync(outputPath, "utf8"));
  });

  return child;
}

// Compare real paths: a package under a symlinked directory (macOS /tmp, npm prefixes) reports a different argv[1].
export function isEntryPoint(argvPath) {
  if (!argvPath) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(argvPath);
  } catch {
    return false;
  }
}

async function main() {
  const runDirectory = path.resolve(process.argv[2] ?? "");
  const requestPath = path.resolve(process.argv[3] ?? "");
  const request = readJson(requestPath);
  if (!request || request.version !== 1 || typeof request.id !== "string" || !Number.isSafeInteger(request.attempt) || typeof request.requestKey !== "string") {
    throw new Error("Invalid pstack-agents runner request");
  }
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const claim = writeClaim(runDirectory, request.attempt, request.requestKey);
  if (claim === "active") return;
  const record = createRecorder(runDirectory);
  if (claim === "recovered") {
    writeStatus(runDirectory, statusFailed(request, 1, "signal", "Runner exited before terminal status; the attempt was not replayed to avoid duplicating side effects"), record);
    return;
  }
  const parentRegistrationPath = registerChildRun(request.parentRun, runDirectory, request);
  if (parentRegistrationPath === false) {
    writeStatus(runDirectory, statusStopped(request), record);
    return;
  }
  let child;
  let stopChild;
  let finished = false;
  const finish = (status, output) => {
    if (finished) return;
    finished = true;
    stopChildRuns(runDirectory, request.attempt);
    writeStatus(runDirectory, status, record);
    if (parentRegistrationPath) fs.rmSync(parentRegistrationPath, { force: true });
  };
  process.on("SIGTERM", () => {
    if (stopChild && !finished) stopChild("SIGTERM");
    else if (child && !finished) child.kill("SIGTERM");
  });
  process.on("SIGINT", () => {
    if (stopChild && !finished) stopChild("SIGINT");
    else if (child && !finished) child.kill("SIGINT");
  });
  if (request.request.kind === "agent") {
    child = runAgent(request, runDirectory, record, finish);
    return;
  }
  if (request.request.kind === "shell") {
    child = runShell(request, runDirectory, record, finish, (stop) => { stopChild = stop; });
    return;
  }
  throw new Error(`Unsupported pstack-agents request kind: ${request.request.kind}`);
}

if (isEntryPoint(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
