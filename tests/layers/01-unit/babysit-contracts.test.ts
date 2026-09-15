import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
// watch-pr path and exports no seam for it. Patching the CommonJS fs export
// before the module graph first resolves node:fs is the only way to observe
// that branch while the asset exists in-tree.
const cjsRequire = createRequire(import.meta.url);
const fsCjs = cjsRequire("node:fs") as { existsSync: (path: string) => boolean };
const realExistsSync = fsCjs.existsSync;
let hideBundledWatchPr = false;
fsCjs.existsSync = (path: string): boolean =>
  hideBundledWatchPr && String(path).endsWith("scripts/watch-pr/watch-pr")
    ? false
    : realExistsSync(path);
const fsEsm = (await import("node:fs")) as { existsSync: (path: string) => boolean };
const existsSyncPatchVisible = fsEsm.existsSync === fsCjs.existsSync;

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
  assert.equal(tool.name, "pstack_babysit");
  assert.equal(tool.promptSnippet, "Watch PR checks/comments until ready or blocked");
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["pr"]);
  assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).toSorted(), [
    "armLoopHint",
    "pr",
    "pretty",
    "recipeId",
    "stackPrs",
    "statusOnly",
  ]);
  assert.equal(tool.parameters.properties?.pr?.type, "string");
  assert.equal(tool.parameters.properties?.statusOnly?.type, "boolean");
  assert.equal(tool.parameters.properties?.pretty?.type, "boolean");
  assert.equal(tool.parameters.properties?.recipeId?.type, "string");
  assert.equal(tool.parameters.properties?.stackPrs?.type, "array");
  assert.equal(tool.parameters.properties?.armLoopHint?.type, "boolean");
});

test("babysit-02 defaults the recipe to watch-pr-drive and forces status on statusOnly", async () => {
  assert.equal(DEFAULT_BABYSIT_RECIPE, "watch-pr-drive");
  const drive = await runBabysit(fakePi([bunOk, ready]), { pr: "#123" });
  assert.equal(drive.details.recipeId, "watch-pr-drive");
  assert.deepEqual(drive.details.watchArgv, [
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
  assert.equal(forced.details.recipeId, "watch-pr-status");
  assert.deepEqual(forced.details.watchArgv, [
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--pr",
    "123",
    "--status-only",
  ]);
});

test("babysit-03 rejects an unknown recipeId with an error listing the known recipes", async () => {
  const env = fakePi([ready]);
  await assert.rejects(runBabysit(env, { pr: "1", recipeId: "nope" }), {
    message:
      "unknown babysit recipeId 'nope'. Known: watch-pr-status, watch-pr-drive, watch-pr-stack, watch-pr-queued-stack, gh-checks-watch, gh-view-json",
  });
  assert.deepEqual(Object.keys(BABYSIT_WATCH_RECIPES), [
    "watch-pr-status",
    "watch-pr-drive",
    "watch-pr-stack",
    "watch-pr-queued-stack",
    "gh-checks-watch",
    "gh-view-json",
  ]);
  assert.equal(env.calls().length, 0);
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
  assert.deepEqual(babysitDynamicLoopHint("42", "gh-checks-watch").loopArm, expectedArm);
  const result = await runBabysit(fakePi([ready]), { pr: "#42", recipeId: "gh-checks-watch" });
  assert.deepEqual(result.details.loopArm, expectedArm);
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
  assert.deepEqual(included.details.loopArm, expectedArm);
  assert.match(included.content[0].text, /--- pstack_loop dynamic arm ---/);
  const omitted = await runBabysit(fakePi([ready]), {
    pr: "7",
    recipeId: "gh-view-json",
    armLoopHint: false,
  });
  assert.equal(omitted.details.loopArm, undefined);
  assert.equal(omitted.content[0].text, "PR READY");
});

test("babysit-12 builds the gh-checks-watch recipe as gh pr checks <pr> --watch", async () => {
  const env = fakePi([ready]);
  const result = await runBabysit(env, { pr: "#123", recipeId: "gh-checks-watch" });
  assert.deepEqual(argvLog(env), [["gh", ["pr", "checks", "123", "--watch"]]]);
  assert.equal(result.details.via, "gh-recipe");
  assert.deepEqual(result.details.watchArgv, ["gh", "pr", "checks", "123", "--watch"]);
});

test("babysit-13 builds the gh-view-json recipe as gh pr view <pr> --json <fields>", async () => {
  const env = fakePi([ready]);
  const result = await runBabysit(env, { pr: "123", recipeId: "gh-view-json" });
  assert.deepEqual(argvLog(env), [
    ["gh", ["pr", "view", "123", "--json", "state,mergeStateStatus,statusCheckRollup,reviewDecision"]],
  ]);
  assert.equal(result.details.via, "gh-recipe");
});

test("babysit-14 runs gh-checks-watch with a one-hour timeout and gh-view-json with 60s", async () => {
  const checks = fakePi([ready]);
  await runBabysit(checks, { pr: "1", recipeId: "gh-checks-watch" });
  assert.equal(checks.calls()[0]?.opts?.timeout, 3_600_000);
  const view = fakePi([ready]);
  await runBabysit(view, { pr: "1", recipeId: "gh-view-json" });
  assert.equal(view.calls()[0]?.opts?.timeout, 60_000);
});

test("babysit-15 falls back to one-shot gh pr view when the bundled watch-pr script is absent", async () => {
  assert.equal(existsSyncPatchVisible, true, "existsSync patch must be visible to index.ts");
  hideBundledWatchPr = true;
  try {
    const drive = fakePi([ready]);
    const driveResult = await runBabysit(drive, { pr: "55" });
    assert.deepEqual(argvLog(drive), [
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
    assert.equal(driveResult.details.via, "gh");
    assert.equal(driveResult.details.recipeId, "watch-pr-drive");
    const status = fakePi([ready]);
    const statusResult = await runBabysit(status, { pr: "55", statusOnly: true });
    assert.equal(statusResult.details.recipeId, "watch-pr-status");
    assert.deepEqual(argvLog(status), [
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
