import { expect, test } from "vitest";
import { withSession } from "../../support/session.mjs";

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
