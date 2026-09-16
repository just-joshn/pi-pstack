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
  let execFailure: Error | undefined;
  let sendFailure: Error | undefined;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tool = definition;
    },
    async exec(_command: string, _args: string[], opts?: { signal?: AbortSignal }) {
      if (opts?.signal) signals = [...signals, opts.signal];
      if (execFailure) throw execFailure;
      if (execResult === "pending") return new Promise(() => {});
      return execResult;
    },
    sendUserMessage(content: string) {
      if (sendFailure) throw sendFailure;
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
    failExec: (error: Error) => {
      execFailure = error;
    },
    failSend: (error: Error) => {
      sendFailure = error;
    },
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

test("a rejected watcher arm does not leave a phantom loop in status", async () => {
  const env = fakeLoopEnv({ code: 0, stdout: "", stderr: "" });
  await assert.rejects(
    env.tool().execute(
      "t",
      { action: "arm", mode: "watcher", prompt: "wake", watchArgv: ["-x"] },
      undefined,
      undefined,
      env.ctx,
    ),
    /watchArgv\[0\] must be a command path\/name/,
  );
  const status = (await env.tool().execute(
    "t",
    { action: "status" },
    undefined,
    undefined,
    env.ctx,
  )) as { content: Array<{ text: string }> };
  assert.equal(status.content[0].text, "(no active loops)");
});

test("a watcher whose argv fails to spawn wakes with the crash cause, not a silent stop", async () => {
  const env = fakeLoopEnv({ code: 0, stdout: "", stderr: "" });
  env.failExec(new Error("spawn watch-pr ENOENT"));
  await armWatcher(env);
  await flush();
  await flush();
  const last = env.messages().at(-1) ?? "";
  assert.match(last, /reason=watcher-error\]/);
  assert.match(last, /--- watcher failed ---\nspawn watch-pr ENOENT/);
});

test("a host refusal to deliver is recorded on the loop instead of becoming an unhandled rejection", async () => {
  const env = fakeLoopEnv({ code: 0, stdout: "READY", stderr: "" });
  env.failSend(new Error("host refused sendUserMessage"));
  let rejections: unknown[] = [];
  const listener = (reason: unknown) => {
    rejections = [...rejections, reason];
  };
  process.on("unhandledRejection", listener);
  try {
    await armWatcher(env);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = (await env.tool().execute(
      "t",
      { action: "status" },
      undefined,
      undefined,
      env.ctx,
    )) as { content: Array<{ text: string }> };
    assert.deepEqual(rejections, []);
    assert.equal(
      status.content[0].text,
      "loop-1 mode=watcher fires=1/50 armed=true lastReason=deliver-failed (host refused sendUserMessage)",
    );
  } finally {
    process.off("unhandledRejection", listener);
  }
});
