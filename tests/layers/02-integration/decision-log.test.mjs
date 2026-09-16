import { expect, test } from "vitest";
import { withSession } from "../../support/session.mjs";

test("scripted round trip logs decision with correct fields", async () => {
  await withSession(async (f) => {
    f.faux.setResponses([
      f.faux.assistant(
        [
          f.faux.toolCall("pstack_decision_log", {
            phase: "probe",
            decision: "d",
            why: "w",
            evidence: "e",
            result: "r",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      f.faux.assistant("done"),
    ]);

    await f.prompt("log a decision");

    const toolEnd = f.events.find(
      (e) => e.type === "tool_execution_end" && e.toolName === "pstack_decision_log",
    );
    expect(toolEnd, "tool_execution_end for pstack_decision_log not found").toBeTruthy();
    expect(toolEnd.isError, `Tool execution failed: ${JSON.stringify(toolEnd)}`).toBe(false);
    expect(toolEnd.result.content[0].text).toBe(`Logged decision to ${f.tmp.cwd}/.pi/decisions.tsv`);

    const tsv = f.read(".pi/decisions.tsv");
    expect(tsv.includes("probe\td\tw\te\tr"), `Expected tab-separated row. Got: ${tsv}`).toBeTruthy();

    const entries = f.session.sessionManager.getEntries();
    const customEntry = entries.find((e) => e.type === "custom" && e.customType === "pstack-decision");
    expect(customEntry, "pstack-decision custom entry not found").toBeTruthy();
  });
});

test("path allowlist rejects traversal attempts", async () => {
  await withSession(async (f) => {
    f.faux.setResponses([
      f.faux.assistant(
        [
          f.faux.toolCall("pstack_decision_log", {
            phase: "probe",
            decision: "d",
            why: "w",
            path: "../evil.tsv",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      f.faux.assistant("stopped"),
    ]);

    await f.prompt("log a bad decision");

    const toolEnd = f.events.find(
      (e) => e.type === "tool_execution_end" && e.toolName === "pstack_decision_log",
    );
    expect(toolEnd, "tool_execution_end not found").toBeTruthy();
    expect(toolEnd.isError, "Tool should have failed").toBe(true);
    expect(toolEnd.result.content[0].text.includes("pstack_decision_log path must stay under"), `Unexpected error: ${toolEnd.result.content[0].text}`).toBeTruthy();
  });
});
