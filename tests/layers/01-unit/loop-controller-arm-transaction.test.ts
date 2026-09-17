import { expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerLoopController } from "../../../extensions/loop/controller.ts";
import { registerHeartbeat } from "../../../extensions/heartbeat/index.ts";
import { listRuns } from "../../../extensions/loop/run-store.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
}

interface ArmEnv {
  run: (params: Record<string, unknown>) => Promise<ToolResult>;
  loopStatus: () => Promise<string>;
  shutdown: () => void;
  storedRunIds: () => string[];
  cleanup: () => void;
}

function armEnv(): ArmEnv {
  const dir = mkdtempSync(join(tmpdir(), "pstack-arm-txn-"));
  const previous = process.env.PSTACK_RUNS_DIR;
  process.env.PSTACK_RUNS_DIR = dir;
  const tools = new Map<string, CapturedTool>();
  let shutdown: (() => void) | undefined;
  const pi = {
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdown = handler;
    },
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    sendUserMessage() {},
    sendMessage() {},
    exec() {
      return new Promise(() => {});
    },
  };
  registerHeartbeat(pi as never);
  registerLoopController(pi as never);
  const runTool = tools.get("pstack_run");
  const loopTool = tools.get("pstack_loop");
  if (!runTool || !loopTool) throw new Error("pstack_run and pstack_loop must both register");
  const ctx = { ui: { setStatus() {}, notify() {} } };
  const call = (tool: CapturedTool, params: Record<string, unknown>) =>
    tool.execute("t", params, undefined, undefined, ctx);
  return {
    run: (params) => call(runTool, params),
    loopStatus: async () => (await call(loopTool, { action: "status" })).content[0]?.text ?? "",
    shutdown: () => shutdown?.(),
    storedRunIds: () =>
      existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [],
    cleanup: () => {
      if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_RUNS_DIR");
      else process.env.PSTACK_RUNS_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ARM_BASE = { action: "arm", predicate: "ci green", intervalSeconds: 30 };

test('arm rejects the auditor runId "../evil" and leaves no armed loop and no run record', async () => {
  const env = armEnv();
  try {
    await expect(() => env.run({ ...ARM_BASE, runId: "../evil" })).rejects.toThrow(/invalid runId: \.\.\/evil/);
    expect(await env.loopStatus()).toBe("(no active loops)");
    expect(env.storedRunIds()).toEqual([]);
    expect(listRuns()).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("arm rejects every runId shape the store refuses without arming or writing", async () => {
  const rejected = ["../evil", "..", ".", "nested/run", "a b", "x".repeat(65)];
  for (const runId of rejected) {
    const env = armEnv();
    try {
      await expect(() => env.run({ ...ARM_BASE, runId })).rejects.toThrow(/invalid runId/);
      expect(await env.loopStatus(), `no loop armed for ${runId}`).toBe("(no active loops)");
      expect(env.storedRunIds(), `no record written for ${runId}`).toEqual([]);
    } finally {
      env.cleanup();
    }
  }
});

test("arm rejects an unwatchable watcher argv before writing a record or arming", async () => {
  const env = armEnv();
  try {
    await expect(() => env.run({ ...ARM_BASE, runId: "run-bad-watch", mode: "watcher", watchArgv: ["-x"] })).rejects.toThrow(/watchArgv\[0\] must be a command path\/name/);
    expect(await env.loopStatus()).toBe("(no active loops)");
    expect(env.storedRunIds()).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("arm rejects an unknown mode before writing a record or arming", async () => {
  const env = armEnv();
  try {
    await expect(() => env.run({ ...ARM_BASE, runId: "run-bad-mode", mode: "mystery" })).rejects.toThrow(/mode must be interval\|settle\|watcher\|dynamic/);
    expect(await env.loopStatus()).toBe("(no active loops)");
    expect(env.storedRunIds()).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("a rejected arm registers no run for session shutdown to block", async () => {
  const env = armEnv();
  try {
    await expect(() => env.run({ ...ARM_BASE, runId: "../evil" })).rejects.toThrow(/invalid runId/);
    expect(() => env.shutdown()).not.toThrow();
    expect(env.storedRunIds()).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("a valid arm still writes exactly one record and arms exactly one loop", async () => {
  const env = armEnv();
  try {
    const armed = await env.run({ ...ARM_BASE, runId: "run-ok" });
    expect((armed.details.run as { phase: string }).phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
    expect(await env.loopStatus()).toBe("run-ok mode=interval fires=0/50 armed=true lastReason=-");
    expect(env.storedRunIds()).toEqual(["run-ok.json"]);
    expect(listRuns().map((record) => record.runId)).toEqual(["run-ok"]);
  } finally {
    env.cleanup();
  }
});
