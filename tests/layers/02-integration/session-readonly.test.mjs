import { expect, test } from "vitest";
import { withSession } from "../../support/session.mjs";

async function withoutChildRole(run) {
  const saved = process.env.PSTACK_CHILD_ROLE;
  process.env.PSTACK_CHILD_ROLE = "";
  try {
    return await run();
  } finally {
    process.env.PSTACK_CHILD_ROLE = saved ?? "";
  }
}

function statusValues(f, key) {
  return f.ui.statuses.filter(([id]) => id === key).map(([, value]) => value);
}

function stubPstackTools(f) {
  const calls = new Map();
  const names = f.session.getActiveToolNames().filter((name) => name.startsWith("pstack_") && f.tool(name));
  const originals = names.map((name) => [name, f.tool(name).definition.execute]);
  for (const name of names) {
    calls.set(name, []);
    f.tool(name).definition.execute = async (_tool, params) => {
      calls.set(name, [...(calls.get(name) ?? []), params]);
      return { content: [{ type: "text", text: `stub:${name}` }] };
    };
  }
  const restore = () => {
    for (const [name, execute] of originals) f.tool(name).definition.execute = execute;
  };
  return { calls, restore };
}

async function runOneTool(f, name, input) {
  f.faux.setResponses([
    f.faux.assistant([f.faux.toolCall(name, input)], { stopReason: "toolUse" }),
    f.faux.assistant("done"),
  ]);
  await f.prompt("run the requested tool");
  return f.events.filter((event) => event.type === "tool_execution_end" && event.toolName === name).at(-1);
}

const BLOCKED_TOOLS = [
  ["pstack_worktree", { action: "create", name: "probe" }, "pstack session readonly: blocked mutating pstack_worktree."],
  ["pstack_ship", { action: "view", pr: "1" }, "pstack session readonly: blocked pstack_ship."],
  ["pstack_babysit", { pr: "1" }, "pstack session readonly: blocked pstack_babysit."],
  ["pstack_swarm", { workers: [{ task: "x" }] }, "pstack session readonly: blocked pstack_swarm."],
  ["pstack_arena", { prompt: "x", candidates: [{ label: "a" }] }, "pstack session readonly: blocked pstack_arena."],
  ["pstack_decision_log", { phase: "p", decision: "d", why: "w" }, "pstack session readonly: blocked pstack_decision_log."],
  ["pstack_control_cli", { argv: ["echo", "hi"] }, "pstack session readonly: blocked pstack_control_cli."],
  ["pstack_loop", { action: "arm", prompt: "x", intervalSeconds: 5 }, "pstack session readonly: blocked pstack_loop arm (subprocess watcher)."],
  ["pstack_run", { action: "arm", predicate: "p", intervalSeconds: 5 }, "pstack session readonly: blocked pstack_run arm (subprocess watcher)."],
  ["pstack_deslop", { applySafe: true }, "pstack session readonly: blocked deslop applySafe/autoApply."],
  ["pstack_deslop", { autoApply: true }, "pstack session readonly: blocked deslop applySafe/autoApply."],
  ["pstack_benny_wake", { action: "append", payload: "{}" }, "pstack session readonly: blocked pstack_benny_wake write."],
  ["pstack_integrations", { action: "query", capability: "source-control" }, "pstack session readonly: blocked pstack_integrations query."],
];

const ALLOWED_TOOLS = [
  ["pstack_worktree", { action: "list" }],
  ["pstack_deslop", {}],
  ["pstack_loop", { action: "status" }],
  ["pstack_loop", { action: "list" }],
  ["pstack_loop", { action: "stop" }],
  ["pstack_run", { action: "list" }],
  ["pstack_run", { action: "stop", runId: "r1" }],
  ["pstack_integrations", { action: "list" }],
  ["pstack_integrations", { action: "status" }],
  ["pstack_integrations", { action: "probe" }],
  ["pstack_benny_wake", { action: "path" }],
  ["pstack_control_ui", { url: "http://example.test" }],
  ["pstack_sessions", { action: "list" }],
  ["pstack_jobs", { action: "list" }],
  ["pstack_spawn", { task: "allow-readonly", readonly: true }],
  ["pstack_spawn", { task: "allow-investigator", role: "investigator" }],
  ["pstack_spawn", { task: "allow-comment", role: "comment-sicko" }],
  ["pstack_task", { prompt: "allow-readonly", readonly: true }],
  ["pstack_task", { prompt: "allow-investigator", subagent_type: "investigator" }],
  ["pstack_task", { prompt: "allow-comment", subagent_type: "comment-sicko" }],
];

