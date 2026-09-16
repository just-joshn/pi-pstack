import { expect, test } from "vitest";
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
  expect(assertArgv(["git", "log"], "source-control")).toEqual(["git", "log"]);
  expect(rejection(() => assertArgv([], "source-control"))).toBe("source-control: command argv must not be empty");
  expect(rejection(() => assertArgv([""], "command adapter"))).toBe("command adapter: command argv must be non-empty strings");
  expect(rejection(() => assertArgv(["git", ""], "adapter"))).toBe("adapter: command argv must be non-empty strings");
  expect(rejection(() => assertArgv(["-rf", "/"], "adapter"))).toBe("adapter: argv[0] must be a command name, not an option ('-rf')");

  expect(assertSafePath("src/a.ts", "git log pathspec")).toBe("src/a.ts");
  expect(rejection(() => assertSafePath("", "git log pathspec"))).toBe("git log pathspec: unsafe path ''");
  expect(rejection(() => assertSafePath("-x", "git log pathspec"))).toBe("git log pathspec: unsafe path '-x'");
  expect(rejection(() => assertSafePath("a\u0000b", "git log pathspec"))).toBe("git log pathspec: unsafe path 'a\u0000b'");
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

  expect(outcome).toEqual({ stdout: "OUT", stderr: "ERR", code: 7 });
  expect(calls.length).toBe(1);
  expect(calls[0].command).toBe("git");
  expect(calls[0].args).toEqual(["log", "-n1"]);
  expect(calls[0].args === sourceArgs).toBe(false);
  expect(calls[0].opts).toEqual({ timeout: 5000, cwd: "/repo" });

  const blanked = {
    exec: () => Promise.resolve({ stdout: null, stderr: undefined, code: 0 }),
  };
  expect(await piExec(blanked as never)({ command: "gh", args: [] })).toEqual({
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

  expect(DEFAULT_ADAPTER_TIMEOUT_MS).toBe(120_000);
  const outcome = await runArgv(capture.exec, ["git", "log", "-n1"]);
  expect(outcome).toEqual({ stdout: "s", stderr: "e", code: 3 });
  expect(capture.calls()[0].command).toBe("git");
  expect(capture.calls()[0].args).toEqual(["log", "-n1"]);
  expect(capture.calls()[0].cwd).toBe(undefined);
  expect(capture.calls()[0].signal).toBe(undefined);
  expect(capture.calls()[0].timeoutMs).toBe(120_000);

  await runArgv(capture.exec, ["git", "log"], { cwd: "/repo", timeoutMs: 5, signal });
  expect(capture.calls()[1].cwd).toBe("/repo");
  expect(capture.calls()[1].timeoutMs).toBe(5);
  expect(capture.calls()[1].signal).toBe(signal);

  expect(await asyncRejection(() => runArgv(capture.exec, []))).toBe("source-control: command argv must not be empty");
  expect(capture.calls().length).toBe(2);
});

test("integrations-functions-04 appends the query only when the adapter has one", async () => {
  const capture = recordingExec([
    { stdout: "captured", stderr: "", code: 0 },
    { stdout: "captured", stderr: "", code: 0 },
    { stdout: "captured", stderr: "", code: 0 },
  ]);

  await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "topic");
  expect(capture.calls()[0].command).toBe("node");
  expect(capture.calls()[0].args).toEqual(["-e", "1", "topic"]);
  expect(capture.calls()[0].timeoutMs).toBe(120_000);

  await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "");
  expect(capture.calls()[1].args).toEqual(["-e", "1"]);

  await executeCommandAdapter(capture.exec, ["node"], "q", { cwd: "/c", timeoutMs: 1 });
  expect(capture.calls()[2].args).toEqual(["q"]);
  expect(capture.calls()[2].cwd).toBe("/c");
  expect(capture.calls()[2].timeoutMs).toBe(1);

  expect(await asyncRejection(() => executeCommandAdapter(capture.exec, ["-x"], "q"))).toBe("command adapter: argv[0] must be a command name, not an option ('-x')");
  expect(capture.calls().length).toBe(3);
});

