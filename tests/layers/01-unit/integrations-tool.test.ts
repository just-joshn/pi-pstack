import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { INTEGRATION_CATEGORIES } from "../../../extensions/agents/policy.ts";
import { registerIntegrations } from "../../../extensions/integrations/index.ts";
import { READONLY_TOOL_POLICIES } from "../../../extensions/readonly-state/index.ts";

type Schema = Parameters<typeof Check>[0];
type ExecOptions = { signal?: AbortSignal | null; timeout?: number; cwd?: string };
type ExecCall = { command: string; args: string[]; opts: ExecOptions | undefined };
type ExecResult = { code: number; stdout: string; stderr: string };
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};
type ToolExecute = (
  id: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<ToolResult>;
type CapturedTool = {
  name: string;
  label?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Schema;
  execute: ToolExecute;
};
type ToolEnv = { tool: (name: string) => CapturedTool; calls: () => ExecCall[] };

const DEFAULT_TOOLS = ["pstack_control_cli", "pstack_control_ui"];
const defaultExec = (): ExecResult => ({ code: 0, stdout: "", stderr: "" });

function integrationsEnv(handler: (call: ExecCall) => ExecResult = defaultExec): ToolEnv {
  let registered: CapturedTool[] = [];
  let calls: ExecCall[] = [];
  const pi = {
    registerTool(definition: CapturedTool) {
      registered = [...registered, definition];
    },
    registerCommand() {},
    getAllTools() {
      return DEFAULT_TOOLS.map((name) => ({ name }));
    },
    exec(command: string, args: string[], opts?: ExecOptions) {
      const call: ExecCall = { command, args, opts };
      calls = [...calls, call];
      return Promise.resolve(handler(call));
    },
  };
  registerIntegrations(pi as never);
  return {
    tool(name) {
      const found = registered.find((candidate) => candidate.name === name);
      assert.ok(found, `${name} is registered`);
      return found;
    },
    calls: () => calls,
  };
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "integrations-cwd-"));
}

function configDir(entries?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "integrations-tool-"));
  if (entries !== undefined) {
    writeFileSync(join(dir, "integrations.json"), JSON.stringify(entries), "utf8");
  }
  return dir;
}

async function withIntegrationsDir(dir: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PSTACK_INTEGRATIONS_DIR;
  process.env.PSTACK_INTEGRATIONS_DIR = dir;
  try {
    await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_INTEGRATIONS_DIR");
    else process.env.PSTACK_INTEGRATIONS_DIR = previous;
  }
}

function availabilityTokens(result: ToolResult): string[] {
  const categories = result.details.categories as Array<{ availability: string }>;
  return categories.map((category) => category.availability);
}

