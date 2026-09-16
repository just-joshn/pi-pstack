import { expect, test, vi } from "vitest";
import {
  BABYSIT_WATCH_RECIPES,
  DEFAULT_BABYSIT_RECIPE,
  babysitDynamicLoopHint,
} from "../../../extensions/shipping/babysit-recipes.ts";

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

// index.ts gates the drive/status gh fallback on existsSync of the bundled
// watch-pr path and exports no seam for it. Mocking node:fs is the only way to
// observe that branch while the asset exists in-tree.
let hideBundledWatchPr = false;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    existsSync: (path: string): boolean =>
      hideBundledWatchPr && String(path).endsWith("scripts/watch-pr/watch-pr")
        ? false
        : actual.existsSync(path),
  };
});

const { registerShipping } = await import("../../../extensions/shipping/index.ts");

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

async function runBabysit(env: ReturnType<typeof fakePi>, params: Record<string, unknown>) {
  return await env.tool("pstack_babysit").execute("t", params);
}

const bunOk: ExecResult = { code: 0, stdout: "1.3.0", stderr: "" };
const ready: ExecResult = { code: 0, stdout: "PR READY", stderr: "" };

test("babysit-01 registers pstack_babysit with pr required and the documented optional params", () => {
  const env = fakePi([ready]);
  const tool = env.tool("pstack_babysit");
  expect(tool.name).toBe("pstack_babysit");
  expect(tool.promptSnippet).toBe("Watch PR checks/comments until ready or blocked");
  expect(tool.parameters.type).toBe("object");
  expect(tool.parameters.required).toEqual(["pr"]);
  expect(Object.keys(tool.parameters.properties ?? {}).toSorted()).toEqual([
    "armLoopHint",
    "pr",
    "pretty",
    "recipeId",
    "stackPrs",
    "statusOnly",
  ]);
  expect(tool.parameters.properties?.pr?.type).toBe("string");
  expect(tool.parameters.properties?.statusOnly?.type).toBe("boolean");
  expect(tool.parameters.properties?.pretty?.type).toBe("boolean");
  expect(tool.parameters.properties?.recipeId?.type).toBe("string");
  expect(tool.parameters.properties?.stackPrs?.type).toBe("array");
  expect(tool.parameters.properties?.armLoopHint?.type).toBe("boolean");
});

test("babysit-02 defaults the recipe to watch-pr-drive and forces status on statusOnly", async () => {
  expect(DEFAULT_BABYSIT_RECIPE).toBe("watch-pr-drive");
  const drive = await runBabysit(fakePi([bunOk, ready]), { pr: "#123" });
  expect(drive.details.recipeId).toBe("watch-pr-drive");
  expect(drive.details.watchArgv).toEqual([
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--pr",
    "123",
  ]);
  const forced = await runBabysit(fakePi([bunOk, ready]), {
    pr: "123",
    statusOnly: true,
    recipeId: "gh-view-json",
  });
  expect(forced.details.recipeId).toBe("watch-pr-status");
  expect(forced.details.watchArgv).toEqual([
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--pr",
    "123",
    "--status-only",
  ]);
});

test("babysit-03 rejects an unknown recipeId with an error listing the known recipes", async () => {
  const env = fakePi([ready]);
  await expect(runBabysit(env, { pr: "1", recipeId: "nope" })).rejects.toThrow("unknown babysit recipeId 'nope'. Known: watch-pr-status, watch-pr-drive, watch-pr-stack, watch-pr-queued-stack, gh-checks-watch, gh-view-json");
  expect(Object.keys(BABYSIT_WATCH_RECIPES)).toEqual([
    "watch-pr-status",
    "watch-pr-drive",
    "watch-pr-stack",
    "watch-pr-queued-stack",
    "gh-checks-watch",
    "gh-view-json",
  ]);
  expect(env.calls().length).toBe(0);
});

