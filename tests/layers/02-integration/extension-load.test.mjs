import { expect, test } from "vitest";
import { withSession } from "../../support/session.mjs";

test("extension loads with zero errors", async () => {
  await withSession(async (f) => {
    const loaded = f.session.resourceLoader.getExtensions();
    expect(loaded.errors.length, `Extension load errors: ${JSON.stringify(loaded.errors)}`).toBe(0);
  });
});

test("pstack tools are registered", async () => {
  await withSession(async (f) => {
    expect(f.tool("pstack_spawn"), "pstack_spawn not found").toBeTruthy();
    expect(f.tool("pstack_jobs"), "pstack_jobs not found").toBeTruthy();

    const activeTools = f.session.getActiveToolNames();
    const pstackTools = activeTools.filter((name) => name.startsWith("pstack_"));
    expect(pstackTools.length >= 10, `Expected >= 10 pstack tools, got ${pstackTools.length}`).toBeTruthy();
  });
});

test("commands are registered", async () => {
  await withSession(async (f) => {
    const loaded = f.session.resourceLoader.getExtensions();
    const commands = loaded.extensions.flatMap((e) => [...e.commands.keys()]);
    expect(commands.length >= 55, `Expected >= 55 commands, got ${commands.length}`).toBeTruthy();
    expect(commands.includes("pstack-readonly"), "pstack-readonly command missing").toBeTruthy();
  });
});

test("bind emits session_start and records no handler errors", async () => {
  await withSession(async (f) => {
    const start = f.extensionEvents.find((e) => e.type === "session_start");
    expect(start, `session_start not found. Extension events: ${f.extensionEvents.map((e) => e.type).join(", ")}`).toBeTruthy();
    expect(start.reason).toBe("startup");
    expect(f.handlerErrors, `Handler errors: ${JSON.stringify(f.handlerErrors)}`).toEqual([]);
  });
});

test("scripted tool call executes", async () => {
  await withSession(async (f) => {
    f.faux.setResponses([
      f.faux.assistant([f.faux.toolCall("pstack_jobs", { action: "list" })], { stopReason: "toolUse" }),
      f.faux.assistant("done"),
    ]);

    await f.prompt("list jobs");

    const toolEnd = f.events.find((e) => e.type === "tool_execution_end");
    expect(toolEnd, `No tool_execution_end event. Events: ${f.events.map((e) => e.type).join(", ")}`).toBeTruthy();
    expect(toolEnd.toolName).toBe("pstack_jobs");
    expect(toolEnd.isError, `Tool execution failed: ${JSON.stringify(toolEnd)}`).toBe(false);
    expect(toolEnd.result.content[0].text).toBe("concurrency 0/8 waiting=0\n(no background jobs)");
  });
});

test("inline extension factory is loaded alongside file extensions", async () => {
  const factory = (pi) => {
    pi.registerCommand("probe-inline-command", {
      description: "inline probe command",
      handler: async () => {},
    });
  };

  await withSession(
    async (f) => {
      const loaded = f.session.resourceLoader.getExtensions();
      const commands = loaded.extensions.flatMap((e) => [...e.commands.keys()]);
      expect(commands.includes("probe-inline-command"), `inline command missing from ${JSON.stringify(commands)}`).toBeTruthy();
      expect(f.session.extensionRunner.getCommand("probe-inline-command"), "inline command not resolvable from the runner").toBeTruthy();
      expect(f.tool("pstack_spawn"), "file extension still loaded beside the inline factory").toBeTruthy();
    },
    { extensionFactories: [factory] },
  );
});

test("ui capture records readonly notification and status, then restores tools", async () => {
  await withSession(async (f) => {
    expect(f.session.getActiveToolNames().includes("bash"), "bash active before readonly").toBeTruthy();

    await f.prompt("/pstack-readonly");

    expect(f.ui.notifications.some(
        ([type, message]) =>
          type === "info" && message === "Session readonly on (command): write/edit/bash blocked.",
      ), `notifications: ${JSON.stringify(f.ui.notifications)}`).toBeTruthy();
    expect(f.ui.statuses.some(([key, text]) => key === "pstack-ro" && text === "readonly"), `statuses: ${JSON.stringify(f.ui.statuses)}`).toBeTruthy();
    expect(!f.session.getActiveToolNames().includes("bash"), "bash stripped while readonly").toBeTruthy();
    expect(f.handlerErrors, `Handler errors: ${JSON.stringify(f.handlerErrors)}`).toEqual([]);

    await f.prompt("/pstack-readonly-off");

    expect(f.session.getActiveToolNames().includes("bash"), `bash not restored: ${JSON.stringify(f.session.getActiveToolNames())}`).toBeTruthy();
  });
});
