import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHeartbeat } from "../../../extensions/heartbeat/index.ts";

interface CapturedTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<unknown>;
}

function fakeLoopEnv(execResult: { code: number; stdout: string; stderr: string } | "pending") {
  let tool: CapturedTool | undefined;
  let signals: AbortSignal[] = [];
  let messages: string[] = [];
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    async exec(_command: string, _args: string[], opts?: { signal?: AbortSignal }) {
      if (opts?.signal) signals = [...signals, opts.signal];
      if (execResult === "pending") return new Promise(() => {});
      return execResult;
    },
    sendUserMessage(content: string) {
      messages = [...messages, content];
    },
    sendMessage() {},
  };
  const ctx = { ui: { setStatus() {}, notify() {} } };
  registerHeartbeat(pi as never);
  return {
    tool: () => tool as CapturedTool,
    signals: () => signals,
    messages: () => messages,
    ctx,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function armWatcher(env: ReturnType<typeof fakeLoopEnv>): Promise<unknown> {
  return env.tool().execute(
    "t",
    { action: "arm", mode: "watcher", prompt: "wake", watchArgv: ["watch-pr", "--status-only"] },
    undefined,
    undefined,
    env.ctx,
  );
}

test("a watcher that exits zero wakes the loop with reason=watcher", async () => {
  const env = fakeLoopEnv({ code: 0, stdout: "READY", stderr: "" });
  await armWatcher(env);
  await flush();
  assert.match(env.messages().at(-1) ?? "", /reason=watcher\]/);
});

test("a watcher that exits nonzero wakes with reason=watcher-error", async () => {
  const env = fakeLoopEnv({ code: 2, stdout: "", stderr: "blocked" });
  await armWatcher(env);
  await flush();
  const last = env.messages().at(-1) ?? "";
  assert.match(last, /reason=watcher-error\]/);
  assert.match(last, /watcher output \(exit 2\)/);
});

test("stopping a loop aborts the running watcher", async () => {
  const env = fakeLoopEnv("pending");
  await armWatcher(env);
  await flush();
  assert.equal(env.signals().at(-1)?.aborted, false);
  await env.tool().execute("t", { action: "stop" }, undefined, undefined, env.ctx);
  assert.equal(env.signals().at(-1)?.aborted, true);
});
