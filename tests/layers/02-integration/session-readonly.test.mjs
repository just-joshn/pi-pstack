import { test } from "node:test";
import assert from "node:assert/strict";
import { withSession } from "../../support/session.mjs";

test("pstack-readonly command arms readonly mode", async () => {
  await withSession(async (f) => {
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

    const activeTools = f.session.getActiveToolNames();
    assert.ok(!activeTools.includes("bash"), "bash should be blocked");
    assert.ok(!activeTools.includes("write"), "write should be blocked");
    assert.ok(!activeTools.includes("edit"), "edit should be blocked");
    assert.ok(activeTools.includes("read"), "read should be available");
    assert.ok(activeTools.includes("grep"), "grep should be available");
    assert.ok(activeTools.includes("find"), "find should be available");
    assert.ok(activeTools.includes("ls"), "ls should be available");
    assert.ok(activeTools.includes("pstack_jobs"), "pstack_jobs should be available");

    const entries = f.session.sessionManager.getEntries();
    const customEntry = entries.find(
      (e) => e.type === "custom" && e.customType === "pstack-session-readonly",
    );
    assert.ok(customEntry, "pstack-session-readonly custom entry not found");
  });
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
    assert.ok(toolEnd, "tool_execution_end for pstack_worktree not found");
    assert.equal(toolEnd.isError, true, "Tool should have been blocked");
    assert.equal(
      toolEnd.result.content[0].text,
      "pstack session readonly: blocked mutating pstack_worktree.",
    );
  });
});

test("pstack-readonly-off restores write tools", async () => {
  await withSession(async (f) => {
    await f.prompt("/pstack-readonly");

    const readonlyTools = f.session.getActiveToolNames();
    assert.ok(!readonlyTools.includes("bash"), "bash blocked during readonly");

    await f.prompt("/pstack-readonly-off");

    assert.ok(
      f.ui.notifications.some(([type, message]) => type === "info" && message === "Session readonly off."),
      `notifications: ${JSON.stringify(f.ui.notifications)}`,
    );

    const restoredTools = f.session.getActiveToolNames();
    assert.ok(restoredTools.includes("bash"), "bash should be restored");
    assert.ok(restoredTools.includes("write"), "write should be restored");
    assert.ok(restoredTools.includes("edit"), "edit should be restored");
  });
});
