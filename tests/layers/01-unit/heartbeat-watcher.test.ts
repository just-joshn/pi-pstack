import { expect, test } from "vitest";
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
  expect(env.messages().at(-1) ?? "").toMatch(/reason=watcher\]/);
});

test("a watcher that exits nonzero wakes with reason=watcher-error", async () => {
  const env = fakeLoopEnv({ code: 2, stdout: "", stderr: "blocked" });
  await armWatcher(env);
  await flush();
  const last = env.messages().at(-1) ?? "";
  expect(last).toMatch(/reason=watcher-error\]/);
  expect(last).toMatch(/watcher output \(exit 2\)/);
});

test("stopping a loop aborts the running watcher", async () => {
  const env = fakeLoopEnv("pending");
  await armWatcher(env);
  await flush();
  expect(env.signals().at(-1)?.aborted).toBe(false);
  await env.tool().execute("t", { action: "stop" }, undefined, undefined, env.ctx);
  expect(env.signals().at(-1)?.aborted).toBe(true);
});

test("a rejected watcher arm does not leave a phantom loop in status", async () => {
  const env = fakeLoopEnv({ code: 0, stdout: "", stderr: "" });
  await expect(env.tool().execute(
      "t",
      { action: "arm", mode: "watcher", prompt: "wake", watchArgv: ["-x"] },
      undefined,
      undefined,
      env.ctx,
    )).rejects.toThrow(/watchArgv\[0\] must be a command path\/name/);
  const status = (await env.tool().execute(
    "t",
    { action: "status" },
    undefined,
    undefined,
    env.ctx,
  )) as { content: Array<{ text: string }> };
  expect(status.content[0].text).toBe("(no active loops)");
});

test("a watcher whose argv fails to spawn wakes with the crash cause, not a silent stop", async () => {
  const env = fakeLoopEnv({ code: 0, stdout: "", stderr: "" });
  env.failExec(new Error("spawn watch-pr ENOENT"));
  await armWatcher(env);
  await flush();
  await flush();
  const last = env.messages().at(-1) ?? "";
  expect(last).toMatch(/reason=watcher-error\]/);
  expect(last).toMatch(/--- watcher failed ---\nspawn watch-pr ENOENT/);
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
    expect(rejections).toEqual([]);
    expect(status.content[0].text).toBe("loop-1 mode=watcher fires=1/50 armed=true lastReason=deliver-failed (host refused sendUserMessage)");
  } finally {
    process.off("unhandledRejection", listener);
  }
});
