import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import registerPstackAgents from "./index.ts";
import { RUN_ENTRY_TYPE } from "./runs.ts";

function failureHarness(scratch: string) {
  type ToolResult = { content: Array<{ text: string }>; details?: unknown; usage?: unknown };
  type TestTool = { parameters: TSchema; execute: (...args: unknown[]) => Promise<ToolResult> };
  const tools = new Map<string, TestTool>();
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const branch: Array<Record<string, unknown>> = [];
  const sentMessages: Array<{ content: unknown }> = [];
  const pi = {
    registerTool: (tool: { name: string; parameters: TSchema; execute: (...args: unknown[]) => Promise<ToolResult> }) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, handler),
    appendEntry: (customType: string, data: unknown) => branch.push({
      type: "custom",
      id: `entry-${branch.length + 1}`,
      parentId: branch.length ? `entry-${branch.length}` : null,
      timestamp: new Date().toISOString(),
      customType,
      data,
    }),
    getActiveTools: () => ["read", "bash", "Task"],
    getAllTools: () => [
      { name: "read", sourceInfo: { path: "builtin" } },
      { name: "bash", sourceInfo: { path: "builtin" } },
      { name: "Task", sourceInfo: { path: path.join(scratch, "pstack-agents", "index.ts") } },
    ],
    sendMessage: (message: { content: unknown }) => sentMessages.push(message),
  };
  registerPstackAgents(pi as never);
  const context = {
    cwd: scratch,
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    isProjectTrusted: () => false,
    model: { provider: "openai-codex", id: "gpt-6-luna" },
    thinkingLevel: "low",
    sessionManager: {
      getSessionDir: () => path.join(scratch, "sessions"),
      getSessionFile: () => path.join(scratch, "sessions", "parent.jsonl"),
      getSessionId: () => "failure-test-session",
      getLeafId: () => null,
      getBranch: () => branch,
    },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  return { tools, hooks, branch, context, sentMessages };
}

function latestRunId(branch: readonly Record<string, unknown>[]): string {
  const launch = [...branch].reverse().find((entry) => entry.customType === RUN_ENTRY_TYPE);
  const data = launch?.data;
  if (typeof data !== "object" || data === null || !("id" in data) || typeof data.id !== "string") {
    throw new Error("Run launch did not record its id");
  }
  return data.id;
}

function lifecycleHarness(ui: { setStatus: (...args: unknown[]) => void; notify: (...args: unknown[]) => void }) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, handler),
  };
  registerPstackAgents(pi as never);
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    isIdle: () => true,
    sessionManager: {
      getSessionDir: () => `/tmp/pstack-agents-status-${process.pid}`,
      getSessionFile: () => `/tmp/pstack-agents-status-${process.pid}/parent.jsonl`,
      getSessionId: () => "status-test-session",
      getBranch: () => [],
    },
    ui,
  };
  return { hooks, context };
}

