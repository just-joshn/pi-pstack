import { test } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { registerCompanions } from "../../../extensions/companions/index.ts";

const ALLOWLIST = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "python",
  "python3",
  "go",
  "cargo",
  "make",
  "pytest",
  "git",
  "gh",
  "pi",
  "tsx",
  "npx",
];

const COMPANION_TOOLS = ["pstack_deslop", "pstack_control_cli", "pstack_control_ui"];
const SHELL_NAMES = ["sh", "bash", "zsh", "fish", "cmd.exe"];

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
type CapturedTool = { name: string; parameters: Schema; execute: ToolExecute };

type CompanionEnv = {
  tool: (name: string) => CapturedTool;
  toolNames: () => string[];
  calls: () => ExecCall[];
};

const defaultExec = (): ExecResult => ({ code: 0, stdout: "", stderr: "" });

function companionEnv(handler: (call: ExecCall) => ExecResult = defaultExec): CompanionEnv {
  let tools: CapturedTool[] = [];
  let calls: ExecCall[] = [];
  const pi = {
    registerTool(definition: CapturedTool) {
      tools = [...tools, definition];
    },
    registerCommand() {},
    exec(command: string, args: string[], opts?: ExecOptions) {
      const call: ExecCall = { command, args, opts };
      calls = [...calls, call];
      return Promise.resolve(handler(call));
    },
    sendUserMessage() {},
  };
  registerCompanions(pi as never);
  return {
    tool(name) {
      const found = tools.find((candidate) => candidate.name === name);
      assert.ok(found, `${name} is registered`);
      return found;
    },
    toolNames: () => tools.map((candidate) => candidate.name),
    calls: () => calls,
  };
}

type FetchCall = { url: string; method: string | undefined };
type FetchEnv = {
  probe: CapturedTool;
  toolNames: () => string[];
  fetchCalls: () => FetchCall[];
  restore: () => void;
};

function fakeFetchEnv(
  handler: (call: FetchCall) => { status: number; ok: boolean; body: string },
): FetchEnv {
  const env = companionEnv();
  const original = globalThis.fetch;
  let fetchCalls: FetchCall[] = [];
  const fakeFetch = async (input: unknown, init?: { method?: string }) => {
    const call: FetchCall = { url: String(input), method: init?.method };
    fetchCalls = [...fetchCalls, call];
    const response = handler(call);
    return { status: response.status, ok: response.ok, text: async () => response.body };
  };
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  return {
    probe: env.tool("pstack_control_ui"),
    toolNames: env.toolNames,
    fetchCalls: () => fetchCalls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("control-01 validates argv against the allowlist", async () => {
  const env = companionEnv();
  const cli = env.tool("pstack_control_cli");

  for (const command of ALLOWLIST) {
    const result = await cli.execute("t", { argv: [command, "--version"] });
    assert.equal(result.details.code, 0, `${command} passes the allowlist`);
  }
  assert.deepEqual(
    env.calls().map((call) => call.command),
    ALLOWLIST,
  );

  await assert.rejects(() => cli.execute("t", { argv: ["rm", "-rf", "/"] }), {
    message: `command 'rm' not in control_cli allowlist (${ALLOWLIST.join(", ")})`,
  });
  await assert.rejects(() => cli.execute("t", { argv: ["/tmp/rm"] }), {
    message: `command 'rm' not in control_cli allowlist (${ALLOWLIST.join(", ")})`,
  });
  await assert.rejects(() => cli.execute("t", { argv: ["-v"] }), {
    message: "argv[0] must be a command name/path",
  });
  assert.equal(env.calls().length, ALLOWLIST.length, "rejected commands never reach exec");

  const byPath = await cli.execute("t", { argv: ["/usr/local/bin/git", "status"] });
  assert.equal(byPath.details.code, 0);
  assert.equal(env.calls().at(-1)?.command, "/usr/local/bin/git");
});

test("control-02 runs argv without a shell and truncates output at 50000 characters", async () => {
  const stdout = `${"a".repeat(49_999)}BC`;
  const env = companionEnv(() => ({ code: 3, stdout, stderr: "" }));
  const cli = env.tool("pstack_control_cli");

  const result = await cli.execute("t", { argv: ["git", "log", "--format=%h; echo pwned"] });

  const call = env.calls()[0];
  assert.equal(call.command, "git");
  assert.equal(Array.isArray(call.args), true);
  assert.deepEqual(call.args, ["log", "--format=%h; echo pwned"]);
  assert.equal(
    env.calls().some((entry) => SHELL_NAMES.includes(entry.command)),
    false,
    "no shell interpreter is invoked",
  );

  assert.equal(result.details.code, 3);
  const header = "exit 3\n\n";
  const text = result.content[0].text;
  assert.equal(text.startsWith(header), true);
  assert.equal(text.slice(header.length), `${"a".repeat(49_999)}B`);
  assert.equal(text.length, header.length + 50_000);

  const short = companionEnv(() => ({ code: 0, stdout: "all good", stderr: "warn" }));
  const shortResult = await short.tool("pstack_control_cli").execute("t", {
    argv: ["make", "test"],
  });
  assert.equal(shortResult.content[0].text, "exit 0\n\nall good\nwarn");
});

test("control-03 probes the URL with the requested method and expected status", async () => {
  const env = fakeFetchEnv(() => ({ status: 503, ok: false, body: "upstream down" }));
  try {
    const result = await env.probe.execute("t", {
      url: "http://127.0.0.1:65535/health",
      method: "HEAD",
      expectStatus: 503,
    });
    assert.deepEqual(env.fetchCalls(), [{ url: "http://127.0.0.1:65535/health", method: "HEAD" }]);
    assert.equal(result.details.status, 503);
    assert.equal(result.details.ok, true);
    assert.equal(result.content[0].text, "HTTP 503 ok=true\n\nupstream down");
    assert.deepEqual(env.toolNames(), COMPANION_TOOLS, "the probe registers no browser driver");
  } finally {
    env.restore();
  }
});

test("control-04 returns the HTTP status and a truncated body snippet", async () => {
  const body = `prefix-${"b".repeat(25_000)}`;
  const env = fakeFetchEnv(() => ({ status: 200, ok: true, body }));
  try {
    const result = await env.probe.execute("t", { url: "http://localhost:3000/" });
    assert.equal(result.details.status, 200);
    assert.equal(result.details.ok, true);
    const text = result.content[0].text;
    const header = "HTTP 200 ok=true\n\n";
    assert.equal(text.startsWith(header), true);
    assert.equal(text.slice(header.length), body.slice(0, 20_000));
    assert.equal(text.length, header.length + 20_000);
    assert.equal(body.length > 20_000, true, "the fake body is longer than the snippet cap");
  } finally {
    env.restore();
  }
});

test("control-05 requires argv to be a non-empty string array", async () => {
  const env = companionEnv();
  const cli = env.tool("pstack_control_cli");

  assert.equal(Check(cli.parameters, { argv: [] }), false);
  assert.equal(Check(cli.parameters, { argv: "git" }), false);
  assert.equal(Check(cli.parameters, { argv: [7] }), false);
  assert.equal(Check(cli.parameters, {}), false);
  assert.equal(Check(cli.parameters, { argv: ["git"] }), true);

  await assert.rejects(() => cli.execute("t", { argv: [] }), {
    message: "argv[0] must be a command name/path",
  });
  assert.equal(env.calls().length, 0);
});

test("control-06 passes the optional cwd through to exec", async () => {
  const env = companionEnv();
  const cli = env.tool("pstack_control_cli");

  await cli.execute("t", { argv: ["npm", "run", "build"], cwd: "/tmp/control-cwd" });
  await cli.execute("t", { argv: ["npm", "run", "build"] });

  assert.equal(env.calls()[0].opts?.cwd, "/tmp/control-cwd");
  assert.equal(env.calls()[1].opts?.cwd, undefined);
  assert.equal(Check(cli.parameters, { argv: ["npm"], cwd: "/tmp/control-cwd" }), true);
  assert.equal(Check(cli.parameters, { argv: ["npm"], cwd: 7 }), false);
});

test("control-07 bounds timeoutSeconds at 1..600 with a default of 120", async () => {
  const env = companionEnv();
  const cli = env.tool("pstack_control_cli");

  assert.equal(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 0 }), false);
  assert.equal(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 601 }), false);
  assert.equal(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 1.5 }), false);
  assert.equal(Check(cli.parameters, { argv: ["git"], timeoutSeconds: "120" }), false);
  assert.equal(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 1 }), true);
  assert.equal(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 600 }), true);

  await cli.execute("t", { argv: ["git"] });
  await cli.execute("t", { argv: ["git"], timeoutSeconds: 1 });
  await cli.execute("t", { argv: ["git"], timeoutSeconds: 600 });
  assert.deepEqual(
    env.calls().map((call) => call.opts?.timeout),
    [120_000, 1_000, 600_000],
  );
});

