import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  NOTIFICATION_TYPE,
  RUN_ENTRY_TYPE,
  createRunStore,
  deliveredNotificationIds,
  launchEntriesFromBranch,
  parseShellInput,
  recordLaunch,
  shouldNotify,
  type AgentRunRequest,
  type LaunchEntry,
  type ShellOutputNotificationConfig,
  type RunNotification,
} from "./runs.ts";
import { parseAgentDefinition } from "./agents.ts";
import { parseRunId } from "./contracts.ts";

const runnerPath = fileURLToPath(new URL("./runner.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function testRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-agents-runs-"));
  roots.push(root);
  return root;
}

function appendEntry(branch: SessionEntry[], customType: string, data: unknown): void {
  const entry: SessionEntry = {
    type: "custom",
    id: `entry-${branch.length + 1}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  };
  branch.push(entry);
}

function appendNotice(branch: SessionEntry[], notification: RunNotification): void {
  const entry: SessionEntry = {
    type: "custom_message",
    id: `notice-${branch.length + 1}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    customType: NOTIFICATION_TYPE,
    content: notification.event,
    display: true,
    details: { notificationId: notification.notificationId },
  };
  branch.push(entry);
}

function appendToolResult(branch: SessionEntry[], details: JsonValue): void {
  branch.push({
    type: "message",
    id: `result-${branch.length + 1}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: `call-${branch.length + 1}`,
      toolName: "Task",
      content: [{ type: "text", text: "completed" }],
      details,
      isError: false,
      timestamp: Date.now(),
    },
  });
}

function testHarness(root: string) {
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, "parent.jsonl");
  const fakePi = path.join(root, "fake-pi.mjs");
  fs.writeFileSync(fakePi, [
    'const prompt = process.argv.at(-1) ?? "empty";',
    'const message = { role: "assistant", content: [{ type: "text", text: prompt }], stopReason: "stop" };',
    'process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\\n`);',
  ].join("\n"));
  const branch: SessionEntry[] = [];
  const storeOptions = {
    sessionDir,
    sessionFile,
    sessionId: "parent-session",
    runnerPath,
    piCommand: process.execPath,
    piArgsPrefix: [fakePi],
    cwd: root,
  };
  const store = createRunStore(storeOptions);
  const pi = { appendEntry: (customType: string, data?: unknown) => appendEntry(branch, customType, data) };
  return { sessionDir, sessionFile, branch, store, storeOptions, pi, fakePi };
}

function processRows(): Array<{ pid: number; parentPid: number; groupId: number; state: string; command: string }> {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), groupId: Number(match[3]), state: match[4], command: match[5] }] : [];
  });
}

function processTree(rootPid: number) {
  const rows = processRows();
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.parentPid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => pids.has(row.pid));
}

