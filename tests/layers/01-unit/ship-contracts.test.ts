import { expect, test } from "vitest";
import { registerShipping } from "../../../extensions/shipping/index.ts";

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

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  promptSnippet?: string;
  parameters: {
    type?: string;
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
}

function fakePi(results: ExecResult[] | ((call: ExecCall) => ExecResult)) {
  const tools = new Map<string, CapturedTool>();
  let calls: ExecCall[] = [];
  let cursor = 0;
  const pi = {
    on() {},
    registerCommand() {},
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    async exec(command: string, args: string[], opts?: ExecCall["opts"]) {
      calls = [...calls, { command, args, opts }];
      if (typeof results === "function") return results({ command, args, opts });
      const result = results[cursor];
      cursor += 1;
      if (!result) throw new Error(`unexpected exec: ${command} ${args.join(" ")}`);
      return result;
    },
    sendUserMessage() {},
    sendMessage() {},
  };
  registerShipping(pi as never);
  return {
    tool: (name: string): CapturedTool => {
      const definition = tools.get(name);
      if (!definition) throw new Error(`${name} was not registered`);
      return definition;
    },
    calls: (): ExecCall[] => calls,
  };
}

function argvLog(env: ReturnType<typeof fakePi>): Array<[string, string[]]> {
  return env.calls().map((call) => [call.command, call.args] as [string, string[]]);
}

async function runShip(env: ReturnType<typeof fakePi>, params: Record<string, unknown>) {
  return await env.tool("pstack_ship").execute("t", params);
}

const CLEAN_VIEW = {
  number: 42,
  title: "Green PR",
  state: "OPEN",
  mergedAt: null,
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
  url: "https://github.test/pr/42",
};

const GATE_VIEW_ARGV = [
  "pr",
  "view",
  "42",
  "--json",
  "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url",
];

const gateOk: ExecResult = { code: 0, stdout: JSON.stringify(CLEAN_VIEW), stderr: "" };

test("ship-01 registers pstack_ship with action required and pr, stackPrs, mergeMethod optional", () => {
  const env = fakePi([gateOk]);
  const tool = env.tool("pstack_ship");
  expect(tool.name).toBe("pstack_ship");
  expect(tool.promptSnippet).toBe("Merge or inspect a green PR stack with gh");
  expect(tool.parameters.type).toBe("object");
  expect(tool.parameters.required).toEqual(["action"]);
  expect(Object.keys(tool.parameters.properties ?? {}).toSorted()).toEqual([
    "action",
    "mergeMethod",
    "pr",
    "stackPrs",
  ]);
  expect(tool.parameters.properties?.action?.type).toBe("string");
  expect(tool.parameters.properties?.pr?.type).toBe("string");
  expect(tool.parameters.properties?.stackPrs?.type).toBe("array");
  expect(tool.parameters.properties?.mergeMethod?.type).toBe("string");
});

test("ship-11 fails closed in assertMergeGates on a nonzero view exit or invalid gh JSON", async () => {
  const failed = fakePi([{ code: 1, stdout: "", stderr: "gh: could not resolve PR" }]);
  await expect(runShip(failed, { action: "gate-check", pr: "9" })).rejects.toThrow("merge gate check failed (fail closed): cannot view PR \u2014 gh: could not resolve PR");
  expect(argvLog(failed)).toEqual([
    [
      "gh",
      [
        "pr",
        "view",
        "9",
        "--json",
        "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url",
      ],
    ],
  ]);
  const badJson = fakePi([{ code: 0, stdout: "<html>not json</html>", stderr: "" }]);
  await expect(runShip(badJson, { action: "gate-check", pr: "9" })).rejects.toThrow("merge gate check failed (fail closed): invalid gh JSON");
});

test("ship-12 runs the gate check before merging and merges with --squash by default", async () => {
  const env = fakePi([gateOk, { code: 0, stdout: "merged", stderr: "" }]);
  const result = await runShip(env, { action: "merge", pr: "#42" });
  expect(argvLog(env)).toEqual([
    ["gh", GATE_VIEW_ARGV],
    ["gh", ["pr", "merge", "42", "--squash"]],
  ]);
  expect(result.details.gate).toEqual(CLEAN_VIEW);
});