test("integrations-functions-05 bounds git log limits, greps, and pathspecs", () => {
  const head = ["git", "log"];
  expect(gitLog(undefined, undefined)).toEqual([...head, "-n20", `--format=${GIT_LOG_FORMAT}`]);
  expect(gitLog([], 0)).toEqual([...head, "-n1", `--format=${GIT_LOG_FORMAT}`]);
  expect(gitLog([], 500)).toEqual([...head, "-n200", `--format=${GIT_LOG_FORMAT}`]);
  expect(gitLog([], Number.NaN)).toEqual([...head, "-n20", `--format=${GIT_LOG_FORMAT}`]);
  expect(gitLog([], 12.9)).toEqual([...head, "-n12", `--format=${GIT_LOG_FORMAT}`]);
  expect(gitLog([], 5, "   ")).toEqual([...head, "-n5", `--format=${GIT_LOG_FORMAT}`]);
  expect(gitLog([], 5, "")).toEqual([...head, "-n5", `--format=${GIT_LOG_FORMAT}`]);
  expect(gitLog(["src", "tests"], 5, "  fix bug  ")).toEqual([
    ...head,
    "-n5",
    `--format=${GIT_LOG_FORMAT}`,
    "--grep=fix bug",
    "--",
    "src",
    "tests",
  ]);
  expect(Object.isFrozen(gitLog([], 5))).toBe(true);
  expect(rejection(() => gitLog(["-x"], 5))).toBe("git log pathspec: unsafe path '-x'");
});

