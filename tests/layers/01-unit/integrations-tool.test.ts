import { expect, test } from "vitest";
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
      expect(found, `${name} is registered`).toBeTruthy();
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

  expect(tool.name).toBe("pstack_integrations");
  expect(tool.label).toBe("Pstack Integrations");
  expect(tool.promptSnippet).toBe("Report integration capability availability and query a configured adapter");
  expect(tool.promptGuidelines).toEqual([
    "pstack_integrations must report an unavailable category as a null finding, never skip it",
    "pstack_integrations capability availability comes from the tool, not from guessing tool names",
  ]);

  const accepted = { action: "query", capability: "team-chat", query: "x", paths: ["a"], limit: 1 };
  expect(Check(tool.parameters, accepted)).toBe(true);
  expect(Check(tool.parameters, { capability: "team-chat" })).toBe(false);
  expect(Check(tool.parameters, { action: "list", limit: 0 })).toBe(false);
  expect(Check(tool.parameters, { action: "list", limit: 201 })).toBe(false);
  expect(Check(tool.parameters, { action: "list", paths: "a" })).toBe(false);

  const ctx = { cwd: tempCwd() };
  await expect(() => tool.execute("t", { action: "bogus" }, undefined, undefined, ctx)).rejects.toThrow(/action must be one of/);
  await expect(() => tool.execute("t", { action: "query" }, undefined, undefined, ctx)).rejects.toThrow(/capability must be one of/);
});

test("integrations-tool-02 lists all nine categories with availability and tool names", async () => {
  const dir = configDir();
  const cwd = tempCwd();
  await withIntegrationsDir(dir, async () => {
    const env = integrationsEnv();
    const tool = env.tool("pstack_integrations");

    const list = await tool.execute("t", { action: "list" }, undefined, undefined, { cwd });
    const rows = list.content[0].text.split("\n").slice(1);
    expect(rows.length).toBe(9);
    expect(rows.map((row) => row.split(":")[0])).toEqual(INTEGRATION_CATEGORIES);
    expect(rows.every((row) => row.includes("tool="))).toBe(true);
    expect(rows[0].includes("unavailable")).toBe(true);
    expect(rows[0].includes("pstack_integrations")).toBe(true);
    expect(rows[1].includes(join(dir, "integrations.json"))).toBe(true);
    expect(list.details.total).toBe(9);
    expect(list.details.available).toBe(2);

    const status = await tool.execute("t", { action: "status" }, undefined, undefined, { cwd });
    const probe = await tool.execute("t", { action: "probe" }, undefined, undefined, { cwd });
    expect(status.details.total).toBe(9);
    expect(probe.details.total).toBe(9);
    expect(availabilityTokens(status)).toEqual(availabilityTokens(list));
    expect(availabilityTokens(probe)).toEqual(availabilityTokens(list));
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
    expect(text.includes("coverage gap")).toBe(true);
    expect(text.includes("missing prerequisite")).toBe(true);
    expect(text.includes(join(dir, "integrations.json"))).toBe(true);
    expect(text.includes("pstack_source_control")).toBe(false);
    expect(result.details.coverageGap).toBe(true);
    expect(result.details.substituted).toBe(false);
    expect(result.details.availability).toBe("unavailable");
    expect(result.details.capability).toBe("issue-tracker");

    expect(env.calls(), "an unavailable command-adapter query spawns nothing").toEqual([]);
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
    expect(list.content[0].text.includes("team-chat: available")).toBe(true);
    expect(list.content[0].text.includes("command adapter 'node' (2 args)")).toBe(true);

    const query = await tool.execute(
      "t",
      { action: "query", capability: "team-chat", query: "topic" },
      undefined,
      undefined,
      { cwd },
    );
    const nodeCalls = env.calls().filter((call) => call.command === "node");
    expect(nodeCalls.length).toBe(1);
    expect(nodeCalls[0].args).toEqual(["-e", "process.stdout.write('message-42')", "topic"]);
    expect(query.content[0].text.includes("message-42")).toBe(true);
    expect(query.content[0].text.includes("exit 0")).toBe(true);
    expect(query.details.coverageGap).toBe(false);

    const callsBefore = env.calls().length;
    const delegated = await tool.execute(
      "t",
      { action: "query", capability: "cli-tui" },
      undefined,
      undefined,
      { cwd },
    );
    expect(delegated.details.delegatedTo).toBe("pstack_control_cli");
    expect(delegated.details.executed).toBe(false);
    expect(delegated.details.coverageGap).toBe(false);
    expect(env.calls().length, "the pointer runs no adapter and no probe").toBe(callsBefore);
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
    expect(probe.content[0].text.includes("source-control: available-git-only")).toBe(true);
    expect(probe.details.available).toBe(3);
    expect(probe.details.total).toBe(9);

    const gap = await tool.execute(
      "t",
      { action: "query", capability: "source-control", query: "prs:topic" },
      undefined,
      undefined,
      { cwd: repo },
    );
    expect(gap.content[0].text.includes("coverage gap")).toBe(true);
    expect(gap.content[0].text.includes("gh")).toBe(true);
    expect(gap.details.coverageGap).toBe(true);
    expect(gitOnly.calls().some((call) => call.command === "gh" && call.args[0] === "search"), "no gh search call without gh on PATH").toBe(false);
    expect(gitOnly.calls().some((call) => call.command === "git" && call.args[0] === "rev-parse"), "the git work tree probe ran").toBe(true);

    const withGh = integrationsEnv((call) => realExec(call, { code: 0, stdout: "gh version 2.101.0", stderr: "" }));
    const ghTool = withGh.tool("pstack_integrations");
    const full = await ghTool.execute("t", { action: "probe" }, undefined, undefined, { cwd: repo });
    expect(full.content[0].text.includes("source-control: available")).toBe(true);

    const log = await ghTool.execute(
      "t",
      { action: "query", capability: "source-control", query: "log" },
      undefined,
      undefined,
      { cwd: repo },
    );
    expect(log.content[0].text.includes("log-line ONE")).toBe(true);
    expect(log.details.code).toBe(0);
  });
});

test("integrations-tool-06 allows read-only inventory and blocks a query under readonly", () => {
  const policy = READONLY_TOOL_POLICIES.pstack_integrations;

  expect(policy({ action: "list" }).action).toBe("allow");
  expect(policy({ action: "status" }).action).toBe("allow");
  expect(policy({ action: "probe" }).action).toBe("allow");

  const blocked = policy({ action: "query", capability: "issue-tracker" });
  expect(blocked.action).toBe("block");
  expect(String(blocked.reason).includes("pstack_integrations query")).toBe(true);
});
