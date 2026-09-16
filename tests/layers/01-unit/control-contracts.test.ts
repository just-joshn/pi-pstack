import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { Check } from "typebox/value";
import { registerCompanions } from "../../../extensions/companions/index.ts";
import { INTERPRETER_COMMANDS } from "../../../extensions/lib/exec-allowlist.ts";

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
      expect(found, `${name} is registered`).toBeTruthy();
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

  const trusted = await cli.execute("t", { argv: ["git", "--version"] });
  expect(trusted.details.code, "a trusted command passes the allowlist").toBe(0);
  expect(env.calls().at(-1)?.command).toBe("git");

  for (const command of INTERPRETER_COMMANDS) {
    await expect(() => cli.execute("t", { argv: [command, "--version"] }), `${command} needs the explicit opt-in`).rejects.toThrow(`interpreter '${command}' requires an explicit allowInterpreters opt-in`);
  }

  const reachedExec = env.calls().length;
  await expect(() => cli.execute("t", { argv: ["rm", "-rf", "/"] })).rejects.toThrow(`command 'rm' not in control_cli allowlist (${ALLOWLIST.join(", ")})`);
  await expect(() => cli.execute("t", { argv: ["/tmp/rm"] })).rejects.toThrow(`command 'rm' not in control_cli allowlist (${ALLOWLIST.join(", ")})`);
  await expect(() => cli.execute("t", { argv: ["-v"] })).rejects.toThrow("argv[0] must be a command name/path");
  expect(env.calls().length, "rejected commands never reach exec").toBe(reachedExec);

  process.env.PSTACK_CONTROL_CLI_INTERPRETERS = "1";
  try {
    const opted = await cli.execute("t", { argv: ["node", "--version"] });
    expect(opted.details.code, "the documented opt-in reaches exec").toBe(0);
    expect(env.calls().at(-1)?.command).toBe("node");
  } finally {
    Reflect.deleteProperty(process.env, "PSTACK_CONTROL_CLI_INTERPRETERS");
  }

  const byPath = await cli.execute("t", { argv: ["/usr/local/bin/git", "status"] });
  expect(byPath.details.code).toBe(0);
  expect(env.calls().at(-1)?.command).toBe("/usr/local/bin/git");
});

