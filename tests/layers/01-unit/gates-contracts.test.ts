import { test } from "node:test";
import assert from "node:assert/strict";
import { registerGates } from "../../../extensions/gates/index.ts";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Notification {
  message: string;
  level?: string;
}

type GatesHandler = (args: string, ctx: unknown) => Promise<void>;

interface CommandSpec {
  description?: string;
  handler: GatesHandler;
}

function fakeGatesEnv(results: ExecResult[]) {
  const commands = new Map<string, CommandSpec>();
  let calls: Array<{ command: string; args: string[] }> = [];
  let notifications: Notification[] = [];
  let messages: string[] = [];
  let execIndex = 0;
  const pi = {
    registerCommand(name: string, spec: CommandSpec) {
      commands.set(name, spec);
    },
    async exec(command: string, args: string[]) {
      calls = [...calls, { command, args }];
      const result = results[execIndex] ?? { code: 0, stdout: "{}", stderr: "" };
      execIndex = execIndex + 1;
      return result;
    },
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
    ctx,
    notifications: () => notifications,
    messages: () => messages,
    calls: () => calls,
    handler: (args: string) => commands.get("pstack-gates")?.handler(args, ctx),
  };
}

const JSON_ARGS = "state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url,title";

test("gates-01 registers the /pstack-gates command for a single PR argument", () => {
  const env = fakeGatesEnv([]);
  const spec = env.commands.get("pstack-gates");
  assert.ok(spec, "pstack-gates must be registered");
  assert.equal(typeof spec?.handler, "function");
  assert.match(spec?.description ?? "", /fail closed/);
  assert.match(spec?.description ?? "", /Usage: \/pstack-gates <pr>/);
});

test("gates-03 shows a usage error when no PR is supplied", async () => {
  const env = fakeGatesEnv([]);
  await env.handler("   ");
  assert.deepEqual(env.calls(), [], "a usage error must not call gh");
  assert.deepEqual(env.messages(), [], "a usage error sends no follow-up");
  assert.deepEqual(env.notifications(), [
    {
      message: "Usage: /pstack-gates <pr>. Also run /skill:unslop → /skill:no-comments → prove-it-works.",
      level: "error",
    },
  ]);
});

test("gates-04 fails closed when gh pr view errors or returns invalid JSON", async () => {
  const failed = fakeGatesEnv([{ code: 1, stdout: "", stderr: "gh: not authenticated" }]);
  await failed.handler("42");
  assert.deepEqual(failed.notifications(), [
    { message: "Gate check FAILED (fail closed): cannot view PR \u2014 gh: not authenticated", level: "error" },
  ]);
  assert.deepEqual(failed.messages(), [], "a failed view sends no follow-up");
  assert.deepEqual(failed.calls(), [{ command: "gh", args: ["pr", "view", "42", "--json", JSON_ARGS] }]);

  const invalid = fakeGatesEnv([{ code: 0, stdout: "<html>nope", stderr: "" }]);
  await invalid.handler("42");
  assert.deepEqual(invalid.notifications(), [
    { message: "Gate check FAILED (fail closed): invalid gh JSON", level: "error" },
  ]);
  assert.deepEqual(invalid.messages(), [], "invalid JSON sends no follow-up");
});

test("gates-05 notifies an error and sends a do-not-ship follow-up on a gate problem", async () => {
  const env = fakeGatesEnv([
    {
      code: 0,
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }],
        reviewDecision: "CHANGES_REQUESTED",
        url: "https://example.test/pr/42",
        title: "Risky change",
      }),
      stderr: "",
    },
  ]);
  await env.handler("#42");
  const problems = "mergeStateStatus=BLOCKED; check ci=FAILURE; reviewDecision=CHANGES_REQUESTED";
  assert.deepEqual(env.notifications(), [
    { message: `Gate check FAILED (fail closed): ${problems}`, level: "error" },
  ]);
  assert.deepEqual(env.messages(), [
    `pstack-gates FAIL for PR 42: ${problems}. Do not ship. Fix gates, then re-run /pstack-gates 42. Also: unslop → no-comments → prove-it-works.`,
  ]);
});

test("gates-06 notifies pass and sends the still-run-unslop follow-up with no problem found", async () => {
  const env = fakeGatesEnv([
    {
      code: 0,
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
        reviewDecision: "APPROVED",
        url: "https://example.test/pr/7",
        title: "Tiny fix",
      }),
      stderr: "",
    },
  ]);
  await env.handler("#7");
  assert.deepEqual(env.notifications(), [{ message: "Gate check PASS for PR 7 (CLEAN)", level: "info" }]);
  assert.deepEqual(env.messages(), [
    "pstack-gates PASS for PR 7 (Tiny fix) https://example.test/pr/7. Still run unslop → no-comments → prove-it-works on the real artifact before merge.",
  ]);
  assert.equal(env.calls()[0].args.includes("7"), true, "the # prefix is stripped before gh");
  assert.equal(env.calls()[0].args.includes("#7"), false);
});
