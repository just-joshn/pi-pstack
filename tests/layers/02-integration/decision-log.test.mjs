import { expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSession } from "../../support/session.mjs";
import { registerDecisionLog } from "../../../extensions/decision-log/index.ts";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";
const LOG_FACTORY = { extensionPaths: [], extensionFactories: [(pi) => registerDecisionLog(pi)] };

function decisionTool(f) {
  const tool = f.tool("pstack_decision_log");
  expect(tool, "pstack_decision_log is registered").toBeTruthy();
  const ctx = f.session._extensionRunner.createContext();
  return { tool, ctx, log: (params) => tool.definition.execute("d", params, undefined, undefined, ctx) };
}

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

test("decision log creates a missing file, preserves a valid header, and escapes tsv fields", async () => {
  await withSession(async (f) => {
    const { log } = decisionTool(f);

    const fresh = await log({ path: ".pi/audit/fresh.tsv", phase: "p", decision: "d", why: "w", evidence: "e", result: "r" });
    expect(fresh.details.path).toBe(join(f.tmp.cwd, ".pi", "audit", "fresh.tsv"));
    const created = f.read(join(".pi", "audit", "fresh.tsv")).trimEnd().split("\n");
    expect(created.length).toBe(2);
    expect(created[0]).toBe("ts\tphase\tdecision\twhy\tevidence\tresult");

    f.write(join(".pi", "audit", "valid.tsv"), `${HEADER}old\tr\n`);
    await log({ path: "@.pi/audit/valid.tsv", phase: "=formula", decision: "d2", why: "line\tone\ntwo", evidence: "@at", result: "-neg" });
    const rows = f.read(join(".pi", "audit", "valid.tsv")).trimEnd().split("\n");
    expect(rows.length).toBe(3);
    expect(rows[0]).toBe("ts\tphase\tdecision\twhy\tevidence\tresult");
    expect(rows[1]).toBe("old\tr");
    const columns = rows[2].split("\t");
    expect(columns.length).toBe(6);
    expect(columns[1]).toBe("'=formula");
    expect(columns[3]).toBe("line one two");
    expect(columns[4]).toBe("'@at");
    expect(columns[5]).toBe("'-neg");

    const custom = f.session.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "pstack-decision");
    expect(custom.length).toBe(2);
    expect(custom.at(-1).data.decision).toBe("d2");
    expect(custom.at(-1).data.path).toBe(join(f.tmp.cwd, ".pi", "audit", "valid.tsv"));
  }, LOG_FACTORY);
});

test.each(["=formula", "+plus", "-minus", "@mention"])(
  "decision log prefixes the leading %s so a spreadsheet keeps it literal",
  async (value) => {
    await withSession(async (f) => {
      const { log } = decisionTool(f);
      await log({ path: ".pi/audit/guard.tsv", phase: "p", decision: value, why: "w" });
      const rows = f.read(join(".pi", "audit", "guard.tsv")).trimEnd().split("\n");
      expect(rows.at(-1).split("\t")[2]).toBe(`'${value}`);
    }, LOG_FACTORY);
  },
);

test("decision log refuses a symlinked path that escapes the .pi allowlist", async () => {
  const outside = mkdtempSync(join(tmpdir(), "pstack-log-escape-"));
  try {
    await withSession(async (f) => {
      mkdirSync(join(f.tmp.cwd, ".pi"), { recursive: true });
      symlinkSync(outside, join(f.tmp.cwd, ".pi", "escape"));
      const { log } = decisionTool(f);
      await expect(() =>
        log({ path: ".pi/escape/row.tsv", phase: "p", decision: "d", why: "w" })).rejects.toThrow(/escapes the workspace root/);
      expect(existsSync(join(outside, "row.tsv"))).toBe(false);
    }, LOG_FACTORY);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
