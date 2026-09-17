import { expect, test } from "vitest";
import { registerShipping } from "../../../extensions/shipping/index.ts";
import { DEFAULT_BABYSIT_RECIPE, babysitDynamicLoopHint } from "../../../extensions/shipping/babysit-recipes.ts";
import { evaluateStack } from "../../../extensions/shipping/frontier.ts";
import { evaluateMergeGates } from "../../../extensions/shipping/gates.ts";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecCall {
  command: string;
  args: string[];
  opts?: { signal?: AbortSignal; timeout?: number };
}

interface ToolTextPart {
  type: string;
  text: string;
}

interface ShippingOutcome {
  content: ToolTextPart[];
  details: Record<string, unknown>;
}

interface ShippingTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ShippingOutcome>;
}

function shippingEnv(results: ExecResult[]) {
  const tools = new Map<string, ShippingTool>();
  let calls: ExecCall[] = [];
  let cursor = 0;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: ShippingTool) {
      tools.set(definition.name, definition);
    },
    async exec(command: string, args: string[], opts?: ExecCall["opts"]) {
      calls = [...calls, { command, args, opts }];
      const result = results[cursor];
      cursor = cursor + 1;
      if (!result) throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      return result;
    },
  };
  registerShipping(pi as never);
  return {
    tool(name: string): ShippingTool {
      const definition = tools.get(name);
      if (!definition) throw new Error(`${name} was not registered`);
      return definition;
    },
    calls: (): ExecCall[] => calls,
  };
}

function argv(call: ExecCall): [string, string[]] {
  return [call.command, call.args];
}

function json(value: unknown): ExecResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

test("pstack_ship action=view returns the gh pr view body and single-PR JSON fields", async () => {
  const env = shippingEnv([{ code: 0, stdout: "PR #42: Green PR", stderr: "" }]);
  const result = await env.tool("pstack_ship").execute("t", { action: "view", pr: "#42" });
  expect(result.content.length).toBe(1);
  expect(result.content[0].text).toBe("PR #42: Green PR");
  expect(result.details).toEqual({ code: 0 });
  expect(env.calls().map(argv)).toEqual([
    [
      "gh",
      ["pr", "view", "42", "--json", "number,title,state,mergedAt,mergeStateStatus,url,statusCheckRollup"],
    ],
  ]);
});

test("pstack_ship action=view falls back to stderr when gh writes no stdout", async () => {
  const env = shippingEnv([{ code: 1, stdout: "", stderr: "gh: could not resolve to a PullRequest" }]);
  const result = await env.tool("pstack_ship").execute("t", { action: "view", pr: "42" });
  expect(result.content[0].text).toBe("gh: could not resolve to a PullRequest");
  expect(result.details.code).toBe(1);
});

test("pstack_ship gate-check refuses a blocked PR with the ordered problem list", async () => {
  const env = shippingEnv([
    json({
      number: 42,
      state: "CLOSED",
      mergeStateStatus: "DIRTY",
      reviewDecision: "CHANGES_REQUESTED",
      statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }],
    }),
  ]);
  await expect(env.tool("pstack_ship").execute("t", { action: "gate-check", pr: "42" })).rejects.toThrow("merge gate check failed (fail closed): state=CLOSED; mergeStateStatus=DIRTY; check ci=FAILURE; reviewDecision=CHANGES_REQUESTED");
  expect(env.calls().map(argv)).toEqual([
    [
      "gh",
      [
        "pr",
        "view",
        "42",
        "--json",
        "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url",
      ],
    ],
  ]);
});

test("pstack_ship merge fails closed on a draft gate and never reaches gh pr merge", async () => {
  const env = shippingEnv([json({ number: 7, state: "OPEN", mergeStateStatus: "DRAFT" })]);
  await expect(env.tool("pstack_ship").execute("t", { action: "merge", pr: "7" })).rejects.toThrow("merge gate check failed (fail closed): mergeStateStatus=DRAFT");
  expect(env.calls().length, "only the read-only gate view ran").toBe(1);
  expect(env.calls()[0].args.slice(0, 2)).toEqual(["pr", "view"]);
});

test("pstack_ship stack-status treats unparseable gh JSON as an unknown frontier", async () => {
  const env = shippingEnv([{ code: 0, stdout: "<html>rate limited</html>", stderr: "" }]);
  const result = await env.tool("pstack_ship").execute("t", { action: "stack-status", pr: "#9" });
  expect(result.content[0].text).toBe("stack WAITING frontier=#9\n9 state=UNKNOWN mergeStateStatus=?\nfrontier blockers: state=UNKNOWN");
  expect(result.details).toEqual({
    verdict: "WAITING",
    frontier: "9",
    problems: ["state=UNKNOWN"],
  });
});

test("pstack_ship stack-status marks a nonzero gh exit as an unknown row", async () => {
  const env = shippingEnv([{ code: 1, stdout: "", stderr: "gh: authentication required" }]);
  const result = await env.tool("pstack_ship").execute("t", { action: "stack-status", stackPrs: ["4"] });
  expect(result.content[0].text).toBe("stack WAITING frontier=#4\n4 state=UNKNOWN mergeStateStatus=?\nfrontier blockers: state=UNKNOWN");
  expect(result.details.frontier).toBe("4");
  expect(result.details.problems).toEqual(["state=UNKNOWN"]);
});

test("pstack_babysit refuses watch-pr-queued-stack without stackPrs before running anything", async () => {
  const env = shippingEnv([]);
  await expect(env.tool("pstack_babysit").execute("t", { pr: "12", recipeId: "watch-pr-queued-stack" })).rejects.toThrow("recipeId=watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers)");
  expect(env.calls()).toEqual([]);
});

test("babysitDynamicLoopHint materializes the drive recipe into a dynamic loop arm", () => {
  const hint = babysitDynamicLoopHint("#42");
  expect(hint.recipeId).toBe("watch-pr-drive");
  expect(hint.recipeId).toBe(DEFAULT_BABYSIT_RECIPE);
  expect(hint.watchArgv[0]).toBe("bun");
  expect(hint.watchArgv.at(-1)).toBe("42");
  expect(hint.loopArm).toEqual({
    action: "arm",
    mode: "dynamic",
    intervalSeconds: 120,
    maxFires: 40,
    watchArgv: hint.watchArgv,
    prompt: "Babysit frontier PR 42: re-read forge state and clear the next blocker.",
  });
});

test("babysitDynamicLoopHint joins a queued stack into one bottom-to-top token", () => {
  const hint = babysitDynamicLoopHint("7", "watch-pr-queued-stack", ["#3", "5"]);
  expect(hint.recipeId).toBe("watch-pr-queued-stack");
  expect(hint.watchArgv.slice(2)).toEqual(["--queued-stack", "--stack-prs", "3,5"]);
  expect(String(hint.loopArm.prompt)).toMatch(/Babysit frontier PR 7:/);
});

test("evaluateStack reports COMPLETE with no rows for an empty stack", () => {
  expect(evaluateStack([])).toEqual({ verdict: "COMPLETE", problems: [], rows: [] });
});

test("evaluateMergeGates ignores a pending status once a conclusion is recorded", () => {
  expect(evaluateMergeGates({
      state: "OPEN",
      statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS", status: "PENDING" }],
    })).toEqual([]);
});

test("evaluateMergeGates falls back to the legacy check state field", () => {
  expect(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ name: "ci", state: "ERROR" }] })).toEqual(["check ci=ERROR"]);
  expect(evaluateMergeGates({ state: "OPEN", statusCheckRollup: [{ state: "CANCELLED" }] })).toEqual(["check ?=CANCELLED"]);
});