test("control-08 requires the url parameter", async () => {
  const env = companionEnv();
  const probe = env.tool("pstack_control_ui");

  assert.equal(Check(probe.parameters, {}), false);
  assert.equal(Check(probe.parameters, { url: 12 }), false);
  assert.equal(Check(probe.parameters, { url: "http://localhost:3000/" }), true);
});

test("control-09 defaults the ui method to GET", async () => {
  const env = fakeFetchEnv(() => ({ status: 200, ok: true, body: "ok" }));
  try {
    await env.probe.execute("t", { url: "http://localhost:3000/one" });
    await env.probe.execute("t", { url: "http://localhost:3000/two", method: "POST" });
    assert.deepEqual(
      env.fetchCalls().map((call) => call.method),
      ["GET", "POST"],
    );
  } finally {
    env.restore();
  }
});

test("control-10 honors the optional expectStatus parameter", async () => {
  const env = fakeFetchEnv(() => ({ status: 503, ok: false, body: "down" }));
  try {
    const matched = await env.probe.execute("t", {
      url: "http://localhost:3000/",
      expectStatus: 503,
    });
    const mismatched = await env.probe.execute("t", {
      url: "http://localhost:3000/",
      expectStatus: 200,
    });
    const omitted = await env.probe.execute("t", { url: "http://localhost:3000/" });

    assert.deepEqual(
      [matched.details.ok, mismatched.details.ok, omitted.details.ok],
      [true, false, false],
    );
    assert.deepEqual(
      [matched.details.status, mismatched.details.status, omitted.details.status],
      [503, 503, 503],
    );
    assert.equal(matched.content[0].text, "HTTP 503 ok=true\n\ndown");
    assert.equal(mismatched.content[0].text, "HTTP 503 ok=false\n\ndown");

    assert.equal(Check(env.probe.parameters, { url: "http://x/", expectStatus: 200 }), true);
    assert.equal(Check(env.probe.parameters, { url: "http://x/", expectStatus: "200" }), false);
  } finally {
    env.restore();
  }
});
