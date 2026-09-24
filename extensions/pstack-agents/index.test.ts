import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import registerPstackAgents from "./index.ts";

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

describe("Await regex validation", () => {
  test("returns a clear error for nested unbounded quantifiers", async () => {
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>();
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }) => tools.set(tool.name, tool),
      registerCommand: () => {},
      on: () => {},
    };
    registerPstackAgents(pi as never);

    const result = await tools.get("Await")?.execute("call", { task_id: "11111111-1111-4111-8111-111111111111", regex: "(a+)+$" });
    expect(result?.content[0]?.text).toContain("unsafe regular expression");
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
        const result = await tools.get("Shell")?.execute("shell-notification", {
          command: "sleep 0.1",
          is_background: true,
          output_notification: "READY",
        }, undefined, undefined, context);
        expect(result?.content[0]?.text).toBe("Headless run: nothing can receive output notifications, so a background Shell wake cannot be armed here. Run a bounded foreground command, or run this from an interactive Pi session.");
        await hooks.get("session_shutdown")?.({}, context);
      }

      context.hasUI = false;
      context.mode = "tui";
      await hooks.get("session_start")?.({}, context);
      const unbounded = await tools.get("Shell")?.execute("shell-unbounded", {
        command: "sleep 0.1",
        is_background: true,
      }, undefined, undefined, context);
      expect(unbounded?.content[0]?.text).toContain("Headless run: an unbounded background Shell");
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
        await tools.get("Task")?.execute(`warning-${call}`, {
          description: "Find an agent",
          prompt: "This agent does not exist.",
          subagent_type: "missing-agent",
        }, undefined, undefined, context);
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

      const shell = await tools.get("Shell")?.execute("shell-no-session", {
        command: "printf 'SHELL_OK\\n'",
      }, undefined, undefined, context);
      expect(shell?.content[0]?.text).toContain("SHELL_OK");
      expect(shell?.content[0]?.text).toContain(tempRunRoot);
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