test("integrations-functions-06 bounds blame lines and rejects unsafe blame files", () => {
  expect(gitBlame("a.ts", 3)).toEqual(["git", "blame", "-L", "3,3", "--porcelain", "--", "a.ts"]);
  expect(gitBlame("a.ts", -4)).toEqual(["git", "blame", "-L", "1,1", "--porcelain", "--", "a.ts"]);
  expect(gitBlame("a.ts", 2.7)).toEqual(["git", "blame", "-L", "2,2", "--porcelain", "--", "a.ts"]);
  expect(rejection(() => gitBlame("a.ts", Number.NaN))).toBe("git blame line must be a finite number");
  expect(rejection(() => gitBlame("a.ts", Number.POSITIVE_INFINITY))).toBe("git blame line must be a finite number");
  expect(rejection(() => gitBlame("-a.ts", 1))).toBe("git blame file: unsafe path '-a.ts'");
  expect(Object.isFrozen(gitBlame("a.ts", 1))).toBe(true);
  expect(rejection(() => ghPrSearch("   "))).toBe("gh PR search requires a non-empty query");
  expect(ghPrSearch("  topic  ")).toEqual([
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
  expect(empty).toEqual({ mode: "log", requiresGh: false, argv: ["git", "log", "-n20", format] });

  const text = planSourceControlQuery("  fix the bug  ", ["src"], 10);
  expect(text.argv).toEqual(["git", "log", "-n10", format, "--grep=fix the bug", "--", "src"]);

  const blame = planSourceControlQuery("blame:src/a.ts:12", undefined, 5);
  expect(blame).toEqual({
    mode: "blame",
    requiresGh: false,
    argv: ["git", "blame", "-L", "12,12", "--porcelain", "--", "src/a.ts"],
  });

  const colons = planSourceControlQuery("blame:a:b.ts:12", undefined, 5);
  expect(colons.argv).toEqual(["git", "blame", "-L", "12,12", "--porcelain", "--", "a:b.ts"]);

  const zero = planSourceControlQuery("blame:a.ts:0", undefined, 5);
  expect(zero.argv).toEqual(["git", "blame", "-L", "1,1", "--porcelain", "--", "a.ts"]);

  const prs = planSourceControlQuery("prs:topic", undefined, 5);
  expect(prs.mode).toBe("prs");
  expect(prs.requiresGh).toBe(true);
  expect(prs.argv).toEqual(ghPrSearch("topic"));

  const pr = planSourceControlQuery("pr:topic", undefined, 5);
  expect(pr.argv).toEqual(prs.argv);

  const colonOnly = planSourceControlQuery("pr:", undefined, 5);
  expect(colonOnly).toEqual({ mode: "log", requiresGh: false, argv: ["git", "log", "-n5", format, "--grep=pr:"] });

  expect(rejection(() => planSourceControlQuery("blame:-a.ts:3", undefined, 5))).toBe("git blame file: unsafe path '-a.ts'");
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

  expect(await detectGitWorkTree(exec)).toBe(true);
  expect(await detectGitWorkTree(exec)).toBe(false);
  expect(await detectGitWorkTree(exec)).toBe(true);
  expect(await detectGitWorkTree(exec)).toBe(false);
  expect(await detectGhOnPath(exec)).toBe(true);
  expect(await detectGhOnPath(exec)).toBe(false);

  const first = capture.calls()[0];
  expect(first.command).toBe("git");
  expect(first.args).toEqual(["rev-parse", "--is-inside-work-tree"]);
  expect(first.cwd).toBe(undefined);
  expect(first.timeoutMs).toBe(15_000);
  expect(first.signal).toBe(undefined);
  const gh = capture.calls()[4];
  expect(gh.command).toBe("gh");
  expect(gh.args).toEqual(["--version"]);
  expect(gh.timeoutMs).toBe(15_000);

  const failing: ExecLike = () => Promise.reject(new Error("spawn git ENOENT"));
  expect(await detectGitWorkTree(failing)).toBe(false);
  expect(await detectGhOnPath(failing)).toBe(false);
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
    expect(builtin).toEqual({
      gitWorkTree: false,
      ghOnPath: false,
      config,
      registeredTools: ["pstack_control_cli"],
    });
    const adapter = await probeForEntry(integrationEntry("team-chat"), capture.exec, config);
    expect(adapter.gitWorkTree).toBe(false);
    expect(adapter.ghOnPath).toBe(false);
    expect(capture.calls().length).toBe(0);

    const sourceControl = await probeForEntry(integrationEntry("source-control"), capture.exec, config, { cwd: "/repo" });
    expect(sourceControl.gitWorkTree).toBe(true);
    expect(sourceControl.ghOnPath).toBe(true);
    expect(capture.calls().map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual(["git rev-parse --is-inside-work-tree", "gh --version"]);
  });
});

test("integrations-functions-10 skips the gh probe when the git work tree is absent", async () => {
  await withTempDir("integrations-fn-", async (dir) => {
    const config = loadIntegrationsConfig(dir);
    const capture = recordingExec([{ stdout: "", stderr: "fatal: not a git repository", code: 128 }]);
    const context = await probeContext(capture.exec, config, { cwd: "/tmp/notrepo" });

    expect(context).toEqual({
      gitWorkTree: false,
      ghOnPath: false,
      config,
      registeredTools: undefined,
    });
    expect(capture.calls().map((call) => call.args.join(" "))).toEqual(["rev-parse --is-inside-work-tree"]);
  });
});

test("integrations-functions-11 shapes unavailable statuses and the coverage gap text", async () => {
  await withTempDir("integrations-fn-", async (dir) => {
    const config = loadIntegrationsConfig(dir);
    const probe = { gitWorkTree: false, ghOnPath: false, config };

    const status = decideStatus(integrationEntry("team-chat"), probe);
    expect(status.availability).toBe("unavailable");
    expect(status.satisfiedBy).toBe(null);
    expect(status.missing).toBe(`add a 'command' adapter for capability 'team-chat' to ${config.source}`);
    expect(formatStatusLine(status)).toBe(`team-chat: unavailable tool=pstack_integrations (missing add a 'command' adapter for capability 'team-chat' to ${config.source})`);

    const gap = gapForStatus(status);
    expect(gap).toEqual({ capability: "team-chat", missing: status.missing });
    expect(formatCoverageGap(gap)).toBe([
        "pstack_integrations coverage gap: capability 'team-chat' is unavailable.",
        `missing prerequisite: ${status.missing}`,
        "no other capability was queried in its place; report this as a null finding in /why, not a skip.",
      ].join("\n"));

    const unregistered = decideStatus(integrationEntry("cli-tui"), {
      ...probe,
      registeredTools: ["pstack_control_ui"],
    });
    expect(unregistered.availability).toBe("unavailable");
    expect(unregistered.missing).toBe("pstack_control_cli is not registered in this session");
    expect(gapForStatus(unregistered).missing).toBe("pstack_control_cli is not registered in this session");

    const availableBuiltin = decideStatus(integrationEntry("browser-ui"), probe);
    expect(availableBuiltin.availability).toBe("available");
    expect(availableBuiltin.satisfiedBy).toBe("the built-in pstack_control_ui tool");
    expect(gapForStatus(availableBuiltin).missing).toBe("the built-in pstack_control_ui tool");
  });
});

test("integrations-functions-12 counts adapter args for a configured command", () => {
  const one = parseIntegrationsConfig(
    { "team-chat": { adapter: "command", command: ["node", "-e"], description: "chat" } },
    "cfg",
  );
  expect(decideStatus(integrationEntry("team-chat"), { gitWorkTree: false, ghOnPath: false, config: one }).satisfiedBy).toBe("command adapter 'node' (1 arg) from cfg");

  const two = parseIntegrationsConfig(
    { "team-chat": { adapter: "command", command: ["node", "-e", "1"], description: "chat" } },
    "cfg",
  );
  expect(decideStatus(integrationEntry("team-chat"), { gitWorkTree: false, ghOnPath: false, config: two }).satisfiedBy).toBe("command adapter 'node' (2 args) from cfg");

  expect(parseCommandAdapter("team-chat", { adapter: "command", command: ["node", "-e"], description: "  chat  " }, "cfg")).toEqual({ adapter: "command", command: ["node", "-e"], description: "chat" });
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
    expect(rejection(() => parseCommandAdapter("team-chat", raw, "cfg"))).toBe(message);
  }
});

