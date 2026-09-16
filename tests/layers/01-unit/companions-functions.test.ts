import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCompanions } from "../../../extensions/companions/index.ts";
import { applySafeDeletes } from "../../../extensions/companions/deslop-core.ts";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecCall {
  command: string;
  args: string[];
  opts?: { signal?: AbortSignal; timeout?: number; cwd?: string };
}

interface ToolTextPart {
  type: string;
  text: string;
}

interface CompanionOutcome {
  content: ToolTextPart[];
  details: Record<string, unknown>;
}

interface CompanionTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<CompanionOutcome>;
}

function companionEnv(results: ExecResult[] | ((call: ExecCall) => ExecResult)) {
  const tools = new Map<string, CompanionTool>();
  let calls: ExecCall[] = [];
  let cursor = 0;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: CompanionTool) {
      tools.set(definition.name, definition);
    },
    async exec(command: string, args: string[], opts?: ExecCall["opts"]) {
      calls = [...calls, { command, args, opts }];
      if (typeof results === "function") return results({ command, args, opts });
      const result = results[cursor];
      cursor = cursor + 1;
      if (!result) throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      return result;
    },
    sendUserMessage() {},
  };
  registerCompanions(pi as never);
  return {
    tool(name: string): CompanionTool {
      const definition = tools.get(name);
      if (!definition) throw new Error(`${name} was not registered`);
      return definition;
    },
    calls: (): ExecCall[] => calls,
  };
}

function fakeFetch(handler: (url: string) => { status: number; ok: boolean; body: string }) {
  const original = globalThis.fetch;
  let urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls = [...urls, String(input)];
    const response = handler(String(input));
    return { status: response.status, ok: response.ok, text: async () => response.body };
  }) as unknown as typeof fetch;
  return {
    urls: () => urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function withEnv(name: string, value: string | undefined, body: () => Promise<void>): Promise<void> {
  const saved = process.env[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
  return body().finally(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = saved;
  });
}

const CLEAN_DIFF = ["+++ b/app.ts", "+const total = 1", "+const items = []"].join("\n");

test("pstack_deslop returns the no-findings sentinel when the diff carries no slop", async () => {
  const env = companionEnv((call) => ({
    code: 0,
    stdout: call.args.includes("main...HEAD") ? CLEAN_DIFF : "",
    stderr: "",
  }));
  const result = await env.tool("pstack_deslop").execute("t", {}, undefined, undefined, {
    cwd: "/tmp/pstack-clean-diff",
    ui: {},
  });
  assert.equal(result.content.length, 1);
  assert.equal(
    result.content[0].text,
    "pstack_deslop: no common slop patterns in added lines (still run /skill:unslop on prose surfaces).",
  );
  assert.deepEqual(result.details, {
    findings: [],
    suggestions: [],
    cwd: "/tmp/pstack-clean-diff",
  });
});

test("pstack_control_ui refuses a private-address probe without reaching fetch", async () => {
  const env = companionEnv([]);
  const fetchState = fakeFetch(() => ({ status: 200, ok: true, body: "should not run" }));
  try {
    await assert.rejects(
      env.tool("pstack_control_ui").execute("t", { url: "http://127.0.0.1:9/" }),
      {
        message:
          "pstack_control_ui refused http://127.0.0.1:9/: host '127.0.0.1' is a private, loopback, or link-local target",
      },
    );
    assert.deepEqual(fetchState.urls(), []);
  } finally {
    fetchState.restore();
  }
});

test("pstack_control_ui refuses a metadata host even when it is allowlisted", async () => {
  const env = companionEnv([]);
  const fetchState = fakeFetch(() => ({ status: 200, ok: true, body: "should not run" }));
  try {
    await assert.rejects(
      env.tool("pstack_control_ui").execute("t", {
        url: "http://metadata.google.internal/",
        allowHosts: ["metadata.google.internal"],
      }),
      {
        message:
          "pstack_control_ui refused http://metadata.google.internal/: host 'metadata.google.internal' is a metadata or local-only host",
      },
    );
    assert.deepEqual(fetchState.urls(), []);
  } finally {
    fetchState.restore();
  }
});

test("pstack_control_ui honours a PSTACK_CONTROL_UI_ALLOW_HOSTS dev-server opt-in", async () => {
  const env = companionEnv([]);
  const fetchState = fakeFetch(() => ({ status: 200, ok: true, body: "dev server up" }));
  try {
    await withEnv("PSTACK_CONTROL_UI_ALLOW_HOSTS", "127.0.0.1:8123", async () => {
      const result = await env.tool("pstack_control_ui").execute("t", { url: "http://127.0.0.1:8123/" });
      assert.equal(result.content[0].text, "HTTP 200 ok=true\n\ndev server up");
      assert.deepEqual(result.details, { status: 200, ok: true });
    });
    assert.deepEqual(fetchState.urls(), ["http://127.0.0.1:8123/"]);
  } finally {
    fetchState.restore();
  }
});

test("pstack_control_cli refuses an interpreter when PSTACK_CONTROL_CLI_INTERPRETERS=0", async () => {
  const env = companionEnv(() => ({ code: 0, stdout: "ok", stderr: "" }));
  await withEnv("PSTACK_CONTROL_CLI_INTERPRETERS", "0", async () => {
    await assert.rejects(
      env.tool("pstack_control_cli").execute("t", { argv: ["node", "--version"] }),
      { message: "interpreter 'node' requires an explicit allowInterpreters opt-in" },
    );
    const allowed = await env.tool("pstack_control_cli").execute("t", { argv: ["git", "status"] });
    assert.equal(allowed.content[0].text, "exit 0\n\nok\n");
  });
  assert.deepEqual(env.calls().map((call) => call.command), ["git"]);
});

test("applySafeDeletes skips unknown files, non-delete actions, and lines with no target file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-deslop-skip-"));
  try {
    const result = await applySafeDeletes(dir, [
      {
        file: "(unknown)",
        line: "// Phase 1: x",
        label: "narration / alibi comment",
        severity: "high",
        action: "delete-line",
        safeDelete: true,
      },
      {
        file: "app.ts",
        line: "Simply do it",
        label: "hedge/filler adverb",
        severity: "medium",
        action: "rewrite-prose",
        safeDelete: true,
      },
      {
        file: "app.ts",
        line: "console.log(1)",
        label: "debug console in diff",
        severity: "high",
        action: "delete-line",
        safeDelete: false,
      },
      {
        file: "missing.ts",
        line: "// Phase 2: y",
        label: "narration / alibi comment",
        severity: "high",
        action: "delete-line",
        safeDelete: true,
      },
    ]);
    assert.deepEqual(result, { applied: 0, files: [] });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
