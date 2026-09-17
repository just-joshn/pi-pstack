import { expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateGuard, type GuardDecision } from "../../../extensions/agents/policy-guard.ts";
import { compileTaskPolicy, type PstackTaskPolicy } from "../../../extensions/agents/policy.ts";
import { registerCompanions } from "../../../extensions/companions/index.ts";

const INVESTIGATOR = compileTaskPolicy(undefined, "investigator");
const READONLY = compileTaskPolicy({ readonly: true, network: "none" }, "general");
const FILESYSTEM_READ_ONLY = compileTaskPolicy(
  { filesystem: "read-only", shell: "full", git: "read" },
  "general",
);
const NETWORK_NONE = compileTaskPolicy({ network: "none", shell: "full" }, "general");

type Event = { toolName: string; input: Record<string, unknown> };

function cli(argv: unknown): Event {
  return { toolName: "pstack_control_cli", input: { argv } };
}

function ui(url: string): Event {
  return { toolName: "pstack_control_ui", input: { url } };
}

function verdict(policy: PstackTaskPolicy, event: Event): GuardDecision | undefined {
  return evaluateGuard(policy, event);
}

function reasonOf(policy: PstackTaskPolicy, event: Event): string {
  return verdict(policy, event)?.reason ?? "ALLOW";
}

test("probe 1: investigator cannot run an interpreter through pstack_control_cli", () => {
  const event = cli(["node", "-e", "require('fs').writeFileSync('/tmp/x','pwned')"]);
  expect(verdict(INVESTIGATOR, event)?.block).toBe(true);
  expect(reasonOf(INVESTIGATOR, event)).toMatch(/shell none blocks pstack_control_cli/);
});

test("probe 2: a shell-none policy refuses the tool, and the read path stays open for shell-full", () => {
  expect(verdict(INVESTIGATOR, cli(["git", "status"]))?.block).toBe(true);
  expect(verdict(FILESYSTEM_READ_ONLY, cli(["git", "status"])), "a read-only command has nothing for the git or filesystem axis to refuse").toBe(undefined);
});

test("probe 3: git read blocks a push reached through pstack_control_cli", () => {
  expect(verdict(INVESTIGATOR, cli(["git", "push"]))?.block).toBe(true);
  expect(reasonOf(FILESYSTEM_READ_ONLY, cli(["git", "push"]))).toMatch(/blocks 'git push'/);
});

test("probe 4: network none blocks pstack_control_ui", () => {
  expect(verdict(READONLY, ui("http://example.com"))?.block).toBe(true);
  expect(reasonOf(READONLY, ui("http://example.com"))).toMatch(/network none blocks pstack_control_ui/);
  expect(verdict(NETWORK_NONE, ui("http://example.com"))?.block).toBe(true);
  expect(verdict(compileTaskPolicy({ network: "allowed" }, "general"), ui("http://example.com")), "a granted network leaves the probe to the URL policy").toBe(undefined);
});

test("argv is inspected with the same write tables as a bash command", () => {
  const blocked = [
    ["rm", "-rf", "/tmp/x"],
    ["mv", "a", "b"],
    ["sed", "-i", "s/a/b/", "f"],
    ["tee", "/tmp/f"],
    ["truncate", "-s0", "/tmp/f"],
    ["python3", "-c", "open('/tmp/f','w')"],
    ["node", "-e", "1"],
    ["bash", "-c", "rm -rf /tmp/x"],
    ["env", "bash", "-c", "mv a b"],
    ["sudo", "git", "push"],
    ["npm", "exec", "node", "-e", "1"],
    ["npm", "run", "build"],
    ["git", "push"],
    ["git", "commit", "-m", "x"],
    ["curl", "-o", "/tmp/f", "https://example.com"],
  ];
  const leaks = blocked.filter((argv) => verdict(FILESYSTEM_READ_ONLY, cli(argv))?.block !== true);
  expect(leaks, "every argv that writes or runs code must be blocked").toEqual([]);

  const allowed = [
    ["git", "status"],
    ["git", "log", "--oneline"],
    ["ls", "-la"],
    ["grep", "-rn", "pattern", "src/"],
    ["sed", "-n", "1p", "f"],
  ];
  const refusals = allowed.filter((argv) => verdict(FILESYSTEM_READ_ONLY, cli(argv)) !== undefined);
  expect(refusals, "the read paths stay open").toEqual([]);
});

test("network none blocks an argv that reaches the network", () => {
  expect(reasonOf(NETWORK_NONE, cli(["curl", "https://example.com"]))).toMatch(/network none blocks 'curl'/);
  expect(reasonOf(NETWORK_NONE, cli(["git", "clone", "https://example.com/x.git"]))).toMatch(/network none blocks 'git clone'/);
  expect(verdict(NETWORK_NONE, cli(["git", "status"]))).toBe(undefined);
});