test("integrations-functions-14 loads config files and reports invalid JSON with the path", async () => {
  await withTempDir("integrations-fn-", async (dir) => {
    const file = join(dir, "integrations.json");
    expect(loadIntegrationsConfig(dir)).toEqual({ source: file, adapters: {} });

    writeFileSync(file, "{ not json", "utf8");
    const message = rejection(() => loadIntegrationsConfig(dir));
    expect(message.startsWith(`${file}: invalid JSON (`)).toBe(true);
    expect(message.endsWith(")")).toBe(true);

    expect(rejection(() => parseIntegrationsConfig({ nope: 1 }, "cfg"))).toBe("cfg: unknown capability 'nope'; known: source-control, issue-tracker, long-form-docs, team-chat, observability, error-tracking, analytics, browser-ui, cli-tui");
    expect(rejection(() => parseIntegrationsConfig([], "cfg"))).toBe("cfg: expected a JSON object");
    expect(rejection(() => integrationEntry("not-a-capability" as never))).toBe("integration registry has no metadata for capability not-a-capability");
    expect(INTEGRATION_CATEGORIES.length).toBe(9);
  });
});

test("integrations-functions-15 dispatches list, status, and probe over nine categories", async () => {
  await withHarness(gitAndGhExec({ code: 0, stdout: "", stderr: "" }), async (env, dir) => {
    const tool = env.tool();
    expect(tool.name).toBe("pstack_integrations");
    expect(tool.label).toBe("Pstack Integrations");
    expect(tool.promptSnippet).toBe("Report integration capability availability and query a configured adapter");
    expect(tool.promptGuidelines).toEqual([
      "pstack_integrations must report an unavailable category as a null finding, never skip it",
      "pstack_integrations capability availability comes from the tool, not from guessing tool names",
    ]);

    const list = await tool.execute("t", { action: "list" }, undefined, undefined, { cwd: "/repo" });
    expect(list.details.action).toBe("list");
    expect(list.details.available).toBe(2);
    expect(list.details.total).toBe(9);
    expect(list.details.config).toBe(join(dir, "integrations.json"));
    expect((list.details.categories as Array<{ id: string }>).map((entry) => entry.id)).toEqual(INTEGRATION_CATEGORIES);
    expect(list.content[0].text.startsWith("pstack_integrations list: 2/9 categories available\n")).toBe(true);
    expect(list.content[0].text.split("\n").length).toBe(10);

    const status = await tool.execute("t", { action: "status" }, undefined, undefined, { cwd: "/repo" });
    const probe = await tool.execute("t", { action: "probe" }, undefined, undefined, { cwd: "/repo" });
    expect(status.details.action).toBe("status");
    expect(probe.details.action).toBe("probe");
    expect(status.details.available).toBe(2);
    expect(probe.details.available).toBe(2);

    expect(await asyncRejection(() => tool.execute("t", { action: "bogus" }, undefined, undefined, { cwd: "/repo" }))).toBe("action must be one of list, status, probe, query");
    expect(await asyncRejection(() => tool.execute("t", { action: "query" }, undefined, undefined, { cwd: "/repo" }))).toBe(`capability must be one of ${INTEGRATION_CATEGORIES.join(", ")}`);
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
    expect(blamed.content[0].text).toBe("source-control blame (git): exit 0\n\nOUT");
    const blameCall = env.calls().find((call) => call.args[0] === "blame");
    expect(blameCall?.command).toBe("git");
    expect(blameCall?.args).toEqual(["blame", "-L", "12,12", "--porcelain", "--", "src/a.ts"]);
    expect(blameCall?.opts?.cwd).toBe("/repo");
    expect(blameCall?.opts?.timeout).toBe(120_000);

    const logged = await tool.execute(
      "t",
      { action: "query", capability: "source-control", query: "fix bug", paths: ["@src", "tests"], limit: 3 },
      undefined,
      undefined,
      { cwd: "/repo" },
    );
    expect(logged.content[0].text).toBe("source-control log (git): exit 0\n\nOUT");
    const logCall = env.calls().find((call) => call.args[0] === "log");
    expect(logCall?.args).toEqual([
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
    expect(searched.content[0].text).toBe("source-control prs (gh): exit 0\n\nOUT");
    const searchCall = env.calls().find((call) => call.args[0] === "search");
    expect(searchCall?.command).toBe("gh");
    expect(searchCall?.args).toEqual([
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
    expect(gap.details.coverageGap).toBe(true);
    expect(gap.details.availability).toBe("unavailable");
    expect(gap.details.capability).toBe("source-control");
    expect(gap.details.missing).toBe("gh is not on PATH, so the 'prs' query is unavailable; git history alone is available");
    expect(gap.content[0].text).toBe([
        "pstack_integrations coverage gap: capability 'source-control' is unavailable.",
        "missing prerequisite: gh is not on PATH, so the 'prs' query is unavailable; git history alone is available",
        "no other capability was queried in its place; report this as a null finding in /why, not a skip.",
      ].join("\n"));
    expect(env.calls().some((call) => call.command === "gh" && call.args[0] === "search")).toBe(false);
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
    expect(missing.details.coverageGap).toBe(true);
    expect(missing.details.missing).toBe("cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)");
    expect(env.calls().length).toBe(1);
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
    expect(pointer.details.delegatedTo).toBe("pstack_control_cli");
    expect(pointer.details.executed).toBe(false);
    expect(pointer.details.coverageGap).toBe(false);
    expect(pointer.content[0].text).toBe("cli-tui is available through the built-in pstack_control_cli tool; call that tool directly (pstack_integrations does not drive a CLI or browser).");
    expect(env.calls().length).toBe(0);
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
      expect(adapter.content[0].text).toBe("team-chat team chat adapter: exit 0\n\nmessage-42");
      expect(adapter.details.coverageGap).toBe(false);
      expect(adapter.details.code).toBe(0);
      expect(env.calls().length).toBe(1);
      expect(env.calls()[0].command).toBe("node");
      expect(env.calls()[0].args).toEqual(["-e", "1", "topic"]);

      const unconfigured = await env.tool().execute(
        "t",
        { action: "query", capability: "issue-tracker" },
        undefined,
        undefined,
        { cwd: "/repo" },
      );
      expect(unconfigured.details.coverageGap).toBe(true);
      expect(unconfigured.details.capability).toBe("issue-tracker");
      expect(env.calls().length).toBe(1);
    },
    config,
  );
});
