import { expect, test } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSession } from "../../support/session.mjs";

const WATCH_SCRIPT = "skills/poteto-mode/scripts/watch-pr/watch-pr";

const GH_CLEAN =
  '{"number":7,"state":"OPEN","mergedAt":null,"mergeStateStatus":"CLEAN","title":"probe","statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}],"reviewDecision":"APPROVED","url":"https://example.test/pr/7"}';
const GH_DIRTY =
  '{"number":10,"state":"OPEN","mergedAt":null,"mergeStateStatus":"DIRTY","title":"dirty","statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}],"reviewDecision":"APPROVED","url":"https://example.test/pr/10"}';
const GH_MERGED =
  '{"number":11,"state":"MERGED","mergedAt":"2026-01-01T00:00:00Z","mergeStateStatus":"CLEAN","title":"merged","statusCheckRollup":[],"reviewDecision":"APPROVED","url":"https://example.test/pr/11"}';
const GH_BARE =
  '{"number":34,"state":"OPEN","mergedAt":null,"statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}],"reviewDecision":"APPROVED"}';
const GH_NO_NUMBER =
  '{"state":"OPEN","mergedAt":null,"mergeStateStatus":"CLEAN","title":"nonum","statusCheckRollup":[],"reviewDecision":"APPROVED"}';
const GH_BARE_MERGE =
  '{"number":23,"state":"OPEN","mergedAt":null,"title":"bare","statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}],"reviewDecision":"APPROVED","url":"https://example.test/pr/23"}';

const GH_VIEW_CASES = [
  `    7|20|21|24) echo '${GH_CLEAN}'; exit 0 ;;`,
  '    8) echo "no such pr" >&2; exit 1 ;;',
  '    35) echo "partial output"; exit 1 ;;',
  '    9) echo "not json"; exit 0 ;;',
  `    10) echo '${GH_DIRTY}'; exit 0 ;;`,
  `    11) echo '${GH_MERGED}'; exit 0 ;;`,
  "    22) exit 3 ;;",
  '    30) echo "raw view output"; exit 0 ;;',
  '    31) echo "boom" >&2; exit 1 ;;',
  "    32) exit 5 ;;",
  '    33) awk \'BEGIN{for(i=0;i<3000;i=i+1) print "view line " i}\'; exit 0 ;;',
  `    34) echo '${GH_BARE}'; exit 0 ;;`,
  `    36) echo '${GH_NO_NUMBER}'; exit 0 ;;`,
  `    23) echo '${GH_BARE_MERGE}'; exit 0 ;;`,
  '    *) echo "unknown pr $3" >&2; exit 1 ;;',
].join("\n");

const GH_STUB = [
  'if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; exit 0; fi',
  'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
  '  case "$3" in',
  GH_VIEW_CASES,
  "  esac",
  "fi",
  'if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then echo "checks stream"; exit 0; fi',
  'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
  '  case "$3" in',
  '    20) echo "merge exploded" >&2; exit 1 ;;',
  "    21) exit 6 ;;",
  "    23) exit 0 ;;",
  '    24) awk \'BEGIN{for(i=0;i<3000;i=i+1) print "merge line " i}\'; exit 0 ;;',
  '    *) echo "MERGE-FLAG=$4"; exit 0 ;;',
  "  esac",
  "fi",
  'echo "unexpected gh $@" >&2',
  "exit 3",
].join("\n");

const BUN_STUB = [
  'if [ "$1" = "--version" ]; then echo "1.1.0"; exit 0; fi',
  'case "$*" in',
  '  *"--pr 33"*) awk \'BEGIN{for(i=0;i<3000;i=i+1) print "watch line " i}\'; exit 0 ;;',
  '  *"--pr 34"*) echo "watcher failed" >&2; exit 1 ;;',
  '  *"--pr 35"*) exit 5 ;;',
  "esac",
  'if [ "$1" = "watch-fail" ]; then echo "watcher failed" >&2; exit 1; fi',
  'echo "watched args=$*"',
].join("\n");

function executor(f) {
  const ctx = f.session._extensionRunner.createContext();
  return (name, params) => f.tool(name).definition.execute(name, params, undefined, undefined, ctx);
}

function commandOf(f, name) {
  for (const ext of f.session.resourceLoader.getExtensions().extensions) {
    if (ext.commands?.has(name)) return ext.commands.get(name);
  }
  return undefined;
}

