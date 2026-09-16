import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShellRefusalError, scanTokens } from "../../../extensions/agents/shell-tokenize.ts";
import { parseShellCommand, subcommandOf } from "../../../extensions/agents/shell-parse.ts";
import { __setGuardPolicyForTests, evaluateGuard } from "../../../extensions/agents/policy-guard.ts";
import { compileTaskPolicy, normalizePolicyObject } from "../../../extensions/agents/policy.ts";
import { registerTask } from "../../../extensions/agents/task.ts";
import { registerAgents } from "../../../extensions/agents/index.ts";

const GENERAL_POLICY = {
  filesystem: "workspace-write",
  shell: "full",
  git: "branch-write",
  network: "allowed",
  integrations: "inherit",
  environment: "local",
  background: false,
  isolation: "session",
} as const;

interface CapturedTool {
  name: string;
  label: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

function refusalConstruct(run: () => unknown): string {
  try {
    run();
    return "no refusal";
  } catch (err) {
    return err instanceof ShellRefusalError ? err.construct : "not a ShellRefusalError";
  }
}

function taskTool(activeToolCalls: { count: number }): CapturedTool {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    on() {
      throw new Error("registerTask must not subscribe to host events");
    },
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    getActiveTools() {
      activeToolCalls.count += 1;
      throw new Error("the parent host exposes no active tool list");
    },
  };
  registerTask(pi as never);
  const tool = tools.get("pstack_task");
  if (!tool) throw new Error("pstack_task was not registered");
  return tool;
}

function agentsHost(): { toolNames: readonly string[]; handlerCount: number } {
  let toolNames: readonly string[] = [];
  let handlerCount = 0;
  const pi = {
    on() {
      handlerCount += 1;
    },
    registerTool(definition: { name: string }) {
      toolNames = [...toolNames, definition.name];
    },
    getActiveTools() {
      return ["read"];
    },
  };
  registerAgents(pi as never);
  return { toolNames, handlerCount };
}

test("scanTokens folds escapes and line continuations into a single word", () => {
  expect(scanTokens("echo a\\ b")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "a b", dynamic: false },
    ],
    substitutions: [],
  });
  expect(scanTokens("echo a\\\nb")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "ab", dynamic: false },
    ],
    substitutions: [],
  });
  expect(scanTokens("echo a\\")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "a", dynamic: false },
    ],
    substitutions: [],
  });
});

test("scanTokens unescapes a double-quoted word and folds its escaped newline", () => {
  expect(scanTokens('echo "a\\"b"')).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: 'a"b', dynamic: false },
    ],
    substitutions: [],
  });
  expect(scanTokens('echo "a\\qb"')).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "a\\qb", dynamic: false },
    ],
    substitutions: [],
  });
  expect(scanTokens('echo "a\\\nb"')).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "ab", dynamic: false },
    ],
    substitutions: [],
  });
  expect(scanTokens('echo "`date`"')).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["date"],
  });
});

test("scanTokens keeps a bare dollar literal and a result that is not a word", () => {
  expect(scanTokens("echo $")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "$", dynamic: false },
    ],
    substitutions: [],
  });
  expect(scanTokens("echo $%b")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "$%b", dynamic: false },
    ],
    substitutions: [],
  });
});

test("scanTokens reads command substitutions that contain quotes and escapes", () => {
  expect(scanTokens("echo $(echo a\\ b)")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["echo a\\ b"],
  });
  expect(scanTokens("echo $(echo 'x')")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["echo 'x'"],
  });
  expect(scanTokens('echo $(echo "x")')).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ['echo "x"'],
  });
  expect(scanTokens('echo $(echo "a\\b")')).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ['echo "a\\b"'],
  });
});

test("scanTokens reads a backtick substitution whose body contains a backslash", () => {
  expect(scanTokens("echo `echo a\\b`")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["echo a\\b"],
  });
});

test("scanTokens tracks escapes, nesting, and backticks inside a braced parameter", () => {
  expect(scanTokens("echo ${a\\}b}")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "${a\\}b}", dynamic: true },
    ],
    substitutions: [],
  });
  expect(scanTokens("echo ${a${b}c}")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "${a${b}c}", dynamic: true },
    ],
    substitutions: [],
  });
  expect(scanTokens("echo ${x:-`date`}")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "${x:-`date`}", dynamic: true },
    ],
    substitutions: ["date"],
  });
});

test("scanTokens marks an ANSI-C quote dynamic", () => {
  expect(scanTokens("echo $'x'")).toEqual({
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "x", dynamic: true },
    ],
    substitutions: [],
  });
});

test("scanTokens refuses each construct it cannot close", () => {
  expect(refusalConstruct(() => scanTokens("echo $(echo 'x)"))).toBe("unbalanced command substitution `$(`");
  expect(refusalConstruct(() => scanTokens('echo $(echo "x)'))).toBe("unbalanced command substitution `$(`");
  expect(refusalConstruct(() => scanTokens("echo ${oops"))).toBe("unbalanced parameter expansion `${`");
  expect(refusalConstruct(() => scanTokens("echo `oops"))).toBe("unbalanced backtick substitution");
  expect(refusalConstruct(() => scanTokens("echo $'x"))).toBe("unbalanced ANSI-C quote");
  expect(refusalConstruct(() => scanTokens("echo ok"))).toBe("no refusal");
});

test("parseShellCommand refuses a redirection with no target", () => {
  expect(parseShellCommand("cmd < ;")).toEqual({
    executions: [],
    redirects: [],
    refusals: ["redirection without a target"],
  });
  expect(parseShellCommand("cmd > > out")).toEqual({
    executions: [],
    redirects: [],
    refusals: ["redirection without a target"],
  });
});