const COERCED_TOOLS = [
  ["pstack_spawn", { task: "coerce-default" }],
  ["pstack_spawn", { task: "coerce-general", role: "general" }],
  ["pstack_task", { prompt: "coerce-default" }],
  ["pstack_task", { prompt: "coerce-general", subagent_type: "general" }],
];

test("pstack-readonly command arms readonly mode", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");

    expect(f.ui.notifications.some(
        ([type, message]) =>
          type === "info" && message === "Session readonly on (command): write/edit/bash blocked.",
      ), `notifications: ${JSON.stringify(f.ui.notifications)}`).toBeTruthy();

    expect(f.ui.statuses.some(([key, text]) => key === "pstack-ro" && text === "readonly"), `statuses: ${JSON.stringify(f.ui.statuses)}`).toBeTruthy();

    const activeTools = f.session.getActiveToolNames();
    expect(!activeTools.includes("bash"), "bash should be blocked").toBeTruthy();
    expect(!activeTools.includes("write"), "write should be blocked").toBeTruthy();
    expect(!activeTools.includes("edit"), "edit should be blocked").toBeTruthy();
    expect(activeTools.includes("read"), "read should be available").toBeTruthy();
    expect(activeTools.includes("grep"), "grep should be available").toBeTruthy();
    expect(activeTools.includes("find"), "find should be available").toBeTruthy();
    expect(activeTools.includes("ls"), "ls should be available").toBeTruthy();
    expect(activeTools.includes("pstack_jobs"), "pstack_jobs should be available").toBeTruthy();

    const entries = f.session.sessionManager.getEntries();
    const customEntry = entries.find(
      (e) => e.type === "custom" && e.customType === "pstack-session-readonly",
    );
    expect(customEntry, "pstack-session-readonly custom entry not found").toBeTruthy();
  });
});

test("a repeat readonly command is a no-op", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");
    const before = f.ui.notifications.length;
    await f.prompt("/pstack-readonly");

    expect(f.ui.notifications.length, "a second arm must not re-notify").toBe(before);
    expect(statusValues(f, "pstack-ro")).toEqual(["readonly"]);
  });
});

test("readonly blocks every mutating pstack tool with its reason", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");
    const stubs = stubPstackTools(f);
    try {
      for (const [name, input, reason] of BLOCKED_TOOLS) {
        const end = await runOneTool(f, name, input);
        expect(end, `${name} produced no tool_execution_end`).toBeTruthy();
        expect(end.isError, `${name} was not blocked`).toBe(true);
        expect(end.result.content[0].text).toBe(reason);
      }
    } finally {
      stubs.restore();
    }
  });
});

test("readonly leaves read-safe pstack tools allowed", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");
    const stubs = stubPstackTools(f);
    try {
      for (const [name, input] of ALLOWED_TOOLS) {
        const end = await runOneTool(f, name, input);
        const text = end.result.content[0].text;
        expect(text.startsWith("pstack session readonly:"), `${name} was blocked: ${text}`).toBe(false);
        expect(text).toBe(`stub:${name}`);
      }
    } finally {
      stubs.restore();
    }
  });
});

test("readonly coerces spawn and task policies instead of blocking them", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");
    const stubs = stubPstackTools(f);
    try {
      for (const [name, input] of COERCED_TOOLS) {
        const end = await runOneTool(f, name, input);
        expect(end.isError, `${name} should run coerced: ${end?.result?.content?.[0]?.text}`).toBe(false);
        expect(end.result.content[0].text).toBe(`stub:${name}`);
        const recorded = stubs.calls.get(name).at(-1);
        expect(recorded.readonly, `${name} did not receive readonly:true`).toBe(true);
      }
    } finally {
      stubs.restore();
    }
  });
});