function text(reply) {
  return reply.content[0].text;
}

async function withEnv(vars, run) {
  const saved = Object.entries(vars).map(([key, value]) => [key, process.env[key]]);
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

function temporaryDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stubBinary(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function withStubPath(dir, run) {
  return withEnv({ PATH: `${dir}:${process.env.PATH}` }, run);
}

function initRepo(cwd) {
  const config = ["-c", "user.email=test@example.test", "-c", "user.name=Test"];
  execFileSync("git", ["init", "-q"], { cwd, stdio: "pipe" });
  execFileSync("git", [...config, "add", "-A"], { cwd, stdio: "pipe" });
  execFileSync("git", [...config, "commit", "-q", "-m", "base"], { cwd, stdio: "pipe" });
}

function dropFullOutput(reply) {
  if (reply.details.fullOutputPath) rmSync(reply.details.fullOutputPath, { force: true });
}

async function shipStackStatus(exec) {
  const view = await exec("pstack_ship", { action: "view", pr: "#7" });
  expect(view.details.code).toBe(0);
  expect(JSON.parse(text(view)).number).toBe(7);

  const advance = await exec("pstack_ship", { action: "stack-status", stackPrs: ["7"] });
  expect([advance.details.verdict, advance.details.frontier, advance.details.problems]).toEqual([
    "ADVANCE",
    "7",
    [],
  ]);
  expect(text(advance)).toBe("stack ADVANCE frontier=#7\n7 state=OPEN mergeStateStatus=CLEAN");

  const complete = await exec("pstack_ship", { action: "stack-status", stackPrs: ["11"] });
  expect([complete.details.verdict, complete.details.frontier]).toEqual(["COMPLETE", undefined]);
  expect(text(complete)).toBe("stack COMPLETE\n11 state=MERGED mergeStateStatus=CLEAN");

  const unknown = await exec("pstack_ship", { action: "stack-status", stackPrs: ["8"] });
  expect([unknown.details.verdict, unknown.details.frontier]).toEqual(["WAITING", "8"]);
  expect(text(unknown)).toBe(
    "stack WAITING frontier=#8\n8 state=UNKNOWN mergeStateStatus=?\nfrontier blockers: state=UNKNOWN",
  );

  const fromPr = await exec("pstack_ship", { action: "stack-status", pr: "7" });
  expect(fromPr.details.frontier).toBe("7");

  const invalidJson = await exec("pstack_ship", { action: "stack-status", stackPrs: ["9"] });
  expect([invalidJson.details.verdict, invalidJson.details.frontier]).toEqual(["WAITING", "9"]);

  const noNumber = await exec("pstack_ship", { action: "stack-status", stackPrs: ["36"] });
  expect(noNumber.details.frontier).toBe("36");
  expect(text(noNumber)).toContain("36 state=OPEN mergeStateStatus=CLEAN");

  const failedView = await exec("pstack_ship", { action: "view", pr: "31" });
  expect(failedView.details.code).toBe(1);
  expect(text(failedView)).toContain("boom");
}

async function shipGateChecks(exec) {
  const gate = await exec("pstack_ship", { action: "gate-check", pr: "#7" });
  expect(gate.details.gate.number).toBe(7);
  expect(text(gate)).toMatch(/^gate-check PASS\n/);

  await expect(() => exec("pstack_ship", { action: "gate-check", pr: "10" })).rejects.toThrow(
    new Error("merge gate check failed (fail closed): mergeStateStatus=DIRTY"),
  );
  await expect(() => exec("pstack_ship", { action: "gate-check", pr: "8" })).rejects.toThrow(
    /^merge gate check failed \(fail closed\): cannot view PR — no such pr\n$/,
  );
  await expect(() => exec("pstack_ship", { action: "gate-check", pr: "22" })).rejects.toThrow(
    new Error("merge gate check failed (fail closed): cannot view PR — exit 3"),
  );
  await expect(() => exec("pstack_ship", { action: "gate-check", pr: "9" })).rejects.toThrow(
    new Error("merge gate check failed (fail closed): invalid gh JSON"),
  );
}

async function shipMerges(exec) {
  const squash = await exec("pstack_ship", { action: "merge", pr: "7", mergeMethod: "squash" });
  expect(squash.details.code).toBe(0);
  expect(text(squash)).toContain("Merged PR 7 after gate check (mergeStateStatus=CLEAN).");
  expect(text(squash)).toContain("MERGE-FLAG=--squash");

  const merge = await exec("pstack_ship", { action: "merge", pr: "7", mergeMethod: "merge" });
  expect(text(merge)).toContain("MERGE-FLAG=--merge");

  const rebase = await exec("pstack_ship", { action: "merge", pr: "7", mergeMethod: "rebase" });
  expect(text(rebase)).toContain("MERGE-FLAG=--rebase");

  const fallback = await exec("pstack_ship", { action: "merge", pr: "7" });
  expect(text(fallback)).toContain("MERGE-FLAG=--squash");

  await expect(() => exec("pstack_ship", { action: "merge", pr: "20" })).rejects.toThrow(
    /^gh pr merge failed \(fail closed\): merge exploded\n$/,
  );
  await expect(() => exec("pstack_ship", { action: "merge", pr: "21" })).rejects.toThrow(
    new Error("gh pr merge failed (fail closed): exit 6"),
  );

  const bareGate = await exec("pstack_ship", { action: "merge", pr: "23" });
  expect(bareGate.details.gate.mergeStateStatus).toBeUndefined();
  expect(text(bareGate)).toContain("mergeStateStatus=n/a");

  const bigMerge = await exec("pstack_ship", { action: "merge", pr: "24" });
  expect(bigMerge.details.fullOutputPath).toBeTruthy();
  dropFullOutput(bigMerge);
}

async function shipRefusals(exec) {
  const cases = [
    [{ action: "view" }, "pr required"],
    [{ action: "gate-check" }, "pr required for gate-check"],
    [{ action: "merge" }, "pr required for merge"],
    [{ action: "stack-status" }, "stackPrs or pr required"],
    [{ action: "explode" }, "action must be view|merge|stack-status|gate-check"],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_ship", params)).rejects.toThrow(new Error(message));
  }
}

async function shipScenarios(exec) {
  await shipStackStatus(exec);
  await shipGateChecks(exec);
  await shipMerges(exec);
  await shipRefusals(exec);
}

async function babysitGhRecipes(exec) {
  const hinted = await exec("pstack_babysit", { pr: "#7", recipeId: "gh-view-json" });
  expect([hinted.details.via, hinted.details.recipeId]).toEqual(["gh-recipe", "gh-view-json"]);
  expect(hinted.details.code).toBe(0);
  expect(text(hinted)).toMatch(/pstack_loop dynamic arm/);
  expect(hinted.details.loopArm.mode).toBe("dynamic");

  const bare = await exec("pstack_babysit", { pr: "7", recipeId: "gh-view-json", armLoopHint: false });
  expect(bare.details.loopArm).toBeUndefined();
  expect(text(bare)).not.toMatch(/pstack_loop dynamic arm/);

  const checks = await exec("pstack_babysit", { pr: "7", recipeId: "gh-checks-watch" });
  expect([checks.details.via, checks.details.recipeId]).toEqual(["gh-recipe", "gh-checks-watch"]);
  expect(checks.details.watchArgv).toEqual(["gh", "pr", "checks", "7", "--watch"]);
  expect(text(checks)).toContain("checks stream");

  const stderr = await exec("pstack_babysit", { pr: "31", recipeId: "gh-view-json", armLoopHint: false });
  expect(stderr.details.code).toBe(1);
  expect(text(stderr)).toContain("boom");

  const exitOnly = await exec("pstack_babysit", { pr: "32", recipeId: "gh-view-json", armLoopHint: false });
  expect(text(exitOnly)).toContain("(exit 5)");

  const truncated = await exec("pstack_babysit", { pr: "33", recipeId: "gh-view-json", armLoopHint: false });
  expect(truncated.details.fullOutputPath).toBeTruthy();
  dropFullOutput(truncated);
}

async function babysitWatchRecipes(exec) {
  const status = await exec("pstack_babysit", { pr: "7", statusOnly: true, armLoopHint: false });
  expect([status.details.via, status.details.recipeId]).toEqual(["watch-pr", "watch-pr-status"]);
  expect(status.details.loopArm).toBeUndefined();
  expect(status.details.watchArgv).toEqual(["bun", WATCH_SCRIPT, "--pr", "7", "--status-only"]);
  expect(text(status)).toContain("watched args=");

  const drive = await exec("pstack_babysit", { pr: "7" });
  expect([drive.details.via, drive.details.recipeId]).toEqual(["watch-pr", "watch-pr-drive"]);
  expect(drive.details.loopArm.mode).toBe("dynamic");

  const stack = await exec("pstack_babysit", { pr: "7", recipeId: "watch-pr-stack", armLoopHint: false });
  expect(stack.details.watchArgv).toEqual(["bun", WATCH_SCRIPT, "--stack", "--pr", "7"]);

  const queued = await exec("pstack_babysit", {
    pr: "7",
    recipeId: "watch-pr-queued-stack",
    stackPrs: ["7", "8"],
    armLoopHint: false,
  });
  expect(queued.details.watchArgv).toEqual([
    "bun",
    WATCH_SCRIPT,
    "--queued-stack",
    "--stack-prs",
    "7,8",
  ]);

  const pretty = await exec("pstack_babysit", { pr: "7", pretty: true, armLoopHint: false });
  expect(pretty.details.recipeId).toBe("watch-pr-drive");
  expect(text(pretty)).toContain("--pretty");

  const watchedStderr = await exec("pstack_babysit", { pr: "34", statusOnly: true, armLoopHint: false });
  expect(watchedStderr.details.code).toBe(1);
  expect(text(watchedStderr)).toContain("watcher failed");

  const watchedExit = await exec("pstack_babysit", { pr: "35", statusOnly: true, armLoopHint: false });
  expect(text(watchedExit)).toContain("(exit 5)");

  const truncated = await exec("pstack_babysit", { pr: "33", statusOnly: true, armLoopHint: false });
  expect(truncated.details.fullOutputPath).toBeTruthy();
  dropFullOutput(truncated);
}

async function babysitRefusals(exec) {
  await expect(() => exec("pstack_babysit", { pr: "7", recipeId: "nope" })).rejects.toThrow(
    new Error(
      "unknown babysit recipeId 'nope'. Known: watch-pr-status, watch-pr-drive, watch-pr-stack, watch-pr-queued-stack, gh-checks-watch, gh-view-json",
    ),
  );
  await expect(() =>
    exec("pstack_babysit", { pr: "7", recipeId: "watch-pr-queued-stack" }),
  ).rejects.toThrow(
    new Error("recipeId=watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers)"),
  );
}

async function babysitScenarios(exec) {
  await babysitGhRecipes(exec);
  await babysitWatchRecipes(exec);
  await babysitRefusals(exec);
}

async function worktreeLifecycle(f, exec) {
  const empty = await exec("pstack_worktree", { action: "list" });
  expect(empty.details.count).toBe(0);

  const created = await exec("pstack_worktree", { action: "create", name: "probe", base: "HEAD" });
  expect(created.details).toEqual({
    path: join(f.tmp.cwd, ".pstack-worktrees", "probe"),
    branch: "pstack/probe",
  });
  expect(f.exists(join(".pstack-worktrees", "probe"))).toBe(true);

  const auto = await exec("pstack_worktree", { action: "create" });
  const autoSlug = auto.details.branch.replace("pstack/", "");
  expect(autoSlug).toMatch(/^pstack-\d+$/);
  expect(f.exists(join(".pstack-worktrees", autoSlug))).toBe(true);

  const listed = await exec("pstack_worktree", { action: "list" });
  expect(listed.details.count).toBe(2);
  expect(text(listed)).toMatch(/pstack-managed under \.pstack-worktrees: 2\/12$/);

  const pruned = await exec("pstack_worktree", { action: "prune" });
  expect(text(pruned)).toBe("pruned");

  const removed = await exec("pstack_worktree", { action: "remove", name: "probe" });
  expect(removed.details.path).toBe(join(f.tmp.cwd, ".pstack-worktrees", "probe"));
  expect(f.exists(join(".pstack-worktrees", "probe"))).toBe(false);

  const cleaned = await exec("pstack_worktree", { action: "cleanup" });
  expect([...cleaned.details.removed]).toEqual([autoSlug]);
  expect(cleaned.details.skipped).toEqual([]);
  expect(cleaned.details.pruned).toBe("pruned");
}

async function worktreeRefusals(exec) {
  const cases = [
    [{ action: "remove" }, /^name required for remove$/],
    [{ action: "create", name: "-flag" }, /^worktree name must not start with '-'$/],
    [{ action: "create", name: "ok", base: "-HEAD" }, /^base ref must not start with '-'$/],
    [{ action: "create", name: "ok", base: "two words" }, /^base ref must not contain '\.\.', whitespace, or NUL$/],
    [{ action: "explode" }, /^action must be create\|list\|remove\|prune\|cleanup$/],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_worktree", params)).rejects.toThrow(message);
  }
}

async function worktreeScenarios(f, exec) {
  await worktreeLifecycle(f, exec);
  await worktreeRefusals(exec);
}

async function gatesScenarios(f, ctx) {
  const command = commandOf(f, "pstack-gates");
  await command.handler("", ctx);
  expect(f.ui.notifications.at(-1)).toEqual([
    "error",
    "Usage: /pstack-gates <pr>. Also run /skill:unslop → /skill:no-comments → prove-it-works.",
  ]);

  await command.handler("8", ctx);
  expect(f.ui.notifications.at(-1)[0]).toBe("error");
  expect(f.ui.notifications.at(-1)[1]).toMatch(
    /^Gate check FAILED \(fail closed\): cannot view PR — no such pr\n$/,
  );

  await command.handler("35", ctx);
  expect(f.ui.notifications.at(-1)[0]).toBe("error");
  expect(f.ui.notifications.at(-1)[1]).toMatch(
    /^Gate check FAILED \(fail closed\): cannot view PR — partial output\n$/,
  );

  await command.handler("9", ctx);
  expect(f.ui.notifications.at(-1)).toEqual([
    "error",
    "Gate check FAILED (fail closed): invalid gh JSON",
  ]);

  await command.handler("10", ctx);
  expect(f.ui.notifications.at(-1)).toEqual([
    "error",
    "Gate check FAILED (fail closed): mergeStateStatus=DIRTY",
  ]);

  await command.handler("#7", ctx);
  expect(f.ui.notifications.at(-1)).toEqual(["info", "Gate check PASS for PR 7 (CLEAN)"]);

  await command.handler("34", ctx);
  expect(f.ui.notifications.at(-1)).toEqual(["info", "Gate check PASS for PR 34 (n/a)"]);
}

test("default entry drives ship, babysit, and worktree boundaries", async () => {
  const stubDir = temporaryDir("pstack-tool-default-");
  stubBinary(stubDir, "gh", GH_STUB);
  stubBinary(stubDir, "bun", BUN_STUB);
  try {
    await withStubPath(stubDir, () =>
      withSession(
        async (f) => {
          initRepo(f.tmp.cwd);
          const exec = executor(f);
          await shipScenarios(exec);
          await babysitScenarios(exec);
          await worktreeScenarios(f, exec);
          await f.session._extensionRunner.emit({ type: "session_shutdown" });
        },
        { initialFiles: { "app.ts": "export const one = 1;\n" } },
      ),
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("worktree list reports the raw git failure outside a repository", async () => {
  await withSession(async (f) => {
    const reply = await executor(f)("pstack_worktree", { action: "list" });
    expect(reply.details.code).not.toBe(0);
    expect(text(reply)).toContain("fatal: not a git repository");
    expect(text(reply)).toMatch(/pstack-managed under \.pstack-worktrees: 0\/12$/);
  });
});

test("extension factories drive ship, babysit, worktree, and gates boundaries", async () => {
  const { registerShipping } = await import("../../../extensions/shipping/index.ts");
  const { registerWorktree } = await import("../../../extensions/worktree/index.ts");
  const { registerGates } = await import("../../../extensions/gates/index.ts");
  const factories = [(pi) => registerShipping(pi), (pi) => registerWorktree(pi), (pi) => registerGates(pi)];
  const stubDir = temporaryDir("pstack-tool-factories-");
  stubBinary(stubDir, "gh", GH_STUB);
  stubBinary(stubDir, "bun", BUN_STUB);
  try {
    await withStubPath(stubDir, () =>
      withSession(
        async (f) => {
          initRepo(f.tmp.cwd);
          const exec = executor(f);
          await shipScenarios(exec);
          await babysitScenarios(exec);
          await worktreeScenarios(f, exec);
          await gatesScenarios(f, f.session._extensionRunner.createContext());
        },
        { extensionPaths: [], extensionFactories: factories, initialFiles: { "app.ts": "export const one = 1;\n" } },
      ),
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});