test("parseShellCommand refuses a wrapper that runs no command", () => {
  expect(parseShellCommand("env FOO=1")).toEqual({ executions: [], redirects: [], refusals: [] });
  expect(parseShellCommand("sudo -n")).toEqual({ executions: [], redirects: [], refusals: [] });
});

test("parseShellCommand refuses nesting deeper than eight levels", () => {
  const nested = Array.from({ length: 9 }).reduce((acc) => `true x$(${acc})`, "true");
  const parsed = parseShellCommand(nested);
  expect(parsed.executions.map((execution) => execution.name)).toEqual(Array.from({ length: 9 }, () => "true"));
  expect(parsed.executions[8].args).toEqual([{ value: "x", dynamic: true }]);
  expect(parsed.redirects).toEqual([]);
  expect(parsed.refusals).toEqual(["shell nested deeper than 8 levels"]);
});

test("subcommandOf lowers the subcommand and skips its value flag", () => {
  expect(subcommandOf(
      [
        { value: "--git-dir", dynamic: false },
        { value: "/srv/repo", dynamic: false },
        { value: "PUSH", dynamic: false },
      ],
      new Set(["--git-dir"]),
    )).toEqual({ sub: "push", dynamic: false });
  expect(subcommandOf(
      [
        { value: "-C", dynamic: false },
        { value: "/srv/repo", dynamic: false },
        { value: "$SUB", dynamic: true },
      ],
      new Set(["-C"]),
    )).toEqual({ dynamic: true });
  expect(subcommandOf([{ value: "--bare", dynamic: false }], new Set(["--git-dir"]))).toEqual({
    dynamic: false,
  });
});

test("filesystem read-only refuses a git subcommand built from a variable", () => {
  const readOnly = compileTaskPolicy({ filesystem: "read-only", shell: "full" }, "general");
  expect(evaluateGuard(readOnly, { toolName: "bash", input: { command: "git $SUB status" } })).toEqual({
    block: true,
    reason: "pstack policy guard: filesystem read-only cannot verify a git subcommand built from a variable",
  });
  expect(evaluateGuard(readOnly, { toolName: "bash", input: { command: "git log --oneline" } })).toBe(undefined);
});

test("normalizePolicyObject validates every axis and rejects a non-object", () => {
  expect(normalizePolicyObject(GENERAL_POLICY)).toEqual(GENERAL_POLICY);
  expect(Object.isFrozen(normalizePolicyObject(GENERAL_POLICY))).toBe(true);
  expect(normalizePolicyObject({ ...GENERAL_POLICY, integrations: ["browser-ui"], extra: 1 })).toEqual({
    ...GENERAL_POLICY,
    integrations: ["browser-ui"],
  });
  expect(() => normalizePolicyObject(null)).toThrow(/invalid filesystem 'undefined'; allowed: read-only, workspace-write/);
  expect(() => normalizePolicyObject([])).toThrow(/invalid filesystem 'undefined'/);
  expect(() => normalizePolicyObject({ ...GENERAL_POLICY, background: "yes" })).toThrow(/invalid background 'yes'; allowed: true, false/);
});

test("pstack_task survives a parent host whose active tool list throws", async () => {
  const previous = process.env.PSTACK_HOSTED_URL;
  const realFetch = globalThis.fetch;
  let posted: readonly string[] = [];
  process.env.PSTACK_HOSTED_URL = "http://worker.test/";
  globalThis.fetch = (async (url: string | URL | Request) => {
    posted = [...posted, String(url)];
    return new Response("hosted worker accepted", { status: 202, statusText: "Accepted" });
  }) as typeof globalThis.fetch;
  const cwd = mkdtempSync(join(tmpdir(), "pstack-agents-functions-"));
  const activeToolCalls = { count: 0 };
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "pstack-models.json"), JSON.stringify({ version: 1, roles: {} }), "utf8");
    const tool = taskTool(activeToolCalls);
    const reply = await tool.execute(
      "call-1",
      { prompt: "RAW BRIEF", subagent_type: "general", environment: "hosted" },
      undefined,
      undefined,
      { model: { provider: "anthropic", id: "claude-parent-4-5" }, cwd, isProjectTrusted: () => true },
    );
    expect(activeToolCalls.count).toBe(2);
    expect(posted).toEqual(["http://worker.test/v1/tasks"]);
    expect(reply.details.hosted).toBe(true);
    expect(reply.details.status).toBe(202);
    expect(reply.details.role).toBe("general");
    expect(reply.details.thinkingLevel).toBe(null);
    expect(reply.content[0].text).toBe("hosted worker accepted");
    expect(String(reply.details.runId)).toMatch(/^run-[0-9a-z]+-[0-9a-f]{8}$/);
    expect(reply.details.policy).toEqual({ ...GENERAL_POLICY, environment: "hosted", isolation: "remote" });
    expect(reply.content[1].text).toBe("policy: filesystem=workspace-write shell=full git=branch-write network=allowed integrations=inherit environment=hosted background=false isolation=remote; thinkingLevel=default");
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_HOSTED_URL");
    else process.env.PSTACK_HOSTED_URL = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registerAgents registers the task tool and no guard hook without a child policy", () => {
  const previous = process.env.PSTACK_CHILD_POLICY;
  Reflect.deleteProperty(process.env, "PSTACK_CHILD_POLICY");
  __setGuardPolicyForTests(null);
  try {
    const host = agentsHost();
    expect(host.toolNames).toEqual(["pstack_task"]);
    expect(host.handlerCount).toBe(0);
  } finally {
    if (previous !== undefined) process.env.PSTACK_CHILD_POLICY = previous;
    __setGuardPolicyForTests(null);
  }
});