test("readonly allows tools with no policy entry", async () => {
  await withSession(
    async (f) => {
      await f.prompt("/pstack-readonly");
      f.faux.setResponses([
        f.faux.assistant([f.faux.toolCall("read", { path: `${f.tmp.cwd}/note.txt` })], { stopReason: "toolUse" }),
        f.faux.assistant("done"),
      ]);
      await f.prompt("read the note");

      const end = f.events.find((event) => event.type === "tool_execution_end" && event.toolName === "read");
      expect(end.isError, "read must not be blocked by the readonly gate").toBe(false);
      expect(end.result.content[0].text).toBe("hello-note");
    },
    { initialFiles: { "note.txt": "hello-note" } },
  );
});

test("readonly state and stripped tools survive a reload", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");
    const before = f.ui.statuses.length;
    await f.reload();

    expect(f.ui.statuses.slice(before)).toContainEqual(["pstack-ro", "readonly"]);
    expect(f.session.getActiveToolNames().includes("bash"), "restored readonly still strips bash").toBe(false);
  });
});

test("a new non-readonly playbook releases the auto-armed readonly session", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack"), f.faux.assistant("ack")]);
      await f.prompt("how does the sticky matcher work");
      expect(statusValues(f, "pstack-ro")).toEqual(["readonly"]);

      await f.prompt("check on PR 12 and get it green");

      expect(statusValues(f, "pstack-ro")).toEqual(["readonly", undefined]);
      expect(f.ui.notifications.some(([type, message]) => type === "info" && message === "Session readonly off.")).toBe(true);
      expect(f.session.getActiveToolNames().includes("bash"), "release restores bash").toBe(true);
    }),
  );
});

test("a playbook release leaves a command-armed readonly session armed", async () => {
  await withoutChildRole(() =>
    withSession(async (f) => {
      f.faux.setResponses([f.faux.assistant("ack")]);
      await f.prompt("/pstack-readonly");
      await f.prompt("check on PR 12 and get it green");

      expect(statusValues(f, "pstack-ro")).toEqual(["readonly"]);
      expect(f.session.getActiveToolNames().includes("bash"), "command arm is not released").toBe(false);
    }),
  );
});

test("readonly mode blocks mutating pstack tools", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");

    f.faux.setResponses([
      f.faux.assistant(
        [f.faux.toolCall("pstack_worktree", { action: "create", name: "x" })],
        { stopReason: "toolUse" },
      ),
      f.faux.assistant("stopped"),
    ]);

    await f.prompt("create a worktree please");

    const toolEnd = f.events.find(
      (e) => e.type === "tool_execution_end" && e.toolName === "pstack_worktree",
    );
    expect(toolEnd, "tool_execution_end for pstack_worktree not found").toBeTruthy();
    expect(toolEnd.isError, "Tool should have been blocked").toBe(true);
    expect(toolEnd.result.content[0].text).toBe("pstack session readonly: blocked mutating pstack_worktree.");
  });
});

test("pstack-readonly-off restores write tools", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");

    const readonlyTools = f.session.getActiveToolNames();
    expect(!readonlyTools.includes("bash"), "bash blocked during readonly").toBeTruthy();

    await f.prompt("/pstack-readonly-off");

    expect(f.ui.notifications.some(([type, message]) => type === "info" && message === "Session readonly off."), `notifications: ${JSON.stringify(f.ui.notifications)}`).toBeTruthy();

    const restoredTools = f.session.getActiveToolNames();
    expect(restoredTools.includes("bash"), "bash should be restored").toBeTruthy();
    expect(restoredTools.includes("write"), "write should be restored").toBeTruthy();
    expect(restoredTools.includes("edit"), "edit should be restored").toBeTruthy();
  });
});