test("ship-13 maps mergeMethod to the gh flag", async () => {
  const cases: Array<[string | undefined, string]> = [
    ["merge", "--merge"],
    ["rebase", "--rebase"],
    ["squash", "--squash"],
    ["bogus", "--squash"],
    [undefined, "--squash"],
  ];
  let observed: string[] = [];
  for (const [method, flag] of cases) {
    const env = fakePi([gateOk, { code: 0, stdout: "merged", stderr: "" }]);
    const params =
      method === undefined
        ? { action: "merge", pr: "42" }
        : { action: "merge", pr: "42", mergeMethod: method };
    await runShip(env, params);
    const mergeArgs = env.calls().at(-1)?.args ?? [];
    observed = [...observed, mergeArgs.at(-1) ?? "missing"];
    expect(mergeArgs.at(-1), `mergeMethod=${String(method)}`).toBe(flag);
  }
  expect(observed).toEqual(["--merge", "--rebase", "--squash", "--squash", "--squash"]);
});

test("ship-14 throws the fail-closed merge error when gh pr merge exits nonzero", async () => {
  const env = fakePi([gateOk, { code: 1, stdout: "", stderr: "merge conflict" }]);
  await expect(runShip(env, { action: "merge", pr: "8" })).rejects.toThrow("gh pr merge failed (fail closed): merge conflict");
  expect(argvLog(env)).toEqual([
    [
      "gh",
      [
        "pr",
        "view",
        "8",
        "--json",
        "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url",
      ],
    ],
    ["gh", ["pr", "merge", "8", "--squash"]],
  ]);
});

test("ship-15 returns gate-check PASS plus the JSON PR view", async () => {
  const env = fakePi([gateOk]);
  const result = await runShip(env, { action: "gate-check", pr: "#11" });
  expect(result.content[0].text).toBe(`gate-check PASS\n${JSON.stringify(CLEAN_VIEW, null, 2)}`);
  expect(result.details.gate).toEqual(CLEAN_VIEW);
  expect(argvLog(env)).toEqual([
    [
      "gh",
      [
        "pr",
        "view",
        "11",
        "--json",
        "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,reviewDecision,url",
      ],
    ],
  ]);
});

test("ship-16 requires pr for view, merge, gate-check and rejects an unknown action", async () => {
  const env = fakePi([]);
  await expect(runShip(env, { action: "view" })).rejects.toThrow("pr required");
  await expect(runShip(env, { action: "merge" })).rejects.toThrow("pr required for merge");
  await expect(runShip(env, { action: "gate-check" })).rejects.toThrow("pr required for gate-check");
  await expect(runShip(env, { action: "bogus", pr: "1" })).rejects.toThrow("action must be view|merge|stack-status|gate-check");
  expect(env.calls().length).toBe(0);
});

test("ship-17 requires at least one PR for stack-status via stackPrs or pr", async () => {
  const empty = fakePi([]);
  await expect(runShip(empty, { action: "stack-status" })).rejects.toThrow("stackPrs or pr required");
  expect(empty.calls().length).toBe(0);
  const single = fakePi([{ code: 0, stdout: JSON.stringify({ ...CLEAN_VIEW, number: 7 }), stderr: "" }]);
  const result = await runShip(single, { action: "stack-status", pr: "#7" });
  expect(argvLog(single)).toEqual([
    [
      "gh",
      [
        "pr",
        "view",
        "7",
        "--json",
        "number,state,mergedAt,mergeStateStatus,title,statusCheckRollup,reviewDecision",
      ],
    ],
  ]);
  expect(result.details.verdict).toBe("ADVANCE");
  expect(result.details.frontier).toBe("7");
  const stacked = fakePi([
    { code: 0, stdout: JSON.stringify({ ...CLEAN_VIEW, number: 3, state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }), stderr: "" },
    { code: 0, stdout: JSON.stringify({ ...CLEAN_VIEW, number: 5 }), stderr: "" },
  ]);
  const stackResult = await runShip(stacked, { action: "stack-status", stackPrs: ["3", "5"] });
  expect(stacked.calls().map((call) => call.args[2])).toEqual(["3", "5"]);
  expect(stackResult.details.verdict).toBe("ADVANCE");
  expect(stackResult.details.frontier).toBe("5");
});
