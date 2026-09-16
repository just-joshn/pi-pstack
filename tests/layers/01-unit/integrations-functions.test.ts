import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTEGRATION_CATEGORIES } from "../../../extensions/agents/policy.ts";
import {
  DEFAULT_ADAPTER_TIMEOUT_MS,
  GIT_LOG_FORMAT,
  assertArgv,
  assertSafePath,
  detectGhOnPath,
  detectGitWorkTree,
  executeCommandAdapter,
  ghPrSearch,
  gitBlame,
  gitLog,
  piExec,
  planSourceControlQuery,
  probeContext,
  probeForEntry,
  runArgv,
  type ExecLike,
  type ExecOutcome,
  type ExecRequest,
} from "../../../extensions/integrations/adapters.ts";
import {
  decideStatus,
  formatCoverageGap,
  formatStatusLine,
  gapForStatus,
  integrationEntry,
  loadIntegrationsConfig,
  parseCommandAdapter,
  parseIntegrationsConfig,
} from "../../../extensions/integrations/registry.ts";
import { registerIntegrations } from "../../../extensions/integrations/index.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  label: string;
  promptSnippet: string;
  promptGuidelines: string[];
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
}

interface RecordedCall {
  command: string;
  args: string[];
  opts: Record<string, unknown> | undefined;
}

function rejection(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

async function asyncRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to reject");
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = tempDir(prefix);
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withIntegrationsDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PSTACK_INTEGRATIONS_DIR;
  process.env.PSTACK_INTEGRATIONS_DIR = dir;
  try {
    return await run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_INTEGRATIONS_DIR");
    else process.env.PSTACK_INTEGRATIONS_DIR = previous;
  }
}

async function withHarness(
  handler: (call: RecordedCall) => ExecOutcome,
  run: (env: ReturnType<typeof integrationsHarness>, dir: string) => Promise<void>,
  config?: unknown,
): Promise<void> {
  await withTempDir("integrations-fn-", async (dir) => {
    if (config !== undefined) {
      writeFileSync(join(dir, "integrations.json"), JSON.stringify(config), "utf8");
    }
    await withIntegrationsDir(dir, async () => {
      await run(integrationsHarness(handler), dir);
    });
  });
}

function recordingExec(replies: ExecOutcome[]): { exec: ExecLike; calls: () => ExecRequest[] } {
  let calls: ExecRequest[] = [];
  let cursor = 0;
  const exec: ExecLike = (request) => {
    calls = [...calls, request];
    const reply = replies[cursor] ?? { stdout: "", stderr: "", code: 0 };
    cursor += 1;
    return Promise.resolve(reply);
  };
  return { exec, calls: () => calls };
}

function integrationsHarness(handler: (call: RecordedCall) => ExecOutcome) {
  let tool: CapturedTool | undefined;
  let calls: RecordedCall[] = [];
  const pi = {
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    getAllTools() {
      return [{ name: "pstack_control_cli" }];
    },
    exec(command: string, args: string[], opts: Record<string, unknown>) {
      const call = { command, args, opts };
      calls = [...calls, call];
      return Promise.resolve(handler(call));
    },
  };
  registerIntegrations(pi as never);
  return { tool: () => tool as CapturedTool, calls: () => calls };
}