async function waitForShellRun(store: ReturnType<typeof createRunStore>, id: LaunchEntry["id"]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await store.status(id);
    if (status.state === "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Shell ${id} did not enter the running state`);
}

async function waitForShellTerminal(store: ReturnType<typeof createRunStore>, id: LaunchEntry["id"]) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await store.status(id);
    if (status.state === "completed" || status.state === "failed" || status.state === "stopped") return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Shell ${id} did not reach a terminal state`);
}

function isSleepProcess(row: ReturnType<typeof processRows>[number]): boolean {
  return path.basename(row.command.trim().split(/\s+/, 1)[0] ?? "") === "sleep" && /\s300(?:\s|$)/.test(row.command);
}

async function waitForShellDescendants(rootPid: number) {
  let latest: ReturnType<typeof processTree> = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const descendants = processTree(rootPid).filter((row) => isSleepProcess(row) && !row.state.startsWith("Z"));
    if (descendants.length > latest.length) latest = descendants;
    if (latest.length >= 2) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return latest;
}

async function waitForProcessIdsToExit(pids: readonly number[]): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const live = processRows().filter((row) => pids.includes(row.pid) && !row.state.startsWith("Z"));
    if (live.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function killPids(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
}

function killProcessGroups(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
    }
  }
  killPids(pids);
}

function owner(sessionFile: string, toolCallId: string) {
  return {
    sessionId: "parent-session",
    sessionFile,
    branchLeafAtLaunch: null,
    toolCallId,
    depth: 0,
  };
}

let testIdCounter = 0;

function nextTestId(store: ReturnType<typeof createRunStore>) {
  return store.idForRequestKey(`test-run-${++testIdCounter}`);
}

function shellEntry(store: ReturnType<typeof createRunStore>, sessionFile: string, command: string, options: {
  background?: boolean;
  outputNotification?: ShellOutputNotificationConfig;
  timeout?: number;
} = {}): LaunchEntry {
  const launchOwner = owner(sessionFile, `shell-call-${nextTestId(store)}`);
  return {
    kind: "launch",
    id: nextTestId(store),
    attempt: 1,
    requestKey: store.requestKey(launchOwner),
    owner: launchOwner,
    request: {
      kind: "shell",
      command,
      cwd: path.dirname(sessionFile),
      outputNotification: options.outputNotification,
      timeout: options.timeout,
    },
    runInBackground: options.background ?? false,
    createdAt: Date.now(),
  };
}

function agentRequest(cwd: string, prompt: string): AgentRunRequest {
  const agent = parseAgentDefinition(
    "---\nname: test-agent\ndescription: Test-only agent\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\n---\n",
    path.join(cwd, "agent.md"),
    "user",
  );
  if (!agent) throw new Error("Failed to create test agent definition");
  return {
    kind: "agent",
    description: "Run a test agent",
    agent,
    prompt,
    model: "openai-codex/gpt-6-luna:low",
    readonly: true,
    cwd,
    attachments: [],
    tools: ["read"],
    extensionPaths: [],
    depth: 1,
    projectContext: [],
    environment: "local",
  };
}

describe("Shell request parsing", () => {
  test("resolves an existing working directory and retains timeout and notification settings", () => {
    const root = testRoot();
    expect(parseShellInput({
      command: "printf READY",
      working_directory: ".",
      timeout: 1500,
      hard_timeout: 3000,
      is_background: true,
      output_notification: "READY",
    }, root)).toEqual({
      request: {
        kind: "shell",
        command: "printf READY",
        cwd: root,
        outputNotification: { pattern: "READY", notificationLimit: 100 },
        timeout: 1500,
        hardTimeout: 3000,
      },
      runInBackground: true,
    });
  });

  test("normalizes regex shorthand and Cursor output-notification settings", () => {
    const root = testRoot();
    expect(parseShellInput({ command: "printf READY", output_notification: "READY" }, root).request.outputNotification).toEqual({
      pattern: "READY",
      notificationLimit: 100,
    });
    expect(parseShellInput({
      command: "printf READY",
      output_notification: { pattern: "READY", reason: "watch release", debounce: 0.25, notification_limit: 7 },
    }, root).request.outputNotification).toEqual({
      pattern: "READY",
      reason: "watch release",
      debounce: 0.25,
      notificationLimit: 7,
    });
  });

  test("rejects output-notification patterns longer than 500 characters", () => {
    const root = testRoot();
    expect(() => parseShellInput({ command: "true", output_notification: "R".repeat(501) }, root)).toThrow("500 characters");
    expect(() => parseShellInput({ command: "true", output_notification: { pattern: "R".repeat(501) } }, root)).toThrow("500 characters");
  });

  test("rejects empty commands, invalid and unsafe regexes, and nonexistent directories", () => {
    const root = testRoot();
    expect(() => parseShellInput({ command: " " }, root)).toThrow("non-empty command");
    expect(() => parseShellInput({ command: "true", output_notification: "[" }, root)).toThrow("valid regular expression");
    expect(() => parseShellInput({ command: "true", output_notification: "(a+)+$" }, root)).toThrow("unsafe regular expression");
    expect(() => parseShellInput({ command: "true", working_directory: "missing" }, root)).toThrow("does not exist");
  });
});

describe("durable run store", () => {
  test("an explicit wait consumes a background completion before the watcher notifies", async () => {
    const root = testRoot();
    const { sessionFile, branch, store, storeOptions, pi } = testHarness(root);
    const entry = shellEntry(store, sessionFile, "sleep 0.1; printf DONE", { background: true });
    store.prepare(entry);
    recordLaunch(pi, entry);
    const notifications: RunNotification[] = [];
    const notify = (notification: RunNotification) => notifications.push(notification);
    store.observe({ branch: () => branch, notify, onChange: () => {}, onError: (error) => { throw error; } });

    try {
      await store.start(entry);
      const result = await store.wait(entry.id, 5000);
      await store.reconcile(branch, notify, false);
      const restartedStore = createRunStore(storeOptions);
      try {
        await restartedStore.reconcile(branch, notify, false);
      } finally {
        restartedStore.closeWatchers();
      }

      expect(result).toMatchObject({ state: "terminal", status: { state: "completed", attempt: 1 } });
      expect(notifications.filter((notification) => notification.event === "completed")).toEqual([]);
    } finally {
      store.closeWatchers();
    }
  });

  test("a declared skill is named in the child system prompt and the prompt stays unprefixed, with or without attachments", async () => {
    const root = testRoot();
    const { sessionFile, branch, store, pi, fakePi } = testHarness(root);
    fs.writeFileSync(fakePi, [
      'const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(process.argv.slice(2)) }], stopReason: "end" };',
      'process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\\n`);',
    ].join("\n"));
    const agent = parseAgentDefinition([
      "---",
      "name: custom-agent",
      "description: Test-only agent",
      "skills: poteto-mode",
      "inheritProjectContext: false",
      "inheritGlobalContext: false",
      "inheritSkills: true",
      "---",
    ].join("\n"), path.join(root, "agent.md"), "user");
    if (!agent) throw new Error("Failed to create a skill-declaring test agent");
    const attachment = path.join(root, "note.txt");
    fs.writeFileSync(attachment, "attached\n");
    const launchOwner = owner(sessionFile, "poteto-skill-call");
    const entry: LaunchEntry = {
      kind: "launch",
      id: nextTestId(store),
      attempt: 1,
      requestKey: store.requestKey(launchOwner),
      owner: launchOwner,
      request: {
        ...agentRequest(root, "Report your CLI arguments."),
        agent,
        attachments: [attachment],
        declaredSkill: { name: "poteto-mode", file: "/pkg/skills/poteto-mode/SKILL.md" },
      },
      runInBackground: false,
      createdAt: Date.now(),
    };
    store.prepare(entry);
    recordLaunch(pi, entry);
    store.observe({ branch: () => branch, notify: () => {}, onChange: () => {}, onError: (error) => { throw error; } });

    try {
      await store.start(entry);
      await store.wait(entry.id, 5000);
      const rawArgs = store.finalOutput(entry.id);
      if (!rawArgs) throw new Error("Fake Pi returned no command arguments");
      const args: unknown = JSON.parse(rawArgs);
      if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string")) {
        throw new Error("Fake Pi returned invalid command arguments");
      }
      expect(args).not.toContain("--skill");
      expect(args).not.toContain("--no-skills");
      expect(args.at(-1)).toBe("Run a test agent: Report your CLI arguments.");
      expect(args.at(-2)).toBe(`@${attachment}`);
      const promptFile = args[args.indexOf("--append-system-prompt") + 1];
      if (!promptFile) throw new Error("Child received no appended system prompt");
      expect(fs.readFileSync(promptFile, "utf8")).toContain("The `poteto-mode` skill's `SKILL.md` is at `/pkg/skills/poteto-mode/SKILL.md`.");
    } finally {
      store.closeWatchers();
    }
  });

  test("sets the selected agent name in the child environment", async () => {
    const root = testRoot();
    const { sessionFile, branch, store, pi, fakePi } = testHarness(root);
    fs.writeFileSync(fakePi, [
      'const message = { role: "assistant", content: [{ type: "text", text: process.env.PSTACK_AGENTS_AGENT ?? "missing" }], stopReason: "end" };',
      'process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\\n`);',
    ].join("\n"));
    const launchOwner = owner(sessionFile, "agent-env-call");
    const entry: LaunchEntry = {
      kind: "launch",
      id: nextTestId(store),
      attempt: 1,
      requestKey: store.requestKey(launchOwner),
      owner: launchOwner,
      request: agentRequest(root, "Report your agent environment."),
      runInBackground: false,
      createdAt: Date.now(),
    };
    store.prepare(entry);
    recordLaunch(pi, entry);
    const previousAgent = process.env.PSTACK_AGENTS_AGENT;
    process.env.PSTACK_AGENTS_AGENT = "parent-agent";

    try {
      store.observe({ branch: () => branch, notify: () => {}, onChange: () => {}, onError: (error) => { throw error; } });
      await store.start(entry);
      const result = await store.wait(entry.id, 5000);
      expect(result).toMatchObject({ state: "terminal", status: { state: "completed" } });
      expect(store.finalOutput(entry.id)).toBe("test-agent");
    } finally {
      store.closeWatchers();
      if (previousAgent === undefined) delete process.env.PSTACK_AGENTS_AGENT;
      else process.env.PSTACK_AGENTS_AGENT = previousAgent;
    }
  });

  test("runs Shell detached, waits for a matching line and exit, and deduplicates acknowledged notices", async () => {
    const root = testRoot();
    const { sessionDir, sessionFile, branch, store, pi } = testHarness(root);
    const entry = shellEntry(store, sessionFile, "printf 'READY\\n'; sleep 1; printf 'DONE\\n'", {
      background: true,
      outputNotification: { pattern: "READY", notificationLimit: 100 },
    });
    store.prepare(entry);
    recordLaunch(pi, entry);
    const notifications: RunNotification[] = [];
    store.observe({
      branch: () => branch,
      notify: (notification) => {
        notifications.push(notification);
        appendNotice(branch, notification);
      },
      onChange: () => {},
      onError: (error) => { throw error; },
    });

    await store.start(entry);
    const matched = await store.wait(entry.id, 5000, /READY/);
    expect(matched).toMatchObject({ state: "matched", id: entry.id, status: { state: "running" }, line: "READY" });
    const ended = await waitForShellTerminal(store, entry.id);
    expect(ended).toMatchObject({ state: "completed", attempt: 1, exitCode: 0 });
    await store.reconcile(branch, (notification) => {
      notifications.push(notification);
      appendNotice(branch, notification);
    }, false);
    expect(store.outputText(entry.id)).toBe("READY\nDONE\n");
    expect(notifications.map((notification) => notification.event)).toContain("output");
    expect(notifications.map((notification) => notification.event)).toContain("completed");
    expect(deliveredNotificationIds(branch)).toEqual(new Set(notifications.map((notification) => notification.notificationId)));

    const ackDirectory = path.join(sessionDir, "pstack-agents", entry.id, "acks");
    expect(fs.readdirSync(ackDirectory).length).toBe(notifications.length);
    const countBeforeRetry = notifications.length;
    await store.reconcile(branch, (notification) => notifications.push(notification), true);
    expect(notifications).toHaveLength(countBeforeRetry);
    store.closeWatchers();
  });

  test("an aborted Await detaches and the run finishes; an aborted foreground wait interrupts", async () => {
    const root = testRoot();
    const { sessionFile, branch, store, pi } = testHarness(root);
    store.observe({ branch: () => branch, notify: (notification) => appendNotice(branch, notification), onChange: () => {}, onError: (error) => { throw error; } });
    const detached = shellEntry(store, sessionFile, "sleep 1; printf 'DONE\\n'", { background: true });
    store.prepare(detached);
    recordLaunch(pi, detached);
    await store.start(detached);
    const awaitAbort = new AbortController();
    const awaiting = store.wait(detached.id, 5000, undefined, awaitAbort.signal, true);
    awaitAbort.abort();
    const detachedResult = await awaiting;
    expect(detachedResult).toMatchObject({ state: "detached", id: detached.id });
    expect(["starting", "running"]).toContain(detachedResult.status.state);
    expect(await waitForShellTerminal(store, detached.id)).toMatchObject({ state: "completed", exitCode: 0 });
    await expect(store.wait(detached.id, 5000, undefined, awaitAbort.signal, true)).resolves.toMatchObject({
      state: "terminal",
      status: { state: "completed" },
    });

    const foreground = shellEntry(store, sessionFile, "sleep 30", { background: true });
    store.prepare(foreground);
    recordLaunch(pi, foreground);
    await store.start(foreground);
    const taskAbort = new AbortController();
    const waiting = store.wait(foreground.id, 5000, undefined, taskAbort.signal);
    taskAbort.abort();
    await expect(waiting).rejects.toThrow("Run wait was aborted");
    expect(await waitForShellTerminal(store, foreground.id)).toMatchObject({ state: "stopped" });
    store.closeWatchers();
  });

  test("does not execute one stable launch twice when start is retried concurrently", async () => {
    const root = testRoot();
    const { sessionFile, branch, store, pi } = testHarness(root);
    const marker = path.join(root, "executions.txt");
    const entry = shellEntry(store, sessionFile, `printf x >> '${marker}'`, { background: true });
    store.prepare(entry);
    recordLaunch(pi, entry);
    await Promise.all([store.start(entry), store.start(entry)]);
    store.observe({ branch: () => branch, notify: () => {}, onChange: () => {}, onError: (error) => { throw error; } });
    const result = await store.wait(entry.id, 5000);
    expect(result).toMatchObject({ state: "terminal", status: { state: "completed" } });
    expect(fs.readFileSync(marker, "utf8")).toBe("x");
    store.closeWatchers();
  });

  test("interrupts a foreground Shell without applying an implicit timeout", async () => {
    const root = testRoot();
    const { sessionFile, branch, store, pi } = testHarness(root);
    const entry = shellEntry(store, sessionFile, "exec sleep 30");
    store.prepare(entry);
    recordLaunch(pi, entry);
    store.observe({ branch: () => branch, notify: () => {}, onChange: () => {}, onError: (error) => { throw error; } });
    await store.start(entry);
    await store.interrupt(entry.id);

    const result = await store.wait(entry.id, 5000);
    expect(result).toMatchObject({ state: "terminal", status: { state: "stopped" } });
    store.closeWatchers();
  });

  for (const stop of ["interrupt", "timeout", "runner-signal"] as const) {
    test(`kills Shell descendants on ${stop} and writes terminal status`, async () => {
      const root = testRoot();
      const { sessionDir, sessionFile, branch, store, pi } = testHarness(root);
      const entry = shellEntry(store, sessionFile, "sh -c 'sleep 300 & sleep 300'", {
        background: true,
        timeout: stop === "timeout" ? 200 : undefined,
      });
      store.prepare(entry);
      recordLaunch(pi, entry);
      await store.start(entry);
      store.observe({ branch: () => branch, notify: () => {}, onChange: () => {}, onError: (error) => { throw error; } });
      const running = await waitForShellRun(store, entry.id);
      const descendants = await waitForShellDescendants(running.pid);
      const sleepPids = descendants.map((row) => row.pid);
      const claimOwner = JSON.parse(fs.readFileSync(path.join(sessionDir, "pstack-agents", entry.id, "attempts", "1.claim", "owner.json"), "utf8"));

      try {
        expect(sleepPids).toHaveLength(2);
        if (stop === "interrupt") await store.interrupt(entry.id);
        if (stop === "runner-signal") process.kill(claimOwner.pid, "SIGTERM");
        const result = await store.wait(entry.id, 1500);
        expect(result).toMatchObject({ state: "terminal", status: { state: stop === "timeout" ? "failed" : "stopped" } });
        expect(descendants.every((row) => row.groupId === running.pid)).toBe(true);
        const liveSleepPids = processRows().filter((row) => sleepPids.includes(row.pid) && isSleepProcess(row) && !row.state.startsWith("Z"));
        expect(liveSleepPids).toEqual([]);
      } finally {
        killPids([running.pid, ...sleepPids]);
        store.closeWatchers();
      }
    });
  }

  test("fails an owner that exits after toolUse and stops its nested run", async () => {
    const root = testRoot();
    const { sessionDir, sessionFile, branch, store, pi, fakePi } = testHarness(root);
    const launchOwner = owner(sessionFile, "owner-tool-call");
    const requestKey = store.requestKey(launchOwner);
    const id = store.idForRequestKey(requestKey);
    const parentRunDirectory = path.join(sessionDir, "pstack-agents", id);
    const nestedId = "33333333-3333-4333-8333-333333333333";
    const nestedDirectory = path.join(parentRunDirectory, "nested-runs", nestedId);
    const nestedPidsFile = path.join(root, "nested-pids.json");
    fs.writeFileSync(fakePi, [
      'import { spawn } from "node:child_process";',
      'import * as fs from "node:fs";',
      'import * as path from "node:path";',
      `const runnerPath = ${JSON.stringify(runnerPath)};`,
      `const nestedDirectory = ${JSON.stringify(nestedDirectory)};`,
      `const nestedPidsFile = ${JSON.stringify(nestedPidsFile)};`,
      `const nestedId = ${JSON.stringify(nestedId)};`,
      'const requestPath = path.join(nestedDirectory, "requests", "1.json");',
      'fs.mkdirSync(path.dirname(requestPath), { recursive: true });',
      'fs.writeFileSync(requestPath, JSON.stringify({',
      '  version: 1,',
      '  id: nestedId,',
      '  attempt: 1,',
      '  requestKey: "nested-shell",',
      '  request: { kind: "shell", command: "exec sleep 300", cwd: process.cwd() },',
      '  transcript: "",',
      '  piCommand: process.execPath,',
      '  piArgsPrefix: [],',
      '  parentRun: process.env.PSTACK_AGENTS_PARENT_RUN_DIRECTORY ? { directory: process.env.PSTACK_AGENTS_PARENT_RUN_DIRECTORY, attempt: Number(process.env.PSTACK_AGENTS_PARENT_RUN_ATTEMPT) } : undefined,',
      '}));',
      'const child = spawn(process.execPath, [runnerPath, nestedDirectory, requestPath], { detached: true, stdio: "ignore" });',
      'child.unref();',
      'let shellPid;',
      'for (let attempt = 0; attempt < 1000; attempt++) {',
      '  try {',
      '    const status = JSON.parse(fs.readFileSync(path.join(nestedDirectory, "status.json"), "utf8"));',
      '    if (status.state === "running") { shellPid = status.pid; break; }',
      '  } catch {}',
      '  await new Promise((resolve) => setTimeout(resolve, 10));',
      '}',
      'if (typeof shellPid !== "number") process.exit(2);',
      'fs.writeFileSync(nestedPidsFile, JSON.stringify([child.pid, shellPid]));',
      'const message = { role: "assistant", content: [{ type: "text", text: "nested run started" }], stopReason: "toolUse" };',
      'process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\\n`);',
    ].join("\n"));

    const entry: LaunchEntry = {
      kind: "launch",
      id,
      attempt: 1,
      requestKey,
      owner: launchOwner,
      request: agentRequest(root, "Start a nested Shell and return while it is running"),
      runInBackground: true,
      createdAt: Date.now(),
    };
    store.prepare(entry);
    recordLaunch(pi, entry);
    store.observe({ branch: () => branch, notify: () => {}, onChange: () => {}, onError: (error) => { throw error; } });
    const nestedPids: number[] = [];

    try {
      await store.start(entry);
      const result = await store.wait(entry.id, 10000);
      const rawPids: unknown = JSON.parse(fs.readFileSync(nestedPidsFile, "utf8"));
      if (Array.isArray(rawPids)) nestedPids.push(...rawPids.filter((pid): pid is number => typeof pid === "number"));

      expect(result).toMatchObject({
        state: "terminal",
        status: { state: "failed", exitCode: 1, stopReason: "error", error: "Child Pi exited while a tool call was pending" },
      });
      expect(nestedPids).toHaveLength(2);
      expect(await waitForProcessIdsToExit(nestedPids)).toBe(true);
    } finally {
      store.closeWatchers();
      killProcessGroups(nestedPids);
    }
  });

  test("preserves an agent transcript across resume attempts and writes file-only output", async () => {
    const root = testRoot();
    const { sessionFile, branch, store, pi, fakePi } = testHarness(root);
    fs.writeFileSync(fakePi, [
      'const attempt = Number(process.env.PSTACK_AGENTS_PARENT_RUN_ATTEMPT);',
      'const usages = attempt === 1 ? [',
      '  { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 6, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } },',
      '  { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 60, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } },',
      '] : [',
      '  { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, totalTokens: 600, cost: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 } },',
      '  { input: 1000, output: 2000, cacheRead: 3000, cacheWrite: 4000, totalTokens: 6000, cost: { input: 100, output: 200, cacheRead: 300, cacheWrite: 400, total: 1000 } },',
      '];',
      'for (const [index, usage] of usages.entries()) {',
      '  const message = { role: "assistant", content: [{ type: "text", text: index === 1 ? process.argv.at(-1) : `attempt ${attempt} interim` }], usage, stopReason: "stop" };',
      '  process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\\n`);',
      '}',
    ].join("\n"));
    const initialOwner = owner(sessionFile, "agent-call-1");
    const first: LaunchEntry = {
      kind: "launch",
      id: nextTestId(store),
      attempt: 1,
      requestKey: store.requestKey(initialOwner),
      owner: initialOwner,
      request: agentRequest(root, "first prompt"),
      runInBackground: false,
      createdAt: Date.now(),
    };
    store.prepare(first);
    recordLaunch(pi, first);
    store.observe({ branch: () => branch, notify: () => {}, onChange: () => {}, onError: (error) => { throw error; } });
    await store.start(first);
    const firstResult = await store.wait(first.id, 5000);
    expect(firstResult).toMatchObject({ state: "terminal", status: { state: "completed", attempt: 1 } });
    expect(store.usage(first.id, 1)).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      totalTokens: 66,
      cost: { input: 1.01, output: 2.02, cacheRead: 3.03, cacheWrite: 4.04, total: 10.1 },
    });
    expect(store.usage(first.id, 2)).toBeUndefined();
    expect(store.finalOutput(first.id)).toBe("Run a test agent: first prompt");

    const resumedOwner = owner(sessionFile, "agent-call-2");
    const resumed: LaunchEntry = {
      ...first,
      attempt: 2,
      requestKey: store.requestKey(resumedOwner),
      owner: resumedOwner,
      request: agentRequest(root, "second prompt"),
      createdAt: Date.now(),
    };
    store.prepare(resumed);
    recordLaunch(pi, resumed);
    expect(launchEntriesFromBranch(branch).map((launch) => [launch.id, launch.attempt])).toEqual([[first.id, 1], [first.id, 2]]);
    await store.resume(resumed);
    const resumedResult = await store.wait(first.id, 5000);
    expect(resumedResult).toMatchObject({ state: "terminal", status: { state: "completed", attempt: 2 } });
    expect(store.usage(first.id, 2)).toEqual({
      input: 1100,
      output: 2200,
      cacheRead: 3300,
      cacheWrite: 4400,
      totalTokens: 6600,
      cost: { input: 110, output: 220, cacheRead: 330, cacheWrite: 440, total: 1100 },
    });
    expect(store.usage(first.id, 1)).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      totalTokens: 66,
      cost: { input: 1.01, output: 2.02, cacheRead: 3.03, cacheWrite: 4.04, total: 10.1 },
    });
    expect(store.transcript(first.id)).toBe(path.join(path.dirname(sessionFile), "parent", first.id, "session.jsonl"));
    expect(store.finalOutput(first.id)).toBe("Run a test agent: second prompt");
    store.closeWatchers();
  });
});