test("control-02 runs argv without a shell and caps output at the 50KB default limit", async () => {
  const stdout = `${"a".repeat(60_000)}\n`;
  const env = companionEnv(() => ({ code: 3, stdout, stderr: "" }));
  const cli = env.tool("pstack_control_cli");

  const result = await cli.execute("t", { argv: ["git", "log", "--format=%h; echo pwned"] });

  const call = env.calls()[0];
  expect(call.command).toBe("git");
  expect(Array.isArray(call.args)).toBe(true);
  expect(call.args).toEqual(["log", "--format=%h; echo pwned"]);
  expect(env.calls().some((entry) => SHELL_NAMES.includes(entry.command)), "no shell interpreter is invoked").toBe(false);

  expect(result.details.code).toBe(3);
  const header = "exit 3\n\n";
  const text = result.content[0].text;
  expect(text.startsWith(header)).toBe(true);
  expect(text.includes("a".repeat(1000))).toBe(true);
  expect(text).toMatch(/\[Output truncated: \d+ of \d+ lines \([\d.]+KB of 58\.6KB\)\. Full output saved to: /);
  expect(typeof result.details.fullOutputPath).toBe("string");
  expect(readFileSync(result.details.fullOutputPath as string, "utf8")).toBe(`${stdout}\n`);

  const short = companionEnv(() => ({ code: 0, stdout: "all good", stderr: "warn" }));
  process.env.PSTACK_CONTROL_CLI_INTERPRETERS = "1";
  try {
    const shortResult = await short.tool("pstack_control_cli").execute("t", {
      argv: ["make", "test"],
    });
    expect(shortResult.content[0].text).toBe("exit 0\n\nall good\nwarn");
  } finally {
    Reflect.deleteProperty(process.env, "PSTACK_CONTROL_CLI_INTERPRETERS");
  }
});

test("control-03 probes the URL with the requested method and expected status", async () => {
  const env = fakeFetchEnv(() => ({ status: 503, ok: false, body: "upstream down" }));
  try {
    const result = await env.probe.execute("t", {
      url: "http://127.0.0.1:65535/health",
      method: "HEAD",
      expectStatus: 503,
      allowHosts: ["127.0.0.1"],
    });
    expect(env.fetchCalls()).toEqual([{ url: "http://127.0.0.1:65535/health", method: "HEAD" }]);
    expect(result.details.status).toBe(503);
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toBe("HTTP 503 ok=true\n\nupstream down");
    expect(env.toolNames(), "the probe registers no browser driver").toEqual(COMPANION_TOOLS);
  } finally {
    env.restore();
  }
});

test("control-04 returns the HTTP status and a truncated body snippet", async () => {
  const body = `prefix-${'b'.repeat(60_000)}`;
  const env = fakeFetchEnv(() => ({ status: 200, ok: true, body }));
  try {
    const result = await env.probe.execute("t", { url: "http://localhost:3000/", allowHosts: ["localhost"] });
    expect(result.details.status).toBe(200);
    expect(result.details.ok).toBe(true);
    const text = result.content[0].text;
    const header = "HTTP 200 ok=true\n\n";
    expect(text.startsWith(header)).toBe(true);
    expect(text.includes(body.slice(0, 200))).toBe(true);
    expect(text).toMatch(/\[Output truncated: 1 of 1 lines \(\d+\.\dKB of 58\.6KB\)\./);
    expect(typeof result.details.fullOutputPath).toBe("string");
    expect(readFileSync(result.details.fullOutputPath as string, "utf8")).toBe(body);

    const small = fakeFetchEnv(() => ({ status: 200, ok: true, body: "upstream down" }));
    try {
      const smallResult = await small.probe.execute("t", { url: "http://localhost:3000/", allowHosts: ["localhost"] });
      expect(smallResult.content[0].text).toBe("HTTP 200 ok=true\n\nupstream down");
    } finally {
      small.restore();
    }
  } finally {
    env.restore();
  }
});

test("control-05 requires argv to be a non-empty string array", async () => {
  const env = companionEnv();
  const cli = env.tool("pstack_control_cli");

  expect(Check(cli.parameters, { argv: [] })).toBe(false);
  expect(Check(cli.parameters, { argv: "git" })).toBe(false);
  expect(Check(cli.parameters, { argv: [7] })).toBe(false);
  expect(Check(cli.parameters, {})).toBe(false);
  expect(Check(cli.parameters, { argv: ["git"] })).toBe(true);

  await expect(() => cli.execute("t", { argv: [] })).rejects.toThrow("argv[0] must be a command name/path");
  expect(env.calls().length).toBe(0);
});

test("control-06 passes the optional cwd through to exec", async () => {
  const env = companionEnv();
  const cli = env.tool("pstack_control_cli");

  await cli.execute("t", { argv: ["git", "log"], cwd: "/tmp/control-cwd" });
  await cli.execute("t", { argv: ["git", "log"] });

  expect(env.calls()[0].opts?.cwd).toBe("/tmp/control-cwd");
  expect(env.calls()[1].opts?.cwd).toBe(undefined);
  expect(Check(cli.parameters, { argv: ["npm"], cwd: "/tmp/control-cwd" })).toBe(true);
  expect(Check(cli.parameters, { argv: ["npm"], cwd: 7 })).toBe(false);
});

test("control-07 bounds timeoutSeconds at 1..600 with a default of 120", async () => {
  const env = companionEnv();
  const cli = env.tool("pstack_control_cli");

  expect(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 0 })).toBe(false);
  expect(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 601 })).toBe(false);
  expect(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 1.5 })).toBe(false);
  expect(Check(cli.parameters, { argv: ["git"], timeoutSeconds: "120" })).toBe(false);
  expect(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 1 })).toBe(true);
  expect(Check(cli.parameters, { argv: ["git"], timeoutSeconds: 600 })).toBe(true);

  await cli.execute("t", { argv: ["git"] });
  await cli.execute("t", { argv: ["git"], timeoutSeconds: 1 });
  await cli.execute("t", { argv: ["git"], timeoutSeconds: 600 });
  expect(env.calls().map((call) => call.opts?.timeout)).toEqual([120_000, 1_000, 600_000]);
});

test("control-08 requires the url parameter", async () => {
  const env = companionEnv();
  const probe = env.tool("pstack_control_ui");

  expect(Check(probe.parameters, {})).toBe(false);
  expect(Check(probe.parameters, { url: 12 })).toBe(false);
  expect(Check(probe.parameters, { url: "http://localhost:3000/" })).toBe(true);
});

test("control-09 defaults the ui method to GET", async () => {
  const env = fakeFetchEnv(() => ({ status: 200, ok: true, body: "ok" }));
  try {
    await env.probe.execute("t", { url: "http://localhost:3000/one", allowHosts: ["localhost"] });
    await env.probe.execute("t", {
      url: "http://localhost:3000/two",
      method: "POST",
      allowHosts: ["localhost"],
    });
    expect(env.fetchCalls().map((call) => call.method)).toEqual(["GET", "POST"]);
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
      allowHosts: ["localhost"],
    });
    const mismatched = await env.probe.execute("t", {
      url: "http://localhost:3000/",
      expectStatus: 200,
      allowHosts: ["localhost"],
    });
    const omitted = await env.probe.execute("t", { url: "http://localhost:3000/", allowHosts: ["localhost"] });

    expect([matched.details.ok, mismatched.details.ok, omitted.details.ok]).toEqual([true, false, false]);
    expect([matched.details.status, mismatched.details.status, omitted.details.status]).toEqual([503, 503, 503]);
    expect(matched.content[0].text).toBe("HTTP 503 ok=true\n\ndown");
    expect(mismatched.content[0].text).toBe("HTTP 503 ok=false\n\ndown");

    expect(Check(env.probe.parameters, { url: "http://x/", expectStatus: 200 })).toBe(true);
    expect(Check(env.probe.parameters, { url: "http://x/", expectStatus: "200" })).toBe(false);
  } finally {
    env.restore();
  }
});
