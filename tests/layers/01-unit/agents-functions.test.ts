import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual(scanTokens("echo a\\ b"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "a b", dynamic: false },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens("echo a\\\nb"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "ab", dynamic: false },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens("echo a\\"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "a", dynamic: false },
    ],
    substitutions: [],
  });
});

test("scanTokens unescapes a double-quoted word and folds its escaped newline", () => {
  assert.deepEqual(scanTokens('echo "a\\"b"'), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: 'a"b', dynamic: false },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens('echo "a\\qb"'), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "a\\qb", dynamic: false },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens('echo "a\\\nb"'), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "ab", dynamic: false },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens('echo "`date`"'), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["date"],
  });
});

test("scanTokens keeps a bare dollar literal and a result that is not a word", () => {
  assert.deepEqual(scanTokens("echo $"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "$", dynamic: false },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens("echo $%b"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "$%b", dynamic: false },
    ],
    substitutions: [],
  });
});

test("scanTokens reads command substitutions that contain quotes and escapes", () => {
  assert.deepEqual(scanTokens("echo $(echo a\\ b)"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["echo a\\ b"],
  });
  assert.deepEqual(scanTokens("echo $(echo 'x')"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["echo 'x'"],
  });
  assert.deepEqual(scanTokens('echo $(echo "x")'), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ['echo "x"'],
  });
  assert.deepEqual(scanTokens('echo $(echo "a\\b")'), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ['echo "a\\b"'],
  });
});

test("scanTokens reads a backtick substitution whose body contains a backslash", () => {
  assert.deepEqual(scanTokens("echo `echo a\\b`"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "", dynamic: true },
    ],
    substitutions: ["echo a\\b"],
  });
});

test("scanTokens tracks escapes, nesting, and backticks inside a braced parameter", () => {
  assert.deepEqual(scanTokens("echo ${a\\}b}"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "${a\\}b}", dynamic: true },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens("echo ${a${b}c}"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "${a${b}c}", dynamic: true },
    ],
    substitutions: [],
  });
  assert.deepEqual(scanTokens("echo ${x:-`date`}"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "${x:-`date`}", dynamic: true },
    ],
    substitutions: ["date"],
  });
});

test("scanTokens marks an ANSI-C quote dynamic", () => {
  assert.deepEqual(scanTokens("echo $'x'"), {
    tokens: [
      { kind: "word", value: "echo", dynamic: false },
      { kind: "word", value: "x", dynamic: true },
    ],
    substitutions: [],
  });
});

test("scanTokens refuses each construct it cannot close", () => {
  assert.equal(refusalConstruct(() => scanTokens("echo $(echo 'x)")), "unbalanced command substitution `$(`");
  assert.equal(refusalConstruct(() => scanTokens('echo $(echo "x)')), "unbalanced command substitution `$(`");
  assert.equal(refusalConstruct(() => scanTokens("echo ${oops")), "unbalanced parameter expansion `${`");
  assert.equal(refusalConstruct(() => scanTokens("echo `oops")), "unbalanced backtick substitution");
  assert.equal(refusalConstruct(() => scanTokens("echo $'x")), "unbalanced ANSI-C quote");
  assert.equal(refusalConstruct(() => scanTokens("echo ok")), "no refusal");
});

test("parseShellCommand refuses a redirection with no target", () => {
  assert.deepEqual(parseShellCommand("cmd < ;"), {
    executions: [],
    redirects: [],
    refusals: ["redirection without a target"],
  });
  assert.deepEqual(parseShellCommand("cmd > > out"), {
    executions: [],
    redirects: [],
    refusals: ["redirection without a target"],
  });
});

test("parseShellCommand refuses a wrapper that runs no command", () => {
  assert.deepEqual(parseShellCommand("env FOO=1"), { executions: [], redirects: [], refusals: [] });
  assert.deepEqual(parseShellCommand("sudo -n"), { executions: [], redirects: [], refusals: [] });
});