function gitAndGhExec(extra: ExecOutcome): (call: RecordedCall) => ExecOutcome {
  return (call) => {
    if (call.command === "git" && call.args[0] === "rev-parse") {
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    if (call.command === "gh" && call.args[0] === "--version") {
      return { code: 0, stdout: "gh version 2.101.0", stderr: "" };
    }
    return extra;
  };
}

function gitOnlyExec(call: RecordedCall): ExecOutcome {
  if (call.command === "git" && call.args[0] === "rev-parse") {
    return { code: 0, stdout: "true\n", stderr: "" };
  }
  if (call.command === "gh" && call.args[0] === "--version") {
    return { code: 127, stdout: "", stderr: "gh: not found" };
  }
  return { code: 0, stdout: "OUT", stderr: "" };
}

test("integrations-functions-01 asserts argv and path safety at the boundary", () => {
  assert.deepEqual(assertArgv(["git", "log"], "source-control"), ["git", "log"]);
  assert.equal(rejection(() => assertArgv([], "source-control")), "source-control: command argv must not be empty");
  assert.equal(rejection(() => assertArgv([""], "command adapter")), "command adapter: command argv must be non-empty strings");
  assert.equal(rejection(() => assertArgv(["git", ""], "adapter")), "adapter: command argv must be non-empty strings");
  assert.equal(
    rejection(() => assertArgv(["-rf", "/"], "adapter")),
    "adapter: argv[0] must be a command name, not an option ('-rf')",
  );

  assert.equal(assertSafePath("src/a.ts", "git log pathspec"), "src/a.ts");
  assert.equal(rejection(() => assertSafePath("", "git log pathspec")), "git log pathspec: unsafe path ''");
  assert.equal(rejection(() => assertSafePath("-x", "git log pathspec")), "git log pathspec: unsafe path '-x'");
  assert.equal(
    rejection(() => assertSafePath("a\u0000b", "git log pathspec")),
    "git log pathspec: unsafe path 'a\u0000b'",
  );
});

test("integrations-functions-02 maps pi.exec through piExec with a copied argv", async () => {
  let calls: RecordedCall[] = [];
  const sourceArgs = ["log", "-n1"];
  const pi = {
    exec(command: string, args: string[], opts: Record<string, unknown>) {
      calls = [...calls, { command, args, opts }];
      return Promise.resolve({ stdout: "OUT", stderr: "ERR", code: 7 });
    },
  };
  const exec = piExec(pi as never);
  const outcome = await exec({ command: "git", args: sourceArgs, cwd: "/repo", timeoutMs: 5000 });

  assert.deepEqual(outcome, { stdout: "OUT", stderr: "ERR", code: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git");
  assert.deepEqual(calls[0].args, ["log", "-n1"]);
  assert.equal(calls[0].args === sourceArgs, false);
  assert.deepEqual(calls[0].opts, { timeout: 5000, cwd: "/repo" });

  const blanked = {
    exec: () => Promise.resolve({ stdout: null, stderr: undefined, code: 0 }),
  };
  assert.deepEqual(await piExec(blanked as never)({ command: "gh", args: [] }), {
    stdout: "",
    stderr: "",
    code: 0,
  });
});

test("integrations-functions-03 runs validated argv through the injected exec", async () => {
  const signal = new AbortController().signal;
  const capture = recordingExec([
    { stdout: "s", stderr: "e", code: 3 },
    { stdout: "s", stderr: "e", code: 0 },
  ]);

  assert.equal(DEFAULT_ADAPTER_TIMEOUT_MS, 120_000);
  const outcome = await runArgv(capture.exec, ["git", "log", "-n1"]);
  assert.deepEqual(outcome, { stdout: "s", stderr: "e", code: 3 });
  assert.equal(capture.calls()[0].command, "git");
  assert.deepEqual(capture.calls()[0].args, ["log", "-n1"]);
  assert.equal(capture.calls()[0].cwd, undefined);
  assert.equal(capture.calls()[0].signal, undefined);
  assert.equal(capture.calls()[0].timeoutMs, 120_000);

  await runArgv(capture.exec, ["git", "log"], { cwd: "/repo", timeoutMs: 5, signal });
  assert.equal(capture.calls()[1].cwd, "/repo");
  assert.equal(capture.calls()[1].timeoutMs, 5);
  assert.equal(capture.calls()[1].signal, signal);

  assert.equal(await asyncRejection(() => runArgv(capture.exec, [])), "source-control: command argv must not be empty");
  assert.equal(capture.calls().length, 2);
});

test("integrations-functions-04 appends the query only when the adapter has one", async () => {
  const capture = recordingExec([
    { stdout: "captured", stderr: "", code: 0 },
    { stdout: "captured", stderr: "", code: 0 },
    { stdout: "captured", stderr: "", code: 0 },
  ]);

  await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "topic");
  assert.equal(capture.calls()[0].command, "node");
  assert.deepEqual(capture.calls()[0].args, ["-e", "1", "topic"]);
  assert.equal(capture.calls()[0].timeoutMs, 120_000);

  await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "");
  assert.deepEqual(capture.calls()[1].args, ["-e", "1"]);

  await executeCommandAdapter(capture.exec, ["node"], "q", { cwd: "/c", timeoutMs: 1 });
  assert.deepEqual(capture.calls()[2].args, ["q"]);
  assert.equal(capture.calls()[2].cwd, "/c");
  assert.equal(capture.calls()[2].timeoutMs, 1);

  assert.equal(
    await asyncRejection(() => executeCommandAdapter(capture.exec, ["-x"], "q")),
    "command adapter: argv[0] must be a command name, not an option ('-x')",
  );
  assert.equal(capture.calls().length, 3);
});

test("integrations-functions-05 bounds git log limits, greps, and pathspecs", () => {
  const head = ["git", "log"];
  assert.deepEqual(gitLog(undefined, undefined), [...head, "-n20", `--format=${GIT_LOG_FORMAT}`]);
  assert.deepEqual(gitLog([], 0), [...head, "-n1", `--format=${GIT_LOG_FORMAT}`]);
  assert.deepEqual(gitLog([], 500), [...head, "-n200", `--format=${GIT_LOG_FORMAT}`]);
  assert.deepEqual(gitLog([], Number.NaN), [...head, "-n20", `--format=${GIT_LOG_FORMAT}`]);
  assert.deepEqual(gitLog([], 12.9), [...head, "-n12", `--format=${GIT_LOG_FORMAT}`]);
  assert.deepEqual(gitLog([], 5, "   "), [...head, "-n5", `--format=${GIT_LOG_FORMAT}`]);
  assert.deepEqual(gitLog([], 5, ""), [...head, "-n5", `--format=${GIT_LOG_FORMAT}`]);
  assert.deepEqual(gitLog(["src", "tests"], 5, "  fix bug  "), [
    ...head,
    "-n5",
    `--format=${GIT_LOG_FORMAT}`,
    "--grep=fix bug",
    "--",
    "src",
    "tests",
  ]);
  assert.equal(Object.isFrozen(gitLog([], 5)), true);
  assert.equal(
    rejection(() => gitLog(["-x"], 5)),
    "git log pathspec: unsafe path '-x'",
  );
});

test("integrations-functions-06 bounds blame lines and rejects unsafe blame files", () => {
  assert.deepEqual(gitBlame("a.ts", 3), ["git", "blame", "-L", "3,3", "--porcelain", "--", "a.ts"]);
  assert.deepEqual(gitBlame("a.ts", -4), ["git", "blame", "-L", "1,1", "--porcelain", "--", "a.ts"]);
  assert.deepEqual(gitBlame("a.ts", 2.7), ["git", "blame", "-L", "2,2", "--porcelain", "--", "a.ts"]);
  assert.equal(rejection(() => gitBlame("a.ts", Number.NaN)), "git blame line must be a finite number");
  assert.equal(rejection(() => gitBlame("a.ts", Number.POSITIVE_INFINITY)), "git blame line must be a finite number");
  assert.equal(rejection(() => gitBlame("-a.ts", 1)), "git blame file: unsafe path '-a.ts'");
  assert.equal(Object.isFrozen(gitBlame("a.ts", 1)), true);
  assert.equal(rejection(() => ghPrSearch("   ")), "gh PR search requires a non-empty query");
  assert.deepEqual(ghPrSearch("  topic  "), [
    "gh",
    "search",
    "prs",
    "topic",
    "--json",
    "number,title,state,url,author",
    "--limit",
    "20",
  ]);
});

test("integrations-functions-07 parses the query grammar without silent degradation", () => {
  const format = `--format=${GIT_LOG_FORMAT}`;
  const empty = planSourceControlQuery("", undefined, 20);
  assert.deepEqual(empty, { mode: "log", requiresGh: false, argv: ["git", "log", "-n20", format] });

  const text = planSourceControlQuery("  fix the bug  ", ["src"], 10);
  assert.deepEqual(text.argv, ["git", "log", "-n10", format, "--grep=fix the bug", "--", "src"]);

  const blame = planSourceControlQuery("blame:src/a.ts:12", undefined, 5);
  assert.deepEqual(blame, {
    mode: "blame",
    requiresGh: false,
    argv: ["git", "blame", "-L", "12,12", "--porcelain", "--", "src/a.ts"],
  });

  const colons = planSourceControlQuery("blame:a:b.ts:12", undefined, 5);
  assert.deepEqual(colons.argv, ["git", "blame", "-L", "12,12", "--porcelain", "--", "a:b.ts"]);

  const zero = planSourceControlQuery("blame:a.ts:0", undefined, 5);
  assert.deepEqual(zero.argv, ["git", "blame", "-L", "1,1", "--porcelain", "--", "a.ts"]);

  const prs = planSourceControlQuery("prs:topic", undefined, 5);
  assert.equal(prs.mode, "prs");
  assert.equal(prs.requiresGh, true);
  assert.deepEqual(prs.argv, ghPrSearch("topic"));

  const pr = planSourceControlQuery("pr:topic", undefined, 5);
  assert.deepEqual(pr.argv, prs.argv);

  const colonOnly = planSourceControlQuery("pr:", undefined, 5);
  assert.deepEqual(colonOnly, { mode: "log", requiresGh: false, argv: ["git", "log", "-n5", format, "--grep=pr:"] });

  assert.equal(rejection(() => planSourceControlQuery("blame:-a.ts:3", undefined, 5)), "git blame file: unsafe path '-a.ts'");
});

test("integrations-functions-08 detects the git work tree and gh on PATH", async () => {
  const capture = recordingExec([
    { stdout: "true\n", stderr: "", code: 0 },
    { stdout: " false \n", stderr: "", code: 0 },
    { stdout: " true \n", stderr: "", code: 0 },
    { stdout: "true\n", stderr: "", code: 1 },
    { stdout: "gh version 2.101.0", stderr: "", code: 0 },
    { stdout: "", stderr: "not found", code: 127 },
  ]);
  const exec = capture.exec;

  assert.equal(await detectGitWorkTree(exec), true);
  assert.equal(await detectGitWorkTree(exec), false);
  assert.equal(await detectGitWorkTree(exec), true);
  assert.equal(await detectGitWorkTree(exec), false);
  assert.equal(await detectGhOnPath(exec), true);
  assert.equal(await detectGhOnPath(exec), false);

  const first = capture.calls()[0];
  assert.equal(first.command, "git");
  assert.deepEqual(first.args, ["rev-parse", "--is-inside-work-tree"]);
  assert.equal(first.cwd, undefined);
  assert.equal(first.timeoutMs, 15_000);
  assert.equal(first.signal, undefined);
  const gh = capture.calls()[4];
  assert.equal(gh.command, "gh");
  assert.deepEqual(gh.args, ["--version"]);
  assert.equal(gh.timeoutMs, 15_000);

  const failing: ExecLike = () => Promise.reject(new Error("spawn git ENOENT"));
  assert.equal(await detectGitWorkTree(failing), false);
  assert.equal(await detectGhOnPath(failing), false);
});

test("integrations-functions-09 probes only the facts one entry needs", async () => {
  await withTempDir("integrations-fn-", async (dir) => {
    const config = loadIntegrationsConfig(dir);
    const capture = recordingExec([
      { stdout: "true\n", stderr: "", code: 0 },
      { stdout: "gh version 2.101.0", stderr: "", code: 0 },
    ]);

    const builtin = await probeForEntry(integrationEntry("cli-tui"), capture.exec, config, {
      cwd: "/repo",
      registeredTools: ["pstack_control_cli"],
    });
    assert.deepEqual(builtin, {
      gitWorkTree: false,
      ghOnPath: false,
      config,
      registeredTools: ["pstack_control_cli"],
    });
    const adapter = await probeForEntry(integrationEntry("team-chat"), capture.exec, config);
    assert.equal(adapter.gitWorkTree, false);
    assert.equal(adapter.ghOnPath, false);
    assert.equal(capture.calls().length, 0);

    const sourceControl = await probeForEntry(integrationEntry("source-control"), capture.exec, config, { cwd: "/repo" });
    assert.equal(sourceControl.gitWorkTree, true);
    assert.equal(sourceControl.ghOnPath, true);
    assert.deepEqual(
      capture.calls().map((call) => `${call.command} ${call.args.join(" ")}`),
      ["git rev-parse --is-inside-work-tree", "gh --version"],
    );
  });
});

test("integrations-functions-10 skips the gh probe when the git work tree is absent", async () => {
  await withTempDir("integrations-fn-", async (dir) => {
    const config = loadIntegrationsConfig(dir);
    const capture = recordingExec([{ stdout: "", stderr: "fatal: not a git repository", code: 128 }]);
    const context = await probeContext(capture.exec, config, { cwd: "/tmp/notrepo" });

    assert.deepEqual(context, {
      gitWorkTree: false,
      ghOnPath: false,
      config,
      registeredTools: undefined,
    });
    assert.deepEqual(capture.calls().map((call) => call.args.join(" ")), ["rev-parse --is-inside-work-tree"]);
  });
});

test("integrations-functions-11 shapes unavailable statuses and the coverage gap text", async () => {
  await withTempDir("integrations-fn-", async (dir) => {
    const config = loadIntegrationsConfig(dir);
    const probe = { gitWorkTree: false, ghOnPath: false, config };

    const status = decideStatus(integrationEntry("team-chat"), probe);
    assert.equal(status.availability, "unavailable");
    assert.equal(status.satisfiedBy, null);
    assert.equal(status.missing, `add a 'command' adapter for capability 'team-chat' to ${config.source}`);
    assert.equal(
      formatStatusLine(status),
      `team-chat: unavailable tool=pstack_integrations (missing add a 'command' adapter for capability 'team-chat' to ${config.source})`,
    );

    const gap = gapForStatus(status);
    assert.deepEqual(gap, { capability: "team-chat", missing: status.missing });
    assert.equal(
      formatCoverageGap(gap),
      [
        "pstack_integrations coverage gap: capability 'team-chat' is unavailable.",
        `missing prerequisite: ${status.missing}`,
        "no other capability was queried in its place; report this as a null finding in /why, not a skip.",
      ].join("\n"),
    );

    const unregistered = decideStatus(integrationEntry("cli-tui"), {
      ...probe,
      registeredTools: ["pstack_control_ui"],
    });
    assert.equal(unregistered.availability, "unavailable");
    assert.equal(unregistered.missing, "pstack_control_cli is not registered in this session");
    assert.equal(gapForStatus(unregistered).missing, "pstack_control_cli is not registered in this session");

    const availableBuiltin = decideStatus(integrationEntry("browser-ui"), probe);
    assert.equal(availableBuiltin.availability, "available");
    assert.equal(availableBuiltin.satisfiedBy, "the built-in pstack_control_ui tool");
    assert.equal(gapForStatus(availableBuiltin).missing, "the built-in pstack_control_ui tool");
  });
});

test("integrations-functions-12 counts adapter args for a configured command", () => {
  const one = parseIntegrationsConfig(
    { "team-chat": { adapter: "command", command: ["node", "-e"], description: "chat" } },
    "cfg",
  );
  assert.equal(
    decideStatus(integrationEntry("team-chat"), { gitWorkTree: false, ghOnPath: false, config: one }).satisfiedBy,
    "command adapter 'node' (1 arg) from cfg",
  );

  const two = parseIntegrationsConfig(
    { "team-chat": { adapter: "command", command: ["node", "-e", "1"], description: "chat" } },
    "cfg",
  );
  assert.equal(
    decideStatus(integrationEntry("team-chat"), { gitWorkTree: false, ghOnPath: false, config: two }).satisfiedBy,
    "command adapter 'node' (2 args) from cfg",
  );

  assert.deepEqual(
    parseCommandAdapter("team-chat", { adapter: "command", command: ["node", "-e"], description: "  chat  " }, "cfg"),
    { adapter: "command", command: ["node", "-e"], description: "chat" },
  );
});

test("integrations-functions-13 rejects malformed command adapters", () => {
  const cases: Array<[unknown, string]> = [
    [null, "cfg: capability 'team-chat': expected a JSON object"],
    [[], "cfg: capability 'team-chat': expected a JSON object"],
    [
      { adapter: "mcp", command: ["node"], description: "x" },
      `cfg: capability 'team-chat' adapter must be "command"; got "mcp"`,
    ],
    [
      { adapter: null, command: ["node"], description: "x" },
      `cfg: capability 'team-chat' adapter must be "command"; got null`,
    ],
    [
      { adapter: "command", command: [], description: "x" },
      "cfg: capability 'team-chat' adapter.command must be a non-empty array of strings",
    ],
    [
      { adapter: "command", command: ["node", 3], description: "x" },
      "cfg: capability 'team-chat' adapter.command must be a non-empty array of strings",
    ],
    [
      { adapter: "command", command: ["-x"], description: "x" },
      "cfg: capability 'team-chat' adapter.command[0] must be a command name, not an option ('-x')",
    ],
    [
      { adapter: "command", command: ["node"], description: "   " },
      "cfg: capability 'team-chat' adapter.description must be a non-empty string",
    ],
    [
      { adapter: "command", command: ["node"], description: 5 },
      "cfg: capability 'team-chat' adapter.description must be a non-empty string",
    ],
  ];
  for (const [raw, message] of cases) {
    assert.equal(rejection(() => parseCommandAdapter("team-chat", raw, "cfg")), message);
  }
});

test("integrations-functions-14 loads config files and reports invalid JSON with the path", async () => {
  await withTempDir("integrations-fn-", async (dir) => {
    const file = join(dir, "integrations.json");
    assert.deepEqual(loadIntegrationsConfig(dir), { source: file, adapters: {} });

    writeFileSync(file, "{ not json", "utf8");
    const message = rejection(() => loadIntegrationsConfig(dir));
    assert.equal(message.startsWith(`${file}: invalid JSON (`), true);
    assert.equal(message.endsWith(")"), true);

    assert.equal(
      rejection(() => parseIntegrationsConfig({ nope: 1 }, "cfg")),
      "cfg: unknown capability 'nope'; known: source-control, issue-tracker, long-form-docs, team-chat, observability, error-tracking, analytics, browser-ui, cli-tui",
    );
    assert.equal(rejection(() => parseIntegrationsConfig([], "cfg")), "cfg: expected a JSON object");
    assert.equal(
      rejection(() => integrationEntry("not-a-capability" as never)),
      "integration registry has no metadata for capability not-a-capability",
    );
    assert.equal(INTEGRATION_CATEGORIES.length, 9);
  });
});

test("integrations-functions-15 dispatches list, status, and probe over nine categories", async () => {
  await withHarness(gitAndGhExec({ code: 0, stdout: "", stderr: "" }), async (env, dir) => {
    const tool = env.tool();
    assert.equal(tool.name, "pstack_integrations");
    assert.equal(tool.label, "Pstack Integrations");
    assert.equal(tool.promptSnippet, "Report integration capability availability and query a configured adapter");
    assert.deepEqual(tool.promptGuidelines, [
      "pstack_integrations must report an unavailable category as a null finding, never skip it",
      "pstack_integrations capability availability comes from the tool, not from guessing tool names",
    ]);

    const list = await tool.execute("t", { action: "list" }, undefined, undefined, { cwd: "/repo" });
    assert.equal(list.details.action, "list");
    assert.equal(list.details.available, 2);
    assert.equal(list.details.total, 9);
    assert.equal(list.details.config, join(dir, "integrations.json"));
    assert.deepEqual(
      (list.details.categories as Array<{ id: string }>).map((entry) => entry.id),
      INTEGRATION_CATEGORIES,
    );
    assert.equal(list.content[0].text.startsWith("pstack_integrations list: 2/9 categories available\n"), true);
    assert.equal(list.content[0].text.split("\n").length, 10);

    const status = await tool.execute("t", { action: "status" }, undefined, undefined, { cwd: "/repo" });
    const probe = await tool.execute("t", { action: "probe" }, undefined, undefined, { cwd: "/repo" });
    assert.equal(status.details.action, "status");
    assert.equal(probe.details.action, "probe");
    assert.equal(status.details.available, 2);
    assert.equal(probe.details.available, 2);

    assert.equal(
      await asyncRejection(() => tool.execute("t", { action: "bogus" }, undefined, undefined, { cwd: "/repo" })),
      "action must be one of list, status, probe, query",
    );
    assert.equal(
      await asyncRejection(() => tool.execute("t", { action: "query" }, undefined, undefined, { cwd: "/repo" })),
      `capability must be one of ${INTEGRATION_CATEGORIES.join(", ")}`,
    );
  });
});

test("integrations-functions-16 plans blame and log queries through the tool", async () => {
  await withHarness(gitAndGhExec({ code: 0, stdout: "OUT", stderr: "" }), async (env) => {
    const tool = env.tool();
    const blamed = await tool.execute(
      "t",
      { action: "query", capability: "source-control", query: "blame:src/a.ts:12" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.equal(blamed.content[0].text, "source-control blame (git): exit 0\n\nOUT");
    const blameCall = env.calls().find((call) => call.args[0] === "blame");
    assert.equal(blameCall?.command, "git");
    assert.deepEqual(blameCall?.args, ["blame", "-L", "12,12", "--porcelain", "--", "src/a.ts"]);
    assert.equal(blameCall?.opts?.cwd, "/repo");
    assert.equal(blameCall?.opts?.timeout, 120_000);

    const logged = await tool.execute(
      "t",
      { action: "query", capability: "source-control", query: "fix bug", paths: ["@src", "tests"], limit: 3 },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.equal(logged.content[0].text, "source-control log (git): exit 0\n\nOUT");
    const logCall = env.calls().find((call) => call.args[0] === "log");
    assert.deepEqual(logCall?.args, [
      "log",
      "-n3",
      `--format=${GIT_LOG_FORMAT}`,
      "--grep=fix bug",
      "--",
      "src",
      "tests",
    ]);
  });
});

test("integrations-functions-17 runs a prs query through gh", async () => {
  await withHarness(gitAndGhExec({ code: 0, stdout: "OUT", stderr: "" }), async (env) => {
    const searched = await env.tool().execute(
      "t",
      { action: "query", capability: "source-control", query: "prs:topic" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.equal(searched.content[0].text, "source-control prs (gh): exit 0\n\nOUT");
    const searchCall = env.calls().find((call) => call.args[0] === "search");
    assert.equal(searchCall?.command, "gh");
    assert.deepEqual(searchCall?.args, [
      "search",
      "prs",
      "topic",
      "--json",
      "number,title,state,url,author",
      "--limit",
      "20",
    ]);
  });
});

test("integrations-functions-18 returns the source-control coverage gap in git-only mode", async () => {
  await withHarness(gitOnlyExec, async (env) => {
    const gap = await env.tool().execute(
      "t",
      { action: "query", capability: "source-control", query: "prs:topic" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.equal(gap.details.coverageGap, true);
    assert.equal(gap.details.availability, "unavailable");
    assert.equal(gap.details.capability, "source-control");
    assert.equal(
      gap.details.missing,
      "gh is not on PATH, so the 'prs' query is unavailable; git history alone is available",
    );
    assert.equal(
      gap.content[0].text,
      [
        "pstack_integrations coverage gap: capability 'source-control' is unavailable.",
        "missing prerequisite: gh is not on PATH, so the 'prs' query is unavailable; git history alone is available",
        "no other capability was queried in its place; report this as a null finding in /why, not a skip.",
      ].join("\n"),
    );
    assert.equal(
      env.calls().some((call) => call.command === "gh" && call.args[0] === "search"),
      false,
    );
  });
});

test("integrations-functions-19 reports an unavailable source-control query outside a git tree", async () => {
  await withHarness(() => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" }), async (env) => {
    const missing = await env.tool().execute(
      "t",
      { action: "query", capability: "source-control", query: "" },
      undefined,
      undefined,
      { cwd: "/tmp/notrepo" },
    );
    assert.equal(missing.details.coverageGap, true);
    assert.equal(missing.details.missing, "cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)");
    assert.equal(env.calls().length, 1);
  });
});

test("integrations-functions-20 delegates a builtin-tool query without executing", async () => {
  await withHarness(() => ({ code: 0, stdout: "message-42", stderr: "" }), async (env) => {
    const pointer = await env.tool().execute(
      "t",
      { action: "query", capability: "cli-tui" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    assert.equal(pointer.details.delegatedTo, "pstack_control_cli");
    assert.equal(pointer.details.executed, false);
    assert.equal(pointer.details.coverageGap, false);
    assert.equal(
      pointer.content[0].text,
      "cli-tui is available through the built-in pstack_control_cli tool; call that tool directly (pstack_integrations does not drive a CLI or browser).",
    );
    assert.equal(env.calls().length, 0);
  });
});

test("integrations-functions-21 runs a configured adapter and gaps on an unconfigured one", async () => {
  const config = {
    "team-chat": { adapter: "command", command: ["node", "-e", "1"], description: "team chat adapter" },
  };
  await withHarness(
    () => ({ code: 0, stdout: "message-42", stderr: "" }),
    async (env) => {
      const adapter = await env.tool().execute(
        "t",
        { action: "query", capability: "team-chat", query: "  topic  " },
        undefined,
        undefined,
        { cwd: "/repo" },
      );
      assert.equal(adapter.content[0].text, "team-chat team chat adapter: exit 0\n\nmessage-42");
      assert.equal(adapter.details.coverageGap, false);
      assert.equal(adapter.details.code, 0);
      assert.equal(env.calls().length, 1);
      assert.equal(env.calls()[0].command, "node");
      assert.deepEqual(env.calls()[0].args, ["-e", "1", "topic"]);

      const unconfigured = await env.tool().execute(
        "t",
        { action: "query", capability: "issue-tracker" },
        undefined,
        undefined,
        { cwd: "/repo" },
      );
      assert.equal(unconfigured.details.coverageGap, true);
      assert.equal(unconfigured.details.capability, "issue-tracker");
      assert.equal(env.calls().length, 1);
    },
    config,
  );
});
