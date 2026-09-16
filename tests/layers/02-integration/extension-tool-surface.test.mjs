import { expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withSession } from "../../support/session.mjs";

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
    for (const [key, value] of saved) process.env[key] = value === undefined ? "" : value;
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

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(cwd) {
  git(cwd, "init", "-q");
  git(cwd, "-c", "user.email=test@example.test", "-c", "user.name=Test", "add", "-A");
  git(cwd, "-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-q", "-m", "base");
}

function withStubPath(dir, run) {
  return withEnv({ PATH: `${dir}:${process.env.PATH}` }, run);
}

const GH_VERSION_OK = 'if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; exit 0; fi';

const GH_EMPTY_LIST = [
  GH_VERSION_OK,
  'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
  'echo "unexpected gh $@" >&2',
  "exit 3",
].join("\n");

const GH_SHIP_OK = [
  'if [ "$1" = "search" ] && [ "$2" = "prs" ]; then echo "[]"; exit 0; fi',
  'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
  '  if [ "$3" = "7" ]; then',
  '    echo \'{"number":7,"state":"OPEN","mergedAt":null,"mergeStateStatus":"CLEAN","title":"probe","statusCheckRollup":[{"name":"ci","conclusion":"SUCCESS"}],"reviewDecision":"APPROVED","url":"https://example.test/pr/7"}\'',
  "    exit 0",
  "  fi",
  '  echo "cannot view pr $3" >&2',
  "  exit 1",
  "fi",
  'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then echo "merged $3"; exit 0; fi',
  GH_VERSION_OK,
  'echo "unexpected gh $@" >&2',
  "exit 3",
].join("\n");