test("a malformed or undecomposable command fails closed", () => {
  const malformed = [undefined, [], "git status", [7, "status"], ["git", 7], ["git\0status"], [""]];
  const leaks = malformed.filter((argv) => verdict(FILESYSTEM_READ_ONLY, cli(argv))?.block !== true);
  expect(leaks, "every malformed argv must be blocked").toEqual([]);
  expect(reasonOf(FILESYSTEM_READ_ONLY, cli([]))).toMatch(/malformed command/);
  expect(reasonOf(FILESYSTEM_READ_ONLY, cli(["bash", "-c", "cat <<EOF"]))).toMatch(/cannot enforce this policy/);
});

test("a shell-none policy refuses the tool even when every other axis would allow it", () => {
  const shellNone = compileTaskPolicy({ shell: "none" }, "general");
  expect(reasonOf(shellNone, cli(["git", "status"]))).toMatch(/shell none blocks pstack_control_cli/);
  expect(verdict(shellNone, { toolName: "read", input: {} })).toBe(undefined);
});

type ToolCall = { command: string; args: string[] };
type CapturedTool = {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

function companionEnv() {
  const tools = new Map<string, CapturedTool>();
  let calls: ToolCall[] = [];
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: CapturedTool & { name: string }) {
      tools.set(definition.name, definition);
    },
    exec(command: string, args: string[]) {
      calls = [...calls, { command, args }];
      return Promise.resolve({ code: 0, stdout: "ok", stderr: "", killed: false });
    },
    sendUserMessage() {},
  };
  registerCompanions(pi as never);
  return {
    tool(name: string): CapturedTool {
      const definition = tools.get(name);
      if (!definition) throw new Error(`${name} was not registered`);
      return definition;
    },
    execCalls: (): ToolCall[] => calls,
  };
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = Object.entries(values).map(([key]) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

function withTempBinDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pstack-cli-bin-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the tool refuses an untrusted PATH match and honours the operator trusted directories", async () => {
  await withTempBinDir(async (dir) => {
    const fake = join(dir, "git");
    writeFileSync(fake, "#!/bin/sh\necho stub\n");
    chmodSync(fake, 0o755);
    await withEnv({ PATH: dir }, async () => {
      const refused = companionEnv();
      await expect(() => refused.tool("pstack_control_cli").execute("t", { argv: ["git", "status"] })).rejects.toThrow(/outside a trusted binary directory/);
      expect(refused.execCalls(), "a refused command never reaches exec").toEqual([]);

      const trusted = companionEnv();
      await withEnv({ PSTACK_CONTROL_CLI_TRUSTED_DIRS: dir }, async () => {
        await trusted.tool("pstack_control_cli").execute("t", { argv: ["git", "status"] });
      });
      expect(trusted.execCalls()).toEqual([{ command: "git", args: ["status"] }]);
    });
  });
});

test("the tool refuses an interpreter by default and runs it only under the operator opt-in", async () => {
  const off = companionEnv();
  await expect(() => off.tool("pstack_control_cli").execute("t", { argv: ["node", "-e", "1"] })).rejects.toThrow(/requires an explicit allowInterpreters opt-in/);
  expect(off.execCalls()).toEqual([]);

  const on = companionEnv();
  await withEnv({ PSTACK_CONTROL_CLI_INTERPRETERS: "1" }, async () => {
    await on.tool("pstack_control_cli").execute("t", { argv: ["node", "--version"] });
  });
  expect(on.execCalls()).toEqual([{ command: "node", args: ["--version"] }]);
});

test("a caller-supplied allowHosts value may only open loopback", async () => {
  const env = companionEnv();
  const probe = env.tool("pstack_control_ui");
  await expect(() => probe.execute("t", { url: "http://10.0.0.1/", allowHosts: ["10.0.0.1"] })).rejects.toThrow(/private, loopback, or link-local target/);
  await expect(() => probe.execute("t", { url: "http://169.254.169.254/latest", allowHosts: ["169.254.169.254"] })).rejects.toThrow(/metadata or local-only host/);

  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    status: 200,
    ok: true,
    headers: { get: () => null },
    text: async () => "loopback body",
  })) as unknown as typeof fetch;
  try {
    const result = await probe.execute("t", { url: "http://127.0.0.1:9/", allowHosts: ["127.0.0.1"] });
    expect(result.content[0]?.text).toBe("HTTP 200 ok=true\n\nloopback body");
  } finally {
    globalThis.fetch = original;
  }
});