function runnerRecoveryFixture(root: string) {
  const runId = parseRunId("22222222-2222-4222-8222-222222222222");
  if (!runId) throw new Error("Test run identifier must be a UUID");
  const runDirectory = path.join(root, "run");
  const attemptsDirectory = path.join(runDirectory, "attempts");
  const requestPath = path.join(runDirectory, "requests", "1.json");
  const marker = path.join(root, "should-not-run");
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.mkdirSync(attemptsDirectory, { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify({
    version: 1,
    id: runId,
    attempt: 1,
    requestKey: "stable-key",
    request: { kind: "shell", command: `touch '${marker}'`, cwd: root },
    transcript: "",
    piCommand: process.execPath,
    piArgsPrefix: [],
  }));
  return { runDirectory, attemptsDirectory, requestPath, marker };
}

function recoverRunnerAttempt(runDirectory: string, requestPath: string) {
  return spawnSync(process.execPath, [runnerPath, runDirectory, requestPath], { encoding: "utf8" });
}

describe("nested run ownership", () => {
  test("does not start a child after its parent closes registration", () => {
    const root = testRoot();
    const parentRunDirectory = path.join(root, "parent-run");
    const childRunDirectory = path.join(root, "child-run");
    const requestPath = path.join(root, "child-request.json");
    const marker = path.join(root, "child-started");
    const id = parseRunId("33333333-3333-4333-8333-333333333333");
    if (!id) throw new Error("Test run identifier must be a UUID");
    const closedDirectory = path.join(parentRunDirectory, "children", "1");
    fs.mkdirSync(closedDirectory, { recursive: true });
    fs.writeFileSync(path.join(closedDirectory, "closed"), "{}");
    fs.writeFileSync(requestPath, JSON.stringify({
      version: 1,
      id,
      attempt: 1,
      requestKey: "late-child",
      request: { kind: "shell", command: `touch '${marker}'`, cwd: root },
      transcript: "",
      piCommand: process.execPath,
      piArgsPrefix: [],
      parentRun: { directory: parentRunDirectory, attempt: 1 },
    }));

    const result = recoverRunnerAttempt(childRunDirectory, requestPath);
    const status = JSON.parse(fs.readFileSync(path.join(childRunDirectory, "status.json"), "utf8"));

    expect(result.status).toBe(0);
    expect(status).toMatchObject({ state: "stopped", id, attempt: 1 });
    expect(fs.existsSync(marker)).toBe(false);

    const nextAttemptId = parseRunId("44444444-4444-4444-8444-444444444444");
    if (!nextAttemptId) throw new Error("Test run identifier must be a UUID");
    const nextAttemptDirectory = path.join(root, "next-attempt-run");
    const nextAttemptRequestPath = path.join(root, "next-attempt-request.json");
    const nextAttemptMarker = path.join(root, "next-attempt-started");
    fs.writeFileSync(nextAttemptRequestPath, JSON.stringify({
      version: 1,
      id: nextAttemptId,
      attempt: 1,
      requestKey: "next-parent-attempt",
      request: { kind: "shell", command: `touch '${nextAttemptMarker}'`, cwd: root },
      transcript: "",
      piCommand: process.execPath,
      piArgsPrefix: [],
      parentRun: { directory: parentRunDirectory, attempt: 2 },
    }));

    const nextAttemptResult = recoverRunnerAttempt(nextAttemptDirectory, nextAttemptRequestPath);
    const nextAttemptStatus = JSON.parse(fs.readFileSync(path.join(nextAttemptDirectory, "status.json"), "utf8"));

    expect(nextAttemptResult.status).toBe(0);
    expect(nextAttemptStatus).toMatchObject({ state: "completed", id: nextAttemptId, attempt: 1 });
    expect(fs.existsSync(nextAttemptMarker)).toBe(true);
  });
});

describe("runner claim recovery", () => {
  test("marks an orphaned attempt failed without replaying its command", () => {
    const root = testRoot();
    const { runDirectory, attemptsDirectory, requestPath, marker } = runnerRecoveryFixture(root);
    fs.writeFileSync(path.join(attemptsDirectory, "1.claim"), JSON.stringify({ pid: 2147483647, birth: "stale", requestKey: "stable-key" }));

    const result = recoverRunnerAttempt(runDirectory, requestPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"))).toMatchObject({ state: "failed", attempt: 1 });
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("recovers an unreadable claim instead of treating it as active", () => {
    const root = testRoot();
    const { runDirectory, attemptsDirectory, requestPath } = runnerRecoveryFixture(root);
    fs.writeFileSync(path.join(attemptsDirectory, "1.claim"), "{");

    const result = recoverRunnerAttempt(runDirectory, requestPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"))).toMatchObject({ state: "failed", attempt: 1 });
  });

  test("recovers an unreadable recovery marker", () => {
    const root = testRoot();
    const { runDirectory, attemptsDirectory, requestPath } = runnerRecoveryFixture(root);
    fs.writeFileSync(path.join(attemptsDirectory, "1.claim"), JSON.stringify({ pid: 2147483647, birth: "stale", requestKey: "stable-key" }));
    fs.writeFileSync(path.join(attemptsDirectory, "1.recovered"), "{");

    const result = recoverRunnerAttempt(runDirectory, requestPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"))).toMatchObject({ state: "failed", attempt: 1 });
  });

  test("recovers a recovery marker whose owner process is dead", () => {
    const root = testRoot();
    const { runDirectory, attemptsDirectory, requestPath } = runnerRecoveryFixture(root);
    fs.writeFileSync(path.join(attemptsDirectory, "1.claim"), JSON.stringify({ pid: 2147483647, birth: "stale", requestKey: "stable-key" }));
    fs.writeFileSync(path.join(attemptsDirectory, "1.recovered"), JSON.stringify({ pid: 2147483647, birth: "stale", recoveredAt: 100 }));

    const result = recoverRunnerAttempt(runDirectory, requestPath);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"))).toMatchObject({ state: "failed", attempt: 1 });
  });
});

describe("attempt-aware completion dedupe", () => {
  test("does not let an earlier attempt suppress a resumed attempt's completion", async () => {
    const root = testRoot();
    const { sessionDir, sessionFile, branch, store, pi } = testHarness(root);
    const id = store.idForRequestKey("resumed-task");
    const firstStatus = {
      state: "completed",
      id,
      attempt: 1,
      exitCode: 0,
      stopReason: "stop",
      endedAt: 100,
    };
    appendToolResult(branch, { runId: id, status: firstStatus, completed: true });

    const launchOwner = owner(sessionFile, "resume-call-2");
    const resumed: LaunchEntry = {
      kind: "launch",
      id,
      attempt: 2,
      requestKey: store.requestKey(launchOwner),
      owner: launchOwner,
      request: agentRequest(root, "second prompt"),
      runInBackground: true,
      createdAt: 200,
    };
    store.prepare(resumed);
    recordLaunch(pi, resumed);
    fs.writeFileSync(path.join(sessionDir, "pstack-agents", id, "status.json"), JSON.stringify({
      state: "completed",
      id,
      attempt: 2,
      exitCode: 0,
      stopReason: "stop",
      endedAt: 300,
    }));

    const notifications: RunNotification[] = [];
    await store.reconcile(branch, (notification) => notifications.push(notification), false);

    expect(notifications.map((notification) => notification.notificationId)).toEqual([`${id}:2:completed`]);
    store.closeWatchers();
  });
});

describe("launch and notice idempotence", () => {
  test("uses a stable request key and suppresses notices already in the session branch", () => {
    const root = testRoot();
    const { sessionFile, store } = testHarness(root);
    const launchOwner = owner(sessionFile, "tool-call-1");
    const firstKey = store.requestKey(launchOwner);
    expect(store.requestKey(launchOwner)).toBe(firstKey);
    expect(store.requestKey(owner(sessionFile, "tool-call-2"))).not.toBe(firstKey);
    expect(store.idForRequestKey(firstKey)).toBe(store.idForRequestKey(firstKey));
    expect(store.idForRequestKey(firstKey)).not.toBe(store.idForRequestKey(store.requestKey(owner(sessionFile, "tool-call-2"))));
    expect(shouldNotify({ notificationId: "notice-1", delivered: new Set(["notice-1"]), inFlight: new Set() })).toBe(false);
    expect(shouldNotify({ notificationId: "notice-2", delivered: new Set(), inFlight: new Set(["notice-2"]) })).toBe(false);
    expect(shouldNotify({ notificationId: "notice-3", delivered: new Set(), inFlight: new Set() })).toBe(true);
    store.closeWatchers();
  });
});
