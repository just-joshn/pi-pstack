import { test } from "node:test";
import assert from "node:assert/strict";
import { withSession } from "../../support/session.mjs";

test("extension loads with zero errors", async () => {
  await withSession(async (f) => {
    const loaded = f.session.resourceLoader.getExtensions();
    assert.equal(loaded.errors.length, 0, `Extension load errors: ${JSON.stringify(loaded.errors)}`);
  });
});

test("pstack tools are registered", async () => {
  await withSession(async (f) => {
    assert.ok(f.tool("pstack_spawn"), "pstack_spawn not found");
    assert.ok(f.tool("pstack_jobs"), "pstack_jobs not found");

    const activeTools = f.session.getActiveToolNames();
    const pstackTools = activeTools.filter((name) => name.startsWith("pstack_"));
    assert.ok(pstackTools.length >= 10, `Expected >= 10 pstack tools, got ${pstackTools.length}`);
  });
});

test("commands are registered", async () => {
  await withSession(async (f) => {
    const loaded = f.session.resourceLoader.getExtensions();
    const commands = loaded.extensions.flatMap((e) => [...e.commands.keys()]);
    assert.ok(commands.length >= 55, `Expected >= 55 commands, got ${commands.length}`);
    assert.ok(commands.includes("pstack-readonly"), "pstack-readonly command missing");
  });
});

test("bind emits session_start and records no handler errors", async () => {
  await withSession(async (f) => {
    const start = f.extensionEvents.find((e) => e.type === "session_start");
    assert.ok(start, `session_start not found. Extension events: ${f.extensionEvents.map((e) => e.type).join(", ")}`);
    assert.equal(start.reason, "startup");
    assert.deepEqual(f.handlerErrors, [], `Handler errors: ${JSON.stringify(f.handlerErrors)}`);
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
    assert.ok(toolEnd, `No tool_execution_end event. Events: ${f.events.map((e) => e.type).join(", ")}`);
    assert.equal(toolEnd.toolName, "pstack_jobs");
    assert.equal(toolEnd.isError, false, `Tool execution failed: ${JSON.stringify(toolEnd)}`);
    assert.equal(toolEnd.result.content[0].text, "concurrency 0/8 waiting=0\n(no background jobs)");
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
      assert.ok(
        commands.includes("probe-inline-command"),
        `inline command missing from ${JSON.stringify(commands)}`,
      );
      assert.ok(
        f.session.extensionRunner.getCommand("probe-inline-command"),
        "inline command not resolvable from the runner",
      );
      assert.ok(f.tool("pstack_spawn"), "file extension still loaded beside the inline factory");
    },
    { extensionFactories: [factory] },
  );
});

test("ui capture records readonly notification and status, then restores tools", async () => {
  await withSession(async (f) => {
    assert.ok(f.session.getActiveToolNames().includes("bash"), "bash active before readonly");

    await f.prompt("/pstack-readonly");

    assert.ok(
      f.ui.notifications.some(
        ([type, message]) =>
          type === "info" && message === "Session readonly on (command): write/edit/bash blocked.",
      ),
      `notifications: ${JSON.stringify(f.ui.notifications)}`,
    );
    assert.ok(
      f.ui.statuses.some(([key, text]) => key === "pstack-ro" && text === "readonly"),
      `statuses: ${JSON.stringify(f.ui.statuses)}`,
    );
    assert.ok(!f.session.getActiveToolNames().includes("bash"), "bash stripped while readonly");
    assert.deepEqual(f.handlerErrors, [], `Handler errors: ${JSON.stringify(f.handlerErrors)}`);

    await f.prompt("/pstack-readonly-off");

    assert.ok(
      f.session.getActiveToolNames().includes("bash"),
      `bash not restored: ${JSON.stringify(f.session.getActiveToolNames())}`,
    );
  });
});