test("parseShellCommand refuses nesting deeper than eight levels", () => {
  const nested = Array.from({ length: 9 }).reduce((acc) => `true x$(${acc})`, "true");
  const parsed = parseShellCommand(nested);
  assert.deepEqual(parsed.executions.map((execution) => execution.name), Array.from({ length: 9 }, () => "true"));
  assert.deepEqual(parsed.executions[8].args, [{ value: "x", dynamic: true }]);
  assert.deepEqual(parsed.redirects, []);
  assert.deepEqual(parsed.refusals, ["shell nested deeper than 8 levels"]);
});

test("subcommandOf lowers the subcommand and skips its value flag", () => {
  assert.deepEqual(
    subcommandOf(
      [
        { value: "--git-dir", dynamic: false },
        { value: "/srv/repo", dynamic: false },
        { value: "PUSH", dynamic: false },
      ],
      new Set(["--git-dir"]),
    ),
    { sub: "push", dynamic: false },
  );
  assert.deepEqual(
    subcommandOf(
      [
        { value: "-C", dynamic: false },
        { value: "/srv/repo", dynamic: false },
        { value: "$SUB", dynamic: true },
      ],
      new Set(["-C"]),
    ),
    { dynamic: true },
  );
  assert.deepEqual(subcommandOf([{ value: "--bare", dynamic: false }], new Set(["--git-dir"])), {
    dynamic: false,
  });
});

test("filesystem read-only refuses a git subcommand built from a variable", () => {
  const readOnly = compileTaskPolicy({ filesystem: "read-only", shell: "full" }, "general");
  assert.deepEqual(evaluateGuard(readOnly, { toolName: "bash", input: { command: "git $SUB status" } }), {
    block: true,
    reason: "pstack policy guard: filesystem read-only cannot verify a git subcommand built from a variable",
  });
  assert.equal(evaluateGuard(readOnly, { toolName: "bash", input: { command: "git log --oneline" } }), undefined);
});

test("normalizePolicyObject validates every axis and rejects a non-object", () => {
  assert.deepEqual(normalizePolicyObject(GENERAL_POLICY), GENERAL_POLICY);
  assert.equal(Object.isFrozen(normalizePolicyObject(GENERAL_POLICY)), true);
  assert.deepEqual(normalizePolicyObject({ ...GENERAL_POLICY, integrations: ["browser-ui"], extra: 1 }), {
    ...GENERAL_POLICY,
    integrations: ["browser-ui"],
  });
  assert.throws(
    () => normalizePolicyObject(null),
    /invalid filesystem 'undefined'; allowed: read-only, workspace-write/,
  );
  assert.throws(() => normalizePolicyObject([]), /invalid filesystem 'undefined'/);
  assert.throws(
    () => normalizePolicyObject({ ...GENERAL_POLICY, background: "yes" }),
    /invalid background 'yes'; allowed: true, false/,
  );
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
    assert.equal(activeToolCalls.count, 2);
    assert.deepEqual(posted, ["http://worker.test/v1/tasks"]);
    assert.equal(reply.details.hosted, true);
    assert.equal(reply.details.status, 202);
    assert.equal(reply.details.role, "general");
    assert.equal(reply.details.thinkingLevel, null);
    assert.equal(reply.content[0].text, "hosted worker accepted");
    assert.match(String(reply.details.runId), /^run-[0-9a-z]+-[0-9a-f]{8}$/);
    assert.deepEqual(reply.details.policy, { ...GENERAL_POLICY, environment: "hosted", isolation: "remote" });
    assert.equal(
      reply.content[1].text,
      "policy: filesystem=workspace-write shell=full git=branch-write network=allowed integrations=inherit environment=hosted background=false isolation=remote; thinkingLevel=default",
    );
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
    assert.deepEqual(host.toolNames, ["pstack_task"]);
    assert.equal(host.handlerCount, 0);
  } finally {
    if (previous !== undefined) process.env.PSTACK_CHILD_POLICY = previous;
    __setGuardPolicyForTests(null);
  }
});