describe("refresh status lifecycle", () => {
  test("catches status refresh errors and reports them through the UI", async () => {
    let statusCalls = 0;
    const errors: string[] = [];
    const { hooks, context } = lifecycleHarness({
      setStatus: () => {
        statusCalls++;
        if (statusCalls === 1) throw new Error("status refresh failure");
      },
      notify: (message) => errors.push(String(message)),
    });

    let failure: unknown;
    try {
      await hooks.get("session_start")?.({}, context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeUndefined();
    expect(errors).toContain("status refresh failure");
    await hooks.get("session_shutdown")?.({}, context);
  });

  test("does not update the UI after session shutdown", async () => {
    const calls: unknown[][] = [];
    const { hooks, context } = lifecycleHarness({
      setStatus: (...args) => calls.push(args),
      notify: (...args) => calls.push(args),
    });

    const starting = hooks.get("session_start")?.({}, context);
    await hooks.get("session_shutdown")?.({}, context);
    await starting;
    expect(calls).toEqual([]);
  });
});

describe("Shell timeout schema", () => {
  test("caps Shell timeout fields at the parser maximum", () => {
    const tools = new Map<string, { parameters: unknown }>();
    const pi = {
      registerTool: (tool: { name: string; parameters: unknown }) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: () => {},
    };
    registerPstackAgents(pi as never);
    const parameters = tools.get("Shell")?.parameters as { properties?: Record<string, { maximum?: number }> };

    expect(parameters.properties?.timeout?.maximum).toBe(604800000);
    expect(parameters.properties?.hard_timeout?.maximum).toBe(604800000);
  });
});

describe("tool execution failures", () => {
  test("Task, Shell, Await, SubagentAwait, and goals reject failed execution", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-agents-failure-test-"));
    const agentDir = path.join(scratch, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const { tools, hooks, branch, context } = failureHarness(scratch);
    const sessionStart = hooks.get("session_start");
    if (!sessionStart) throw new Error("Missing session_start handler");

    try {
      await sessionStart({}, context);
      const task = tools.get("Task");
      const shell = tools.get("Shell");
      const awaitTask = tools.get("Await");
      const awaitAgent = tools.get("SubagentAwait");
      const createGoal = tools.get("CreateGoal");
      const updateGoal = tools.get("UpdateGoal");
      if (!task || !shell || !awaitTask || !awaitAgent || !createGoal || !updateGoal) throw new Error("Missing runtime tool");

      await expect(task.execute("bad-agent", {
        description: "Use a missing agent",
        prompt: "Return a result.",
        subagent_type: "missing-agent",
      }, undefined, undefined, context)).rejects.toThrow('Unknown agent "missing-agent"');
      const machineInput = {
        description: "Use a remote machine",
        prompt: "Return a result.",
        subagent_type: "generalPurpose",
        machine: { same_machine: {} },
      };
      expect(Value.Check(task.parameters, machineInput)).toBe(true);
      await expect(task.execute("unsupported-machine", machineInput, undefined, undefined, context)).rejects.toThrow("Task.machine is not supported on Pi.");
      const cloudBuildInput = {
        description: "Use a remote build",
        prompt: "Return a result.",
        subagent_type: "generalPurpose",
        cloud_requested_environment_build_id: "build-123",
      };
      const acceptsCloudBuildInput = Value.Check(task.parameters, cloudBuildInput);
      expect(acceptsCloudBuildInput).toBe(true);
      if (acceptsCloudBuildInput) {
        await expect(task.execute("unsupported-cloud-build", cloudBuildInput, undefined, undefined, context)).rejects.toThrow("Task.cloud_requested_environment_build_id is not supported on Pi.");
      }
      expect(branch).toEqual([]);
      await expect(shell.execute("bad-shell", { command: " " }, undefined, undefined, context)).rejects.toThrow("non-empty command");
      await expect(awaitTask.execute("bad-await", { task_id: "not-a-run-id" }, undefined)).rejects.toThrow("Await requires a valid task_id");
      await expect(awaitAgent.execute("bad-subagent-await", { agent_id: "not-a-run-id", timeout_ms: 0 }, undefined)).rejects.toThrow("Await requires a valid agent_id");
      await expect(createGoal.execute("headless-goal", { objective: "Ship" }, undefined, undefined, {
        ...context,
        hasUI: false,
        mode: "print",
      })).rejects.toThrow("CreateGoal requires an interactive TUI or RPC session");
      await expect(updateGoal.execute("missing-goal", { status: "ACTIVE" }, undefined, undefined, context)).rejects.toThrow("There is no current goal to update");

      await expect(shell.execute("failed-shell", { command: "exit 7" }, undefined, undefined, context)).rejects.toThrow("failed (error)");
      const failedRunId = latestRunId(branch);
      await expect(awaitTask.execute("await-failed-shell", { task_id: failedRunId }, undefined)).rejects.toThrow("failed (error)");

      await shell.execute("background-shell", { command: "sleep 1", is_background: true }, undefined, undefined, context);
      const backgroundRunId = latestRunId(branch);
      const timeoutResult = await awaitTask.execute("await-timeout", {
        task_id: backgroundRunId,
        block_until_ms: 0,
      }, undefined);
      expect(timeoutResult.details).toMatchObject({ state: "timeout", completed: false });
      expect(timeoutResult.content[0]?.text).toContain("Wait timed out.");
      expect(timeoutResult.content[0]?.text).toContain("Output log:");

      const abort = new AbortController();
      abort.abort();
      const detachedResult = await awaitTask.execute("await-detached", { task_id: backgroundRunId }, abort.signal);
      expect(detachedResult.details).toMatchObject({ state: "detached", completed: false });
      expect(detachedResult.content[0]?.text).toContain("Wait detached.");
      expect(detachedResult.content[0]?.text).toContain("Output log:");

      const completedResult = await awaitTask.execute("await-completed", {
        task_id: backgroundRunId,
        block_until_ms: 5000,
      }, undefined);
      expect(completedResult.details).toMatchObject({ state: "terminal", completed: true });
    } finally {
      await hooks.get("session_shutdown")?.({}, context);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("bounded run output", () => {
  test("truncates Task and Shell output and claims terminal usage once across results and restart", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-agents-bounded-output-test-"));
    const agentDir = path.join(scratch, "agent");
    const agentDirectory = path.join(agentDir, "agents");
    const fakePi = path.join(scratch, "fake-pi.mjs");
    fs.mkdirSync(agentDirectory, { recursive: true });
    fs.writeFileSync(path.join(agentDirectory, "output-agent.md"), [
      "---",
      "name: output-agent",
      "description: Bounded output fixture",
      "tools: read",
      "inheritProjectContext: false",
      "inheritGlobalContext: false",
      "inheritSkills: false",
      "---",
      "Print the result.",
    ].join("\n"));
    fs.writeFileSync(fakePi, [
      'const attempt = Number(process.env.PSTACK_AGENTS_PARENT_RUN_ATTEMPT);',
      'const output = Array.from({ length: 2500 }, (_, index) => `TASK_LINE_${String(index + 1).padStart(4, "0")}`).join("\\n");',
      'const usage = attempt === 1',
      '  ? { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 9, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } }',
      '  : { input: 20, output: 30, cacheRead: 40, cacheWrite: 50, totalTokens: 90, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };',
      'const message = { role: "assistant", content: [{ type: "text", text: output }], usage, stopReason: "end" };',
      'process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\\n`);',
    ].join("\n"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousArgv1 = process.argv[1];
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.argv[1] = fakePi;
    const { tools, hooks, context, sentMessages } = failureHarness(scratch);
    const sessionStart = hooks.get("session_start");
    if (!sessionStart) throw new Error("Missing session_start handler");

    try {
      await sessionStart({}, context);
      const task = tools.get("Task");
      const shell = tools.get("Shell");
      if (!task || !shell) throw new Error("Missing run tool");

      const taskResult = await task.execute("large-task", {
        description: "Print many lines",
        prompt: "Return the generated output.",
        subagent_type: "output-agent",
      }, undefined, undefined, context);
      const taskText = taskResult.content[0]?.text ?? "";
      const transcript = /Transcript: ([^\n]+)/.exec(taskText)?.[1];
      if (!transcript) throw new Error("Task result did not include a transcript path");
      expect(taskText).toContain("TASK_LINE_0001");
      expect(taskText).not.toContain("TASK_LINE_2500");
      expect(taskText).toContain(`[Output truncated. Full transcript: ${transcript}]`);
      expect(taskResult.usage).toEqual({
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 9,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      });

      const backgroundResult = await task.execute("large-background-task", {
        description: "Print many lines in background",
        prompt: "Return the generated output.",
        subagent_type: "output-agent",
        run_in_background: true,
      }, undefined, undefined, context);
      const backgroundText = backgroundResult.content[0]?.text ?? "";
      expect(backgroundResult.usage).toBeUndefined();
      const backgroundTranscript = /Transcript: ([^\n]+)/.exec(backgroundText)?.[1];
      if (!backgroundTranscript) throw new Error("Background Task receipt did not include a transcript path");
      let notificationText = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        notificationText = sentMessages.map((message) => String(message.content)).join("\n");
        if (notificationText.includes(`[Output truncated. Full transcript: ${backgroundTranscript}]`)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(notificationText).toContain(`[Output truncated. Full transcript: ${backgroundTranscript}]`);
      expect(notificationText).not.toContain("TASK_LINE_2500");
      const backgroundId = /agent_id: ([^\n]+)/.exec(backgroundText)?.[1];
      if (!backgroundId) throw new Error("Background Task receipt did not include its agent id");
      expect(backgroundResult.usage).toBeUndefined();
      const subagentAwait = tools.get("SubagentAwait");
      if (!subagentAwait) throw new Error("Missing SubagentAwait tool");
      const firstAwait = await subagentAwait.execute("await-background-task-first", {
        agent_id: backgroundId,
        timeout_ms: 0,
      }, undefined);
      const repeatedAwait = await subagentAwait.execute("await-background-task-again", {
        agent_id: backgroundId,
        timeout_ms: 0,
      }, undefined);
      expect(firstAwait.usage).toEqual({
        input: 2,
        output: 3,
        cacheRead: 4,
        cacheWrite: 5,
        totalTokens: 9,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
      });
      const interruptResult = await task.execute("interrupt-finished-background-task", {
        resume: backgroundId,
        interrupt: true,
      }, undefined, undefined, context);
      expect([
        firstAwait.usage !== undefined,
        repeatedAwait.usage !== undefined,
        interruptResult.usage !== undefined,
      ]).toEqual([true, false, false]);

      await hooks.get("session_shutdown")?.({}, context);
      await sessionStart({}, context);
      const afterRestartAwait = await subagentAwait.execute("await-background-task-after-restart", {
        agent_id: backgroundId,
        timeout_ms: 0,
      }, undefined);
      expect(afterRestartAwait.usage).toBeUndefined();

      const resumeResult = await task.execute("resume-background-task", {
        description: "Resume many lines in background",
        prompt: "Return the generated output again.",
        subagent_type: "output-agent",
        resume: backgroundId,
      }, undefined, undefined, context);
      expect(resumeResult.usage).toEqual({
        input: 20,
        output: 30,
        cacheRead: 40,
        cacheWrite: 50,
        totalTokens: 90,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      });
      expect(resumeResult.details).toMatchObject({ attempt: 2, status: { attempt: 2 } });
      const awaitedResult = await subagentAwait.execute("await-resumed-background-task", {
        agent_id: backgroundId,
        timeout_ms: 0,
      }, undefined);
      expect(awaitedResult.usage).toBeUndefined();
      expect(awaitedResult.details).toMatchObject({ completed: true, status: { attempt: 2 } });

      const shellResult = await shell.execute("large-shell", {
        command: `i=1; while [ "$i" -le 2500 ]; do printf 'SHELL_LINE_%04d\\n' "$i"; i=$((i + 1)); done`,
      }, undefined, undefined, context);
      const shellText = shellResult.content[0]?.text ?? "";
      const outputLog = /Output log: ([^\n]+)/.exec(shellText)?.[1];
      if (!outputLog) throw new Error("Shell result did not include an output log path");
      expect(shellText).not.toContain("SHELL_LINE_0001");
      expect(shellText).toContain("SHELL_LINE_2500");
      expect(shellText).toContain(`[Output truncated. Full log: ${outputLog}]`);
    } finally {
      await hooks.get("session_shutdown")?.({}, context);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      process.argv[1] = previousArgv1;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("Await regex validation", () => {
  test("returns a clear error for nested unbounded quantifiers", async () => {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: () => {},
    };
    registerPstackAgents(pi as never);

    await expect(tools.get("Await")?.execute("call", {
      task_id: "11111111-1111-4111-8111-111111111111",
      regex: "(a+)+$",
    })).rejects.toThrow("unsafe regular expression");
  });
});

describe("headless Shell safety", () => {
  test("refuses notification-armed and unbounded background Shell calls", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-agents-headless-shell-test-"));
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const branch: Array<Record<string, unknown>> = [];
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, handler),
      appendEntry: (customType: string, data: unknown) => branch.push({
        type: "custom",
        id: `entry-${branch.length + 1}`,
        parentId: branch.length ? `entry-${branch.length}` : null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      }),
    };
    const context = {
      cwd: scratch,
      hasUI: false,
      mode: "tui",
      isIdle: () => true,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionDir: () => path.join(scratch, "sessions"),
        getSessionFile: () => path.join(scratch, "sessions", "parent.jsonl"),
        getSessionId: () => "headless-shell-test",
        getLeafId: () => null,
        getBranch: () => branch,
      },
      ui: { setStatus: () => {}, notify: () => {} },
    };

    try {
      registerPstackAgents(pi as never);
      for (const mode of ["tui", "json"]) {
        context.hasUI = mode === "json";
        context.mode = mode;
        await hooks.get("session_start")?.({}, context);
        await expect(tools.get("Shell")?.execute("shell-notification", {
          command: "sleep 0.1",
          is_background: true,
          output_notification: "READY",
        }, undefined, undefined, context)).rejects.toThrow("Headless run: nothing can receive output notifications, so a background Shell wake cannot be armed here. Run a bounded foreground command, or run this from an interactive Pi session.");
        await hooks.get("session_shutdown")?.({}, context);
      }

      context.hasUI = false;
      context.mode = "tui";
      await hooks.get("session_start")?.({}, context);
      await expect(tools.get("Shell")?.execute("shell-unbounded", {
        command: "sleep 0.1",
        is_background: true,
      }, undefined, undefined, context)).rejects.toThrow("Headless run: an unbounded background Shell");
      expect(branch).toEqual([]);
    } finally {
      await hooks.get("session_shutdown")?.({}, context);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("agent parse warnings", () => {
  test("notifies once per invalid file and session", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-agents-agent-warning-test-"));
    const invalidFile = path.join(scratch, ".pi", "agents", "broken.md");
    fs.mkdirSync(path.dirname(invalidFile), { recursive: true });
    fs.writeFileSync(invalidFile, "---\nname: broken\ndescription: Broken\nallowNestedSubagents: yes\n---\nPrompt.\n");
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const branch: Array<Record<string, unknown>> = [];
    const warnings: string[] = [];
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, handler),
      appendEntry: (customType: string, data: unknown) => branch.push({
        type: "custom",
        id: `entry-${branch.length + 1}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      }),
      getActiveTools: () => ["read", "Task"],
      getAllTools: () => [
        { name: "read", sourceInfo: { path: "builtin" } },
        { name: "Task", sourceInfo: { path: path.join(scratch, "pstack-agents", "index.ts") } },
      ],
    };
    const context = {
      cwd: scratch,
      hasUI: true,
      mode: "tui",
      model: { provider: "openai-codex", id: "gpt-6-luna" },
      thinkingLevel: "low",
      isIdle: () => true,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionDir: () => path.join(scratch, "sessions"),
        getSessionFile: () => path.join(scratch, "sessions", "parent.jsonl"),
        getSessionId: () => "agent-warning-test",
        getLeafId: () => null,
        getBranch: () => branch,
      },
      ui: { setStatus: () => {}, notify: (message: string) => warnings.push(message) },
    };

    try {
      registerPstackAgents(pi as never);
      await hooks.get("session_start")?.({}, context);
      for (let call = 0; call < 2; call++) {
        await expect(tools.get("Task")?.execute(`warning-${call}`, {
          description: "Find an agent",
          prompt: "This agent does not exist.",
          subagent_type: "missing-agent",
        }, undefined, undefined, context)).rejects.toThrow('Unknown agent "missing-agent"');
      }
      expect(warnings.filter((message) => message.includes(invalidFile))).toEqual([
        `Skipped agent file ${invalidFile}: Agent frontmatter allowNestedSubagents must be a boolean`,
      ]);
    } finally {
      await hooks.get("session_shutdown")?.({}, context);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("background Bash poll guard", () => {
  test("leaves heredoc contents to the shared shell parser", async () => {
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerTool: () => {},
      registerCommand: () => {},
      on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, handler),
    };
    registerPstackAgents(pi as never);

    const result = await hooks.get("tool_call")?.({
      toolName: "bash",
      input: { command: "cat <<'EOF'\nwhile true; do sleep 30; done &\nEOF" },
    }, { cwd: process.cwd() });

    expect(result).toBeUndefined();
  });

});

describe("no-session runs", () => {
  test("runs Task and Shell under the parent-PID temp root without a session file", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pstack-agents-no-session-test-"));
    const tempRunRoot = path.join(os.tmpdir(), "pstack-agents", String(process.pid));
    const agentDirectory = path.join(scratch, ".pi", "agents");
    const agentFile = path.join(agentDirectory, "reader.md");
    const fakePi = path.join(scratch, "fake-pi.mjs");
    fs.mkdirSync(agentDirectory, { recursive: true });
    fs.writeFileSync(agentFile, [
      "---",
      "name: no-session-reader",
      "description: Test reader for no-session Task calls",
      "tools: read",
      "inheritProjectContext: false",
      "inheritGlobalContext: false",
      "inheritSkills: false",
      "---",
      "Test reader.",
    ].join("\n"));
    fs.writeFileSync(fakePi, [
      'const message = { role: "assistant", content: [{ type: "text", text: "TASK_OK" }], stopReason: "end" };',
      'process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\\n`);',
    ].join("\n"));

    const previousArgv1 = process.argv[1];
    process.argv[1] = fakePi;
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const branch: Array<Record<string, unknown>> = [];
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: (event: string, handler: (...args: unknown[]) => unknown) => hooks.set(event, handler),
      appendEntry: (customType: string, data: unknown) => branch.push({
        type: "custom",
        id: `entry-${branch.length + 1}`,
        customType,
        data,
      }),
      getActiveTools: () => ["read", "Task"],
      getAllTools: () => [
        { name: "read", sourceInfo: { path: "builtin" } },
        { name: "Task", sourceInfo: { path: path.join(scratch, "pstack-agents", "index.ts") } },
      ],
    };
    const context = {
      cwd: scratch,
      hasUI: true,
      mode: "tui",
      model: { provider: "openai-codex", id: "gpt-6-luna" },
      thinkingLevel: "low",
      isIdle: () => true,
      isProjectTrusted: () => true,
      sessionManager: {
        getSessionDir: () => path.join(scratch, "persistent-sessions"),
        getSessionFile: () => undefined,
        getSessionId: () => "no-session-test",
        getLeafId: () => null,
        getBranch: () => branch,
      },
      ui: { setStatus: () => {}, notify: () => {} },
    };

    try {
      registerPstackAgents(pi as never);
      await hooks.get("session_start")?.({}, context);
      const task = await tools.get("Task")?.execute("task-no-session", {
        description: "Test no-session Task",
        prompt: "Reply exactly TASK_OK.",
        subagent_type: "no-session-reader",
      }, undefined, undefined, context);
      expect(task?.content[0]?.text).toContain("TASK_OK");
      expect(task?.content[0]?.text).toContain(tempRunRoot);
      expect(task?.content[0]?.text).toMatch(/Transcript: .+session\.jsonl/);
      expect(task?.content[0]?.text).not.toContain("[Output truncated.");

      const shell = await tools.get("Shell")?.execute("shell-no-session", {
        command: "printf 'SHELL_OK\\n'",
      }, undefined, undefined, context);
      expect(shell?.content[0]?.text).toContain("SHELL_OK");
      expect(shell?.content[0]?.text).toContain(tempRunRoot);
      expect(shell?.content[0]?.text).toMatch(/Output log: .+output\.log/);
      expect(shell?.content[0]?.text).not.toContain("[Output truncated.");
    } finally {
      await hooks.get("session_shutdown")?.({}, context);
      for (const entry of branch) {
        const data = entry.data;
        if (typeof data !== "object" || data === null || !("id" in data) || typeof data.id !== "string") continue;
        for (const directory of ["pstack-agents", "parent"]) {
          fs.rmSync(path.join(tempRunRoot, directory, data.id), { recursive: true, force: true });
        }
      }
      process.argv[1] = previousArgv1;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
