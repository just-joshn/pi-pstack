import { expect, test } from "vitest";
import { registerGates } from "../../../extensions/gates/index.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;

function fakeGatesEnv(view: unknown) {
  const commands = new Map<string, { handler: Handler }>();
  let notifications: Array<{ message: string; level?: string }> = [];
  let messages: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: Handler }) {
      commands.set(name, options);
    },
    exec: async () => ({ code: 0, stdout: JSON.stringify(view), stderr: "" }),
    sendUserMessage(content: string) {
      messages = [...messages, content];
    },
  };
  const ctx = {
    ui: {
      notify(message: string, level?: string) {
        notifications = [...notifications, { message, level }];
      },
    },
  };
  registerGates(pi as never);
  return {
    commands,
    notifications: () => notifications,
    messages: () => messages,
    ctx,
  };
}

test("/pstack-gates fails a PR that the merge gate would block", async () => {
  const env = fakeGatesEnv({
    state: "OPEN",
    mergeStateStatus: "BLOCKED",
    statusCheckRollup: [],
    reviewDecision: null,
  });
  await env.commands.get("pstack-gates")?.handler("42", env.ctx);
  expect(env.notifications().at(-1)?.level).toBe("error");
  expect(env.notifications().at(-1)?.message ?? "").toMatch(/mergeStateStatus=BLOCKED/);
  expect(env.messages().at(-1) ?? "").toMatch(/Do not ship/);
});

test("/pstack-gates passes a merge-ready PR", async () => {
  const env = fakeGatesEnv({
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    reviewDecision: "APPROVED",
  });
  await env.commands.get("pstack-gates")?.handler("42", env.ctx);
  expect(env.notifications().at(-1)?.level).toBe("info");
  expect(env.notifications().at(-1)?.message ?? "").toMatch(/Gate check PASS/);
  expect(env.messages().at(-1) ?? "").toMatch(/Still run unslop/);
});