test("babysit-10 returns a dynamic loopArm with the materialized watchArgv and frontier prompt", async () => {
  const expectedArm = {
    action: "arm",
    mode: "dynamic",
    intervalSeconds: 120,
    maxFires: 40,
    watchArgv: ["gh", "pr", "checks", "42", "--watch"],
    prompt: "Babysit frontier PR 42: re-read forge state and clear the next blocker.",
  };
  expect(babysitDynamicLoopHint("42", "gh-checks-watch").loopArm).toEqual(expectedArm);
  const result = await runBabysit(fakePi([ready]), { pr: "#42", recipeId: "gh-checks-watch" });
  expect(result.details.loopArm).toEqual(expectedArm);
});

test("babysit-11 includes the loopArm hint by default and omits it on armLoopHint false", async () => {
  const expectedArm = {
    action: "arm",
    mode: "dynamic",
    intervalSeconds: 120,
    maxFires: 40,
    watchArgv: [
      "gh",
      "pr",
      "view",
      "7",
      "--json",
      "state,mergeStateStatus,statusCheckRollup,reviewDecision",
    ],
    prompt: "Babysit frontier PR 7: re-read forge state and clear the next blocker.",
  };
  const included = await runBabysit(fakePi([ready]), { pr: "7", recipeId: "gh-view-json" });
  expect(included.details.loopArm).toEqual(expectedArm);
  expect(included.content[0].text).toMatch(/--- pstack_loop dynamic arm ---/);
  const omitted = await runBabysit(fakePi([ready]), {
    pr: "7",
    recipeId: "gh-view-json",
    armLoopHint: false,
  });
  expect(omitted.details.loopArm).toBe(undefined);
  expect(omitted.content[0].text).toBe("PR READY");
});

test("babysit-12 builds the gh-checks-watch recipe as gh pr checks <pr> --watch", async () => {
  const env = fakePi([ready]);
  const result = await runBabysit(env, { pr: "#123", recipeId: "gh-checks-watch" });
  expect(argvLog(env)).toEqual([["gh", ["pr", "checks", "123", "--watch"]]]);
  expect(result.details.via).toBe("gh-recipe");
  expect(result.details.watchArgv).toEqual(["gh", "pr", "checks", "123", "--watch"]);
});

test("babysit-13 builds the gh-view-json recipe as gh pr view <pr> --json <fields>", async () => {
  const env = fakePi([ready]);
  const result = await runBabysit(env, { pr: "123", recipeId: "gh-view-json" });
  expect(argvLog(env)).toEqual([
    ["gh", ["pr", "view", "123", "--json", "state,mergeStateStatus,statusCheckRollup,reviewDecision"]],
  ]);
  expect(result.details.via).toBe("gh-recipe");
});

test("babysit-14 runs gh-checks-watch with a one-hour timeout and gh-view-json with 60s", async () => {
  const checks = fakePi([ready]);
  await runBabysit(checks, { pr: "1", recipeId: "gh-checks-watch" });
  expect(checks.calls()[0]?.opts?.timeout).toBe(3_600_000);
  const view = fakePi([ready]);
  await runBabysit(view, { pr: "1", recipeId: "gh-view-json" });
  expect(view.calls()[0]?.opts?.timeout).toBe(60_000);
});

test("babysit-15 falls back to one-shot gh pr view when the bundled watch-pr script is absent", async () => {
  hideBundledWatchPr = true;
  try {
    const drive = fakePi([ready]);
    const driveResult = await runBabysit(drive, { pr: "55" });
    expect(argvLog(drive)).toEqual([
      [
        "gh",
        [
          "pr",
          "view",
          "55",
          "--json",
          "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,url,reviewDecision",
        ],
      ],
    ]);
    expect(driveResult.details.via).toBe("gh");
    expect(driveResult.details.recipeId).toBe("watch-pr-drive");
    const status = fakePi([ready]);
    const statusResult = await runBabysit(status, { pr: "55", statusOnly: true });
    expect(statusResult.details.recipeId).toBe("watch-pr-status");
    expect(argvLog(status)).toEqual([
      [
        "gh",
        [
          "pr",
          "view",
          "55",
          "--json",
          "number,title,state,mergedAt,mergeStateStatus,statusCheckRollup,url,reviewDecision",
        ],
      ],
    ]);
  } finally {
    hideBundledWatchPr = false;
  }
});