async function runArmAndState(exec) {
  const armed = await exec("pstack_run", { action: "arm", runId: "r1", predicate: "green build", intervalSeconds: 5 });
  expect(text(armed)).toBe("r1 phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/50 predicate=green build\nrun r1 predicate defined: green build");
  expect(armed.details.effects).toEqual([{ type: "notify", message: "run r1 predicate defined: green build" }]);
  const second = await exec("pstack_run", {
    action: "arm",
    runId: "r2",
    predicate: "ship it",
    intervalSeconds: 5,
    maxFires: 3,
    plateauLimit: 2,
    remoteRequired: true,
  });
  expect(second.details.run.maxFires).toBe(3);
  expect(second.details.run.remote).toEqual({ required: true, handedOff: false });
  const explicit = await exec("pstack_run", { action: "state", runId: "r1" });
  expect(explicit.details.run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
  expect(explicit.details.effects).toEqual([]);
  expect((await exec("pstack_run", { action: "state" })).details.run.runId).toBe("r2");
  const listed = await exec("pstack_run", { action: "list" });
  expect(listed.details.count).toBe(2);
  expect(listed.details.runs.map((record) => record.runId).join(",")).toBe("r1,r2");
}

async function runMidActions(exec) {
  const iterated = await exec("pstack_run", { action: "iterate", runId: "r1", step: "npm test" });
  expect(iterated.details.run.iterations.length).toBe(0);
  expect(iterated.details.effects).toEqual([]);
  const verified = await exec("pstack_run", {
    action: "verify",
    runId: "r1",
    evidence: "suite green",
    verification: "vitest run",
  });
  expect(verified.details.run.iterations.length).toBe(0);
  const checkpointed = await exec("pstack_run", { action: "checkpoint", runId: "r1" });
  expect(checkpointed.details.run.phase).toBe("WAIT_FOR_EVENT_OR_HEARTBEAT");
  const discarded = await exec("pstack_run", { action: "discard", runId: "r1", reason: "no gain" });
  expect(discarded.details.run.consecutiveDiscards).toBe(0);
  const inconclusive = await exec("pstack_run", { action: "inconclusive", runId: "r1" });
  expect(inconclusive.details.effects).toEqual([]);
}

async function runTerminalActions(exec, ui) {
  const blocked = await exec("pstack_run", { action: "blocked", runId: "r1", reason: "upstream outage" });
  expect(text(blocked)).toBe("r1 phase=BLOCKED iterations=0 discards=0 fires=0/50 predicate=green build\nblockedReason: upstream outage\nrun r1 BLOCKED: upstream outage");
  expect(ui.notifications.at(-1)).toEqual(["info", "run r1 BLOCKED: upstream outage"]);
  const handoff = await exec("pstack_run", { action: "handoff", runId: "r2", endpoint: "https://worker.example.test" });
  expect(handoff.details.run.phase).toBe("BLOCKED");
  expect(handoff.details.run.remote).toEqual({
    required: true,
    handedOff: true,
    endpoint: "https://worker.example.test",
  });
  expect(ui.notifications.slice(-2)).toEqual([
    ["info", "run r2 hosted handoff recorded for https://worker.example.test; no local continuation"],
    ["info", "run r2 handed off to https://worker.example.test; BLOCKED locally until the hosted worker exists"],
  ]);
  expect(text(await exec("pstack_run", { action: "stop", runId: "r1" }))).toBe("no armed loop for r1");
  expect((await exec("pstack_run", { action: "stop", runId: "r2" })).details).toEqual({ runId: "r2", stopped: true });
  expect((await exec("pstack_run", { action: "stop", runId: "r99" })).details.stopped).toBe(false);
}

async function runRefusals(exec) {
  const cases = [
    [{ action: "explode" }, "action must be arm|state|iterate|verify|discard|inconclusive|checkpoint|blocked|handoff|stop|list"],
    [{ action: "state", runId: "ghost" }, "unknown run ghost"],
    [{ action: "arm" }, "predicate required to arm a run"],
    [{ action: "arm", predicate: "p" }, "intervalSeconds required to arm a run"],
    [{ action: "verify", runId: "r1" }, "evidence required to verify an iteration"],
    [{ action: "blocked", runId: "r1" }, "reason required to mark a run blocked"],
    [{ action: "handoff", runId: "r1" }, "endpoint required for a hosted handoff"],
    [{ action: "stop" }, "runId required for this action"],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_run", params)).rejects.toThrow(new Error(message));
  }
}

test("pstack_run drives every run-controller action and pins each refusal", async () => {
  const runsDir = temporaryDir("pstack-runs-");
  try {
    await withEnv({ PSTACK_RUNS_DIR: runsDir }, () =>
      withSession(async (f) => {
        const exec = executor(f);
        await runArmAndState(exec);
        await runMidActions(exec);
        await runTerminalActions(exec, f.ui);
        await runRefusals(exec);
        await exec("pstack_run", { action: "arm", runId: "r4", predicate: "ship it", intervalSeconds: 5 });
        await f.session._extensionRunner.emit({ type: "session_shutdown" });
        const record = JSON.parse(readFileSync(join(runsDir, "r4.json"), "utf8"));
        expect(record.phase).toBe("BLOCKED");
        expect(record.blockedReason).toBe("local runtime session ended without completion; hand off to a hosted worker or re-arm");
      }),
    );
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

async function loopToolScenarios(exec, ui) {
  const empty = await exec("pstack_loop", { action: "status" });
  expect(text(empty)).toBe("(no active loops)");
  expect(empty.details).toEqual({ loops: [], action: "status" });
  expect((await exec("pstack_loop", { action: "list" })).details).toEqual({ loops: [], action: "list" });
  const armed = await exec("pstack_loop", { action: "arm", prompt: "check the build", intervalSeconds: 5 });
  expect(text(armed)).toBe("Armed loop-1 mode=interval intervalSeconds=5 maxFires=50 coalesceMs=2500");
  expect(armed.details).toEqual({ id: "loop-1", mode: "interval", coalesceMs: 2500 });
  expect(ui.statuses.at(-1)).toEqual(["pstack-loop", "loop-1"]);
  const status = await exec("pstack_loop", { action: "status" });
  expect(text(status)).toBe("loop-1 mode=interval fires=0/50 armed=true lastReason=-");
  expect(status.details.loops).toEqual(["loop-1"]);
  const watcher = await exec("pstack_loop", {
    action: "arm",
    id: "watch",
    prompt: "watch the queue",
    mode: "watcher",
    intervalSeconds: 5,
    watchArgv: ["git", "status", "--short"],
  });
  expect(text(watcher)).toBe("Armed watch mode=watcher intervalSeconds=5 maxFires=50 watcher=on coalesceMs=2500");
  expect((await exec("pstack_loop", { action: "stop", id: "watch" })).details).toEqual({});
  expect(text(await exec("pstack_loop", { action: "stop" }))).toBe("stopped");
}

async function loopToolRefusals(exec) {
  const cases = [
    [{ action: "explode" }, "action must be arm|stop|status|list"],
    [{ action: "arm" }, "prompt required to arm"],
    [{ action: "arm", prompt: "x", watchCommand: "bash -lc true" }, "watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array"],
    [{ action: "arm", prompt: "x", mode: "watcher" }, "watchArgv required for mode=watcher"],
    [{ action: "arm", prompt: "x", mode: "nope" }, "mode must be interval|settle|watcher|dynamic"],
    [{ action: "arm", prompt: "x", mode: "watcher", watchArgv: ["-bad"] }, "watchArgv[0] must be a command path/name (not an option)"],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_loop", params)).rejects.toThrow(new Error(message));
  }
}

async function loopCommandScenarios(f, ui) {
  const command = commandOf(f, "pstack-loop");
  const ctx = f.session._extensionRunner.createContext();
  await command.handler("status", ctx);
  expect(ui.notifications.at(-1)).toEqual(["info", "(no active loops)"]);
  await command.handler("5 probe every five", ctx);
  expect(ui.notifications.at(-1)).toEqual(["info", "Armed loop-5 every 5s"]);
  await command.handler("list", ctx);
  expect(ui.notifications.at(-1)).toEqual(["info", "loop-5 mode=interval fires=0/100 armed=true lastReason=-"]);
  await command.handler("stop loop-99", ctx);
  expect(ui.notifications.at(-1)).toEqual(["info", "No loop loop-99"]);
  await command.handler("nonsense", ctx);
  expect(ui.notifications.at(-1)).toEqual([
    "error",
    "Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop status|list  |  /pstack-loop stop [id]  |  /pstack-loop off",
  ]);
  await command.handler("off", ctx);
  expect(ui.notifications.at(-1)).toEqual(["info", "All pstack loops stopped."]);
  await command.handler("", ctx);
  expect(ui.statuses.at(-1)).toEqual(["pstack-loop", undefined]);
  await commandOf(f, "deslop").handler("", ctx);
  expect(ui.notifications.at(-1)).toEqual(["info", "Queued deslop twin"]);
}

test("pstack_loop arms, reports, stops, and answers its slash command", async () => {
  await withSession(async (f) => {
    const exec = executor(f);
    await loopToolScenarios(exec, f.ui);
    await loopToolRefusals(exec);
    await loopCommandScenarios(f, f.ui);
  });
});

async function worktreeLifecycle(f, exec) {
  const empty = await exec("pstack_worktree", { action: "list" });
  expect(empty.details.count).toBe(0);
  expect(text(empty)).toMatch(/pstack-managed under \.pstack-worktrees: 0\/12$/);
  const created = await exec("pstack_worktree", { action: "create", name: "probe", base: "HEAD" });
  expect(created.details).toEqual({ path: join(f.tmp.cwd, ".pstack-worktrees", "probe"), branch: "pstack/probe" });
  expect((await exec("pstack_worktree", { action: "list" })).details.count).toBe(1);
  await exec("pstack_worktree", { action: "create", name: "probe2" });
  const cleaned = await exec("pstack_worktree", { action: "cleanup" });
  expect([...cleaned.details.removed].toSorted()).toEqual(["probe", "probe2"]);
  expect(cleaned.details.skipped).toEqual([]);
  expect(cleaned.details.pruned).toBe("pruned");
  expect(cleaned.details.removed.length).toBe(2);
  expect(f.exists(join(".pstack-worktrees", "probe"))).toBe(false);
  expect(text(await exec("pstack_worktree", { action: "prune" }))).toBe("pruned");
  await exec("pstack_worktree", { action: "create", name: "probe3" });
  const removed = await exec("pstack_worktree", { action: "remove", name: "probe3" });
  expect(removed.details.path).toBe(join(f.tmp.cwd, ".pstack-worktrees", "probe3"));
  expect(f.exists(join(".pstack-worktrees", "probe3"))).toBe(false);
}

async function worktreeRefusals(f, exec) {
  const cases = [
    [{ action: "remove" }, /^name required for remove$/],
    [{ action: "create", name: "../evil" }, /^worktree name must not contain '\.\.', path separators, or NUL$/],
    [{ action: "create", name: "-flag" }, /^worktree name must not start with '-'$/],
    [{ action: "create", name: "ok", base: "-HEAD" }, /^base ref must not start with '-'$/],
    [{ action: "create", name: "ok", base: "main branch" }, /^base ref must not contain '\.\.', whitespace, or NUL$/],
    [{ action: "explode" }, /^action must be create\|list\|remove\|prune\|cleanup$/],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_worktree", params)).rejects.toThrow(message);
  }
  await exec("pstack_worktree", { action: "create", name: "probe4" });
  await f.session._extensionRunner.emit({ type: "session_shutdown" });
  expect(f.exists(join(".pstack-worktrees", "probe4"))).toBe(false);
}

test("pstack_worktree manages real git worktrees and refuses injection", async () => {
  await withSession(
    async (f) => {
      initRepo(f.tmp.cwd);
      const exec = executor(f);
      await worktreeLifecycle(f, exec);
      await worktreeRefusals(f, exec);
    },
    { initialFiles: { "app.ts": "export const one = 1;\n" } },
  );
});

async function integrationInventory(exec) {
  const listed = await exec("pstack_integrations", { action: "list" });
  expect(listed.details.available).toBe(2);
  expect(listed.details.total).toBe(9);
  expect(text(listed)).toMatch(/^pstack_integrations list: 2\/9 categories available$/m);
  expect(listed.details.categories.map((category) => category.id).join(",")).toBe("source-control,issue-tracker,long-form-docs,team-chat,observability,error-tracking,analytics,browser-ui,cli-tui");
  const source = listed.details.categories.find((category) => category.id === "source-control");
  expect(source.missing).toBe("cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)");
  expect(listed.details.categories.find((category) => category.id === "browser-ui").availability).toBe("available");
  expect(listed.details.categories.find((category) => category.id === "cli-tui").tool).toBe("pstack_control_cli");
  expect((await exec("pstack_integrations", { action: "status" })).details.action).toBe("status");
  expect((await exec("pstack_integrations", { action: "probe" })).details.action).toBe("probe");
}

async function integrationGaps(exec, configPath) {
  await expect(() => exec("pstack_integrations", { action: "explode" })).rejects.toThrow(new Error("action must be one of list, status, probe, query"));
  await expect(() => exec("pstack_integrations", { action: "query", capability: "nope" })).rejects.toThrow(new Error("capability must be one of source-control, issue-tracker, long-form-docs, team-chat, observability, error-tracking, analytics, browser-ui, cli-tui"));
  const gap = await exec("pstack_integrations", { action: "query", capability: "source-control" });
  expect(gap.details).toEqual({
    capability: "source-control",
    availability: "unavailable",
    coverageGap: true,
    substituted: false,
    missing: "cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)",
  });
  expect(text(gap)).toBe("pstack_integrations coverage gap: capability 'source-control' is unavailable.\nmissing prerequisite: cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)\nno other capability was queried in its place; report this as a null finding in /why, not a skip.");
  const chat = await exec("pstack_integrations", { action: "query", capability: "team-chat" });
  expect(chat.details.missing).toBe(`add a 'command' adapter for capability 'team-chat' to ${configPath}`);
  const ui = await exec("pstack_integrations", { action: "query", capability: "browser-ui" });
  expect(ui.details).toEqual({
    capability: "browser-ui",
    delegatedTo: "pstack_control_ui",
    executed: false,
    coverageGap: false,
  });
  expect((await exec("pstack_integrations", { action: "query", capability: "cli-tui" })).details.delegatedTo).toBe("pstack_control_cli");
}

async function integrationQueries(f, exec, configPath) {
  initRepo(f.tmp.cwd);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      analytics: {
        adapter: "command",
        command: ["git", "rev-parse", "--show-toplevel"],
        description: "repo root",
      },
    }),
  );
  const adapted = await exec("pstack_integrations", { action: "query", capability: "analytics" });
  expect(adapted.details.plan).toBe("repo root");
  expect(adapted.details.code).toBe(0);
  expect(text(adapted)).toMatch(/^analytics repo root: exit 0\n\n/);
  const withRepo = await exec("pstack_integrations", { action: "list" });
  expect(withRepo.details.available).toBe(4);
  expect(withRepo.details.categories.find((category) => category.id === "source-control").availability).toBe("available");
  const log = await exec("pstack_integrations", { action: "query", capability: "source-control" });
  expect(log.details.plan).toBe("log (git)");
  expect(text(log)).toMatch(/^source-control log \(git\): exit 0\n\n/);
  const blame = await exec("pstack_integrations", {
    action: "query",
    capability: "source-control",
    query: "blame:app.ts:1",
  });
  expect(blame.details.plan).toBe("blame (git)");
  expect(text(blame)).toMatch(/filename app\.ts\n\texport const one = 1;/);
  const prs = await exec("pstack_integrations", {
    action: "query",
    capability: "source-control",
    query: "prs:anything",
  });
  expect(prs.details.plan).toBe("prs (gh)");
  expect(prs.details.code).toBe(0);
}

test("pstack_integrations reports the capability matrix, gaps, and adapter queries", async () => {
  const stubDir = temporaryDir("pstack-integrations-bin-");
  const configDir = temporaryDir("pstack-integrations-config-");
  stubBinary(stubDir, "gh", GH_SHIP_OK);
  try {
    await withStubPath(stubDir, () =>
      withEnv({ PSTACK_INTEGRATIONS_DIR: configDir }, () =>
        withSession(
          async (f) => {
            const exec = executor(f);
            const configPath = join(configDir, "integrations.json");
            await integrationInventory(exec);
            await integrationGaps(exec, configPath);
            await integrationQueries(f, exec, configPath);
          },
          { initialFiles: { "app.ts": "export const one = 1;\n" } },
        ),
      ),
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

async function sessionsScenarios(exec, seeded) {
  const current = await exec("pstack_sessions", { action: "current" });
  expect(current.details.file).toMatch(/\.jsonl$/);
  expect(text(current)).toBe(`current session: ${current.details.file}`);
  const listed = await exec("pstack_sessions", { action: "list" });
  expect(listed.details.files.length).toBe(1);
  expect(listed.details.files[0].path).toBe(seeded);
  const hit = await exec("pstack_sessions", { action: "grep", query: "needle" });
  expect(hit.details.hitCount).toBe(1);
  expect(text(hit)).toBe(`${seeded}\n  {"type":"message","text":"needle in the corpus"}`);
  expect(text(await exec("pstack_sessions", { action: "grep", query: "absent" }))).toBe("(no hits for absent)");
  await expect(() => exec("pstack_sessions", { action: "grep" })).rejects.toThrow(new Error("query required for grep"));
  await expect(() => exec("pstack_sessions", { action: "explode" })).rejects.toThrow(new Error("action must be list|grep|current|recall"));
  const recall = await exec("pstack_sessions", { action: "recall", query: "needle", days: 30 });
  expect(recall.details.sessionHits).toBe(1);
  expect(recall.details.rankedHits).toBe(1);
  expect(recall.details.corpus).toEqual(["sessions", "git-log", "gh-prs", "ranked-merge"]);
  expect(text(recall)).toMatch(/^## Recall corpus \(local, ranked\)\nquery=needle days=30\n/);
  expect(text(recall)).toMatch(/### gh PRs\n\(no matching PRs\)/);
}

test("pstack_sessions lists, greps, and ranks a seeded session corpus", async () => {
  const stubDir = temporaryDir("pstack-sessions-bin-");
  const sessionDir = temporaryDir("pstack-sessions-corpus-");
  stubBinary(stubDir, "gh", GH_EMPTY_LIST);
  writeFileSync(join(sessionDir, "seeded.jsonl"), '{"type":"message","text":"needle in the corpus"}\n');
  try {
    await withStubPath(stubDir, () =>
      withEnv({ PI_SESSION_DIR: sessionDir, HOME: join(sessionDir, "home") }, () =>
        withSession(async (f) => {
          await sessionsScenarios(executor(f), join(sessionDir, "seeded.jsonl"));
        }),
      ),
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

async function shipScenarios(exec) {
  const view = await exec("pstack_ship", { action: "view", pr: "#7" });
  expect(view.details.code).toBe(0);
  expect(JSON.parse(text(view)).number).toBe(7);
  const stack = await exec("pstack_ship", { action: "stack-status", stackPrs: ["7"] });
  expect([stack.details.verdict, stack.details.frontier, stack.details.problems]).toEqual(["ADVANCE", "7", []]);
  expect(text(stack)).toBe("stack ADVANCE frontier=#7\n7 state=OPEN mergeStateStatus=CLEAN");
  const gate = await exec("pstack_ship", { action: "gate-check", pr: "7" });
  expect(gate.details.gate.number).toBe(7);
  expect(text(gate)).toMatch(/^gate-check PASS\n/);
  const merged = await exec("pstack_ship", { action: "merge", pr: "7", mergeMethod: "squash" });
  expect(merged.details.code).toBe(0);
  expect(text(merged)).toMatch(/^Merged PR 7 after gate check \(mergeStateStatus=CLEAN\)\.\nmerged 7/);
  await expect(() => exec("pstack_ship", { action: "merge", pr: "8" })).rejects.toThrow(/^merge gate check failed \(fail closed\): cannot view PR/);
  const cases = [
    [{ action: "view" }, "pr required"],
    [{ action: "stack-status" }, "stackPrs or pr required"],
    [{ action: "explode" }, "action must be view|merge|stack-status|gate-check"],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_ship", params)).rejects.toThrow(new Error(message));
  }
}

async function babysitScenarios(exec) {
  const recipe = await exec("pstack_babysit", { pr: "7", recipeId: "gh-view-json", armLoopHint: false });
  expect([recipe.details.via, recipe.details.recipeId]).toEqual(["gh-recipe", "gh-view-json"]);
  expect(recipe.details.watchArgv).toEqual([
    "gh",
    "pr",
    "view",
    "7",
    "--json",
    "state,mergeStateStatus,statusCheckRollup,reviewDecision",
  ]);
  const watched = await exec("pstack_babysit", { pr: "7", statusOnly: true, armLoopHint: false });
  expect([watched.details.via, watched.details.recipeId]).toEqual(["watch-pr", "watch-pr-status"]);
  expect(text(watched)).toBe("watched the pr\n");
  const hinted = await exec("pstack_babysit", { pr: "7", statusOnly: true });
  expect(text(hinted)).toMatch(/pstack_loop dynamic arm \(default babysit recipe watch-pr-status\)/);
  await expect(() => exec("pstack_babysit", { pr: "7", recipeId: "nope" })).rejects.toThrow(new Error("unknown babysit recipeId 'nope'. Known: watch-pr-status, watch-pr-drive, watch-pr-stack, watch-pr-queued-stack, gh-checks-watch, gh-view-json"));
  await expect(() => exec("pstack_babysit", { pr: "7", recipeId: "watch-pr-queued-stack" })).rejects.toThrow(new Error("recipeId=watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers)"));
}

test("pstack_ship and pstack_babysit drive gh and watch-pr behind stub binaries", async () => {
  const stubDir = temporaryDir("pstack-ship-bin-");
  stubBinary(stubDir, "gh", GH_SHIP_OK);
  stubBinary(stubDir, "bun", 'if [ "$1" = "--version" ]; then echo "1.1.0"; exit 0; fi\necho "watched the pr"');
  try {
    await withStubPath(stubDir, () =>
      withSession(async (f) => {
        const exec = executor(f);
        await shipScenarios(exec);
        await babysitScenarios(exec);
      }),
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

async function deslopFindings(exec) {
  const found = await exec("pstack_deslop", {});
  expect(found.details.findings).toEqual([
    { label: "narration / alibi comment", severity: "high", count: 1, samples: ["app.ts: // Phase 1: add cards"], suggestion: "delete-line", safeDelete: true },
  ]);
  expect(found.details.suggestions).toEqual([
    { file: "app.ts", line: "// Phase 1: add cards", label: "narration / alibi comment", severity: "high", action: "delete-line", safeDelete: true },
  ]);
  expect(text(found)).toMatch(/Added lines scanned: 2\.$/);
  const dry = await exec("pstack_deslop", { dryRun: true });
  expect(dry.details.apply).toEqual({ applied: 0, files: ["app.ts"], dryRun: true });
  expect(text(dry)).toMatch(/dryRun: would remove 1 safeDelete line\(s\) across 1 file\(s\) \(no writes\)$/);
}

async function deslopApplies(f, exec) {
  const applied = await exec("pstack_deslop", { applySafe: true });
  expect(applied.details.apply).toEqual({ applied: 1, files: ["app.ts"] });
  expect(f.read("app.ts")).toBe("export const one = 1;\nexport const two = 2;\n");
  f.write("app.ts", "export const one = 1;\n// Phase 1: add cards\nexport const two = 2;\n");
  const auto = await exec("pstack_deslop", { autoApply: true });
  expect(auto.details.apply).toEqual({ applied: 1, files: ["app.ts"] });
  expect(f.ui.dialogs.at(-1)).toEqual({
    method: "confirm",
    title: "pstack_deslop autoApply",
    message: "Delete 1 safe slop line(s)?",
  });
  const clean = await exec("pstack_deslop", {});
  expect(clean.details.findings).toEqual([]);
  expect(text(clean)).toBe("pstack_deslop: no common slop patterns in added lines (still run /skill:unslop on prose surfaces).");
}

async function deslopRefusals(exec) {
  const cases = [
    [{ base: "-main" }, "invalid git diff base"],
    [{ base: "main..other" }, "invalid git diff base"],
    [{ base: "two words" }, "invalid git diff base"],
    [{ paths: ["-x"] }, "invalid path: -x"],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_deslop", params)).rejects.toThrow(new Error(message));
  }
}

test("pstack_deslop reports, dry-runs, and deletes safe slop lines in a diff", async () => {
  await withSession(
    async (f) => {
      initRepo(f.tmp.cwd);
      f.write("app.ts", "export const one = 1;\n// Phase 1: add cards\nexport const two = 2;\n");
      const exec = executor(f);
      await deslopFindings(exec);
      await deslopApplies(f, exec);
      await deslopRefusals(exec);
    },
    { initialFiles: { "app.ts": "export const one = 1;\n" } },
  );
});

async function decisionLogScenarios(f, exec) {
  const logged = await exec("pstack_decision_log", {
    phase: "probe",
    decision: "cover the loader",
    why: "transpiled functions need a loader-driven call",
    evidence: "tests/layers/02-integration",
    result: "green",
  });
  expect(text(logged)).toBe(`Logged decision to ${join(f.tmp.cwd, ".pi", "decisions.tsv")}`);
  expect(logged.details).toEqual({
    path: join(f.tmp.cwd, ".pi", "decisions.tsv"),
    decision: "cover the loader",
    phase: "probe",
  });
  expect(f.read(join(".pi", "decisions.tsv"))).toMatch(/^ts\tphase\tdecision\twhy\tevidence\tresult\n\S+\tprobe\tcover the loader\t/);
  const audit = await exec("pstack_decision_log", {
    path: "@.pi/audit/wave.tsv",
    phase: "probe",
    decision: "audit row",
    why: "exercise the at-prefix strip",
  });
  expect(audit.details.path).toBe(join(f.tmp.cwd, ".pi", "audit", "wave.tsv"));
  await expect(() => exec("pstack_decision_log", { phase: "p", decision: "d", why: "w", path: "../escape.tsv" })).rejects.toThrow(/pstack_decision_log path must stay under/);
  await expect(() => exec("pstack_decision_log", { phase: "p", decision: "d", why: "w", path: ".pi" })).rejects.toThrow(/pstack_decision_log path must stay under/);
}

async function jobsScenarios(exec) {
  const jobs = await exec("pstack_jobs", { action: "list" });
  expect(text(jobs)).toBe("concurrency 0/8 waiting=0\n(no background jobs)");
  expect(jobs.details.concurrency).toEqual({ active: 0, cap: 8, waiting: 0 });
  expect(jobs.details.jobs).toEqual([]);
  const cases = [
    [{ action: "status" }, "id required for status|await"],
    [{ action: "abort" }, "id required for abort"],
    [{ action: "status", id: "ghost" }, "unknown job: ghost"],
    [{ action: "cancel", id: "ghost" }, "unknown job: ghost"],
    [{ action: "await", id: "ghost", timeoutMs: 1000 }, "unknown background job: ghost"],
  ];
  for (const [params, message] of cases) {
    await expect(() => exec("pstack_jobs", params)).rejects.toThrow(new Error(message));
  }
}

async function controlCliScenarios(exec) {
  const cli = await exec("pstack_control_cli", { argv: ["git", "--version"] });
  expect(cli.details.code).toBe(0);
  expect(text(cli)).toMatch(/^exit 0\n\ngit version /);
  const cwdProbe = await exec("pstack_control_cli", { argv: ["git", "rev-parse", "--is-inside-work-tree"] });
  expect(cwdProbe.details.code).toBe(128);
  await expect(() => exec("pstack_control_cli", { argv: ["rm", "-rf", "/tmp"] })).rejects.toThrow(new Error("command 'rm' not in control_cli allowlist (npm, pnpm, yarn, bun, node, python, python3, go, cargo, make, pytest, git, gh, pi, tsx, npx)"));
  await expect(() => exec("pstack_control_cli", { argv: ["/tmp/git", "status"] })).rejects.toThrow(/^command path '\/tmp\/git' is not in a trusted binary directory/);
  await withEnv({ PSTACK_CONTROL_CLI_INTERPRETERS: "0" }, async () => {
    await expect(() => exec("pstack_control_cli", { argv: ["python3", "-c", "print(1)"] })).rejects.toThrow(new Error("interpreter 'python3' requires an explicit allowInterpreters opt-in"));
  });
}

test("pstack_decision_log, pstack_jobs, and pstack_control_cli cover their boundaries", async () => {
  await withSession(async (f) => {
    const exec = executor(f);
    await decisionLogScenarios(f, exec);
    await jobsScenarios(exec);
    await controlCliScenarios(exec);
  });
});

async function controlUiScenarios(exec, origin) {
  const allowHosts = ["127.0.0.1"];
  const ok = await exec("pstack_control_ui", { url: `${origin}/ok`, allowHosts });
  expect(text(ok)).toBe("HTTP 200 ok=true\n\nprobe body");
  expect(ok.details).toEqual({ status: 200, ok: true });
  const redirected = await exec("pstack_control_ui", { url: `${origin}/redirect`, allowHosts });
  expect(redirected.details).toEqual({ status: 200, ok: true });
  const mismatched = await exec("pstack_control_ui", { url: `${origin}/ok`, expectStatus: 204, allowHosts });
  expect(mismatched.details).toEqual({ status: 200, ok: false });
  await expect(() => exec("pstack_control_ui", { url: `${origin}/ok` })).rejects.toThrow(/^pstack_control_ui refused http:\/\/127\.0\.0\.1:\d+\/ok: host '127\.0\.0\.1' is a private, loopback, or link-local target$/);
  await expect(() => exec("pstack_control_ui", { url: "http://169.254.169.254/latest" })).rejects.toThrow(new Error("pstack_control_ui refused http://169.254.169.254/latest: host '169.254.169.254' is a metadata or local-only host"));
  await expect(() => exec("pstack_control_ui", { url: "file:///etc/passwd" })).rejects.toThrow(new Error("pstack_control_ui refused file:///etc/passwd: scheme 'file:' is not http or https"));
}

async function bennyScenarios(f, exec) {
  await withEnv({ HOME: f.tmp.home }, async () => {
    const wakeFile = join(f.tmp.home, ".pi", "agent", "pstack-benny-wakes.jsonl");
    const wakePath = await exec("pstack_benny_wake", { action: "path" });
    expect(text(wakePath)).toBe(wakeFile);
    expect(wakePath.details).toEqual({ path: wakeFile });
    await expect(() => exec("pstack_benny_wake", { action: "append" })).rejects.toThrow(new Error("pstack_benny_wake append requires a non-empty payload JSON string"));
    const appended = await exec("pstack_benny_wake", {
      action: "append",
      payload: '{"issue":42}',
      intent: "repro",
    });
    expect(appended.details).toEqual({ ok: true, path: wakeFile });
    const drained = await exec("pstack_benny_wake", { action: "drain" });
    expect(drained.details.count).toBe(1);
    expect(text(drained)).toMatch(/^Drained 1 wake\(s\):\n\{"ts":".+","intent":"repro","payload":\{"issue":42\}\}$/);
    const empty = await exec("pstack_benny_wake", { action: "drain" });
    expect(text(empty)).toBe("No pending Benny wakes.");
    expect(empty.details.count).toBe(0);
  });
}

async function spawnRefusals(exec) {
  await withEnv({ PSTACK_HOSTED_URL: "" }, async () => {
    await expect(() => exec("pstack_spawn", { task: "probe", model: "gpt-4o" })).rejects.toThrow(/^Refused bare model slug 'gpt-4o'\. Pass provider\/id /);
    await expect(() => exec("pstack_spawn", { task: "probe", cwd: "../escape" })).rejects.toThrow(/^pstack_spawn cwd escapes the workspace root: /);
    await expect(() => exec("pstack_task", { prompt: "probe", model: "gpt-4o" })).rejects.toThrow(/^Refused bare model slug 'gpt-4o'\./);
    await expect(() => exec("pstack_task", { prompt: "probe", model: "inherit-parent", environment: "hosted" })).rejects.toThrow(/^pstack_task environment=hosted requires PSTACK_HOSTED_URL/);
  });
  await expect(() => exec("pstack_arena", { prompt: "probe", candidates: [{ label: "a" }] })).rejects.toThrow(/^git worktree add failed: /);
  await expect(() => exec("pstack_swarm", { workers: [{ task: "probe" }] })).rejects.toThrow(/^git worktree add failed: /);
}

test("pstack_control_ui, pstack_benny_wake, and the spawn family refuse or stay offline", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/final" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("probe body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await withSession(async (f) => {
      const exec = executor(f);
      await controlUiScenarios(exec, origin);
      await bennyScenarios(f, exec);
      await spawnRefusals(exec);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