function realExec(call: ExecCall, ghResult: ExecResult): ExecResult {
  if (call.command === "git" && call.args[0] === "rev-parse") {
    const stdout = execFileSync("git", call.args, { cwd: call.opts?.cwd, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  }
  if (call.command === "gh") return ghResult;
  if (call.command === "git" && call.args[0] === "log") {
    return { code: 0, stdout: "log-line ONE\nlog-line TWO", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
}

test("integrations-tool-01 registers pstack_integrations with the mandated actions and guidelines", async () => {
  const env = integrationsEnv();
  const tool = env.tool("pstack_integrations");

  assert.equal(tool.name, "pstack_integrations");
  assert.equal(tool.label, "Pstack Integrations");
  assert.equal(tool.promptSnippet, "Report integration capability availability and query a configured adapter");
  assert.deepEqual(tool.promptGuidelines, [
    "pstack_integrations must report an unavailable category as a null finding, never skip it",
    "pstack_integrations capability availability comes from the tool, not from guessing tool names",
  ]);

  const accepted = { action: "query", capability: "team-chat", query: "x", paths: ["a"], limit: 1 };
  assert.equal(Check(tool.parameters, accepted), true);
  assert.equal(Check(tool.parameters, { capability: "team-chat" }), false);
  assert.equal(Check(tool.parameters, { action: "list", limit: 0 }), false);
  assert.equal(Check(tool.parameters, { action: "list", limit: 201 }), false);
  assert.equal(Check(tool.parameters, { action: "list", paths: "a" }), false);

  const ctx = { cwd: tempCwd() };
  await assert.rejects(
    () => tool.execute("t", { action: "bogus" }, undefined, undefined, ctx),
    /action must be one of/,
  );
  await assert.rejects(
    () => tool.execute("t", { action: "query" }, undefined, undefined, ctx),
    /capability must be one of/,
  );
});

test("integrations-tool-02 lists all nine categories with availability and tool names", async () => {
  const dir = configDir();
  const cwd = tempCwd();
  await withIntegrationsDir(dir, async () => {
    const env = integrationsEnv();
    const tool = env.tool("pstack_integrations");

    const list = await tool.execute("t", { action: "list" }, undefined, undefined, { cwd });
    const rows = list.content[0].text.split("\n").slice(1);
    assert.equal(rows.length, 9);
    assert.deepEqual(
      rows.map((row) => row.split(":")[0]),
      INTEGRATION_CATEGORIES,
    );
    assert.equal(
      rows.every((row) => row.includes("tool=")),
      true,
    );
    assert.equal(rows[0].includes("unavailable"), true);
    assert.equal(rows[0].includes("pstack_source_control"), true);
    assert.equal(rows[1].includes(join(dir, "integrations.json")), true);
    assert.equal(list.details.total, 9);
    assert.equal(list.details.available, 2);

    const status = await tool.execute("t", { action: "status" }, undefined, undefined, { cwd });
    const probe = await tool.execute("t", { action: "probe" }, undefined, undefined, { cwd });
    assert.equal(status.details.total, 9);
    assert.equal(probe.details.total, 9);
    assert.deepEqual(availabilityTokens(status), availabilityTokens(list));
    assert.deepEqual(availabilityTokens(probe), availabilityTokens(list));
  });
});

test("integrations-tool-03 returns an explicit coverage gap and never substitutes another capability", async () => {
  const dir = configDir();
  const cwd = tempCwd();
  await withIntegrationsDir(dir, async () => {
    const env = integrationsEnv();
    const tool = env.tool("pstack_integrations");

    const result = await tool.execute(
      "t",
      { action: "query", capability: "issue-tracker" },
      undefined,
      undefined,
      { cwd },
    );
    const text = result.content[0].text;
    assert.equal(text.includes("coverage gap"), true);
    assert.equal(text.includes("missing prerequisite"), true);
    assert.equal(text.includes(join(dir, "integrations.json")), true);
    assert.equal(text.includes("pstack_source_control"), false);
    assert.equal(result.details.coverageGap, true);
    assert.equal(result.details.substituted, false);
    assert.equal(result.details.availability, "unavailable");
    assert.equal(result.details.capability, "issue-tracker");

    assert.deepEqual(env.calls(), [], "an unavailable command-adapter query spawns nothing");
  });
});

test("integrations-tool-04 runs a configured command adapter and returns its output", async () => {
  const dir = configDir({
    "team-chat": {
      adapter: "command",
      command: ["node", "-e", "process.stdout.write('message-42')"],
      description: "team chat adapter",
    },
  });
  const cwd = tempCwd();
  await withIntegrationsDir(dir, async () => {
    const env = integrationsEnv(() => ({ code: 0, stdout: "message-42", stderr: "" }));
    const tool = env.tool("pstack_integrations");

    const list = await tool.execute("t", { action: "list" }, undefined, undefined, { cwd });
    assert.equal(list.content[0].text.includes("team-chat: available"), true);
    assert.equal(list.content[0].text.includes("command adapter 'node' (2 args)"), true);

    const query = await tool.execute(
      "t",
      { action: "query", capability: "team-chat", query: "topic" },
      undefined,
      undefined,
      { cwd },
    );
    const nodeCalls = env.calls().filter((call) => call.command === "node");
    assert.equal(nodeCalls.length, 1);
    assert.deepEqual(nodeCalls[0].args, ["-e", "process.stdout.write('message-42')", "topic"]);
    assert.equal(query.content[0].text.includes("message-42"), true);
    assert.equal(query.content[0].text.includes("exit 0"), true);
    assert.equal(query.details.coverageGap, false);

    const callsBefore = env.calls().length;
    const delegated = await tool.execute(
      "t",
      { action: "query", capability: "cli-tui" },
      undefined,
      undefined,
      { cwd },
    );
    assert.equal(delegated.details.delegatedTo, "pstack_control_cli");
    assert.equal(delegated.details.executed, false);
    assert.equal(delegated.details.coverageGap, false);
    assert.equal(env.calls().length, callsBefore, "the pointer runs no adapter and no probe");
  });
});

test("integrations-tool-05 probes source-control inside a real git work tree", async () => {
  const dir = configDir();
  const repo = mkdtempSync(join(tmpdir(), "integrations-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  await withIntegrationsDir(dir, async () => {
    const gitOnly = integrationsEnv((call) => realExec(call, { code: 1, stdout: "", stderr: "gh: not found" }));
    const tool = gitOnly.tool("pstack_integrations");

    const probe = await tool.execute("t", { action: "probe" }, undefined, undefined, { cwd: repo });
    assert.equal(probe.content[0].text.includes("source-control: available-git-only"), true);
    assert.equal(probe.details.available, 3);
    assert.equal(probe.details.total, 9);

    const gap = await tool.execute(
      "t",
      { action: "query", capability: "source-control", query: "prs:topic" },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.equal(gap.content[0].text.includes("coverage gap"), true);
    assert.equal(gap.content[0].text.includes("gh"), true);
    assert.equal(gap.details.coverageGap, true);
    assert.equal(
      gitOnly.calls().some((call) => call.command === "gh" && call.args[0] === "search"),
      false,
      "no gh search call without gh on PATH",
    );
    assert.equal(
      gitOnly.calls().some((call) => call.command === "git" && call.args[0] === "rev-parse"),
      true,
      "the git work tree probe ran",
    );

    const withGh = integrationsEnv((call) => realExec(call, { code: 0, stdout: "gh version 2.101.0", stderr: "" }));
    const ghTool = withGh.tool("pstack_integrations");
    const full = await ghTool.execute("t", { action: "probe" }, undefined, undefined, { cwd: repo });
    assert.equal(full.content[0].text.includes("source-control: available"), true);

    const log = await ghTool.execute(
      "t",
      { action: "query", capability: "source-control", query: "log" },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.equal(log.content[0].text.includes("log-line ONE"), true);
    assert.equal(log.details.code, 0);
  });
});

test("integrations-tool-06 allows read-only inventory and blocks a query under readonly", () => {
  const policy = READONLY_TOOL_POLICIES.pstack_integrations;

  assert.equal(policy({ action: "list" }).action, "allow");
  assert.equal(policy({ action: "status" }).action, "allow");
  assert.equal(policy({ action: "probe" }).action, "allow");

  const blocked = policy({ action: "query", capability: "issue-tracker" });
  assert.equal(blocked.action, "block");
  assert.equal(String(blocked.reason).includes("pstack_integrations query"), true);
});
