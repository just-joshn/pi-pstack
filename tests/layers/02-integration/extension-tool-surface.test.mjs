import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(
    text(armed),
    "r1 phase=WAIT_FOR_EVENT_OR_HEARTBEAT iterations=0 discards=0 fires=0/50 predicate=green build\nrun r1 predicate defined: green build",
  );
  assert.deepEqual(armed.details.effects, [{ type: "notify", message: "run r1 predicate defined: green build" }]);
  const second = await exec("pstack_run", {
    action: "arm",
    runId: "r2",
    predicate: "ship it",
    intervalSeconds: 5,
    maxFires: 3,
    plateauLimit: 2,
    remoteRequired: true,
  });
  assert.equal(second.details.run.maxFires, 3);
  assert.deepEqual(second.details.run.remote, { required: true, handedOff: false });
  const explicit = await exec("pstack_run", { action: "state", runId: "r1" });
  assert.equal(explicit.details.run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
  assert.deepEqual(explicit.details.effects, []);
  assert.equal((await exec("pstack_run", { action: "state" })).details.run.runId, "r2");
  const listed = await exec("pstack_run", { action: "list" });
  assert.equal(listed.details.count, 2);
  assert.equal(listed.details.runs.map((record) => record.runId).join(","), "r1,r2");
}

async function runMidActions(exec) {
  const iterated = await exec("pstack_run", { action: "iterate", runId: "r1", step: "npm test" });
  assert.equal(iterated.details.run.iterations.length, 0);
  assert.deepEqual(iterated.details.effects, []);
  const verified = await exec("pstack_run", {
    action: "verify",
    runId: "r1",
    evidence: "suite green",
    verification: "node --test",
  });
  assert.equal(verified.details.run.iterations.length, 0);
  const checkpointed = await exec("pstack_run", { action: "checkpoint", runId: "r1" });
  assert.equal(checkpointed.details.run.phase, "WAIT_FOR_EVENT_OR_HEARTBEAT");
  const discarded = await exec("pstack_run", { action: "discard", runId: "r1", reason: "no gain" });
  assert.equal(discarded.details.run.consecutiveDiscards, 0);
  const inconclusive = await exec("pstack_run", { action: "inconclusive", runId: "r1" });
  assert.deepEqual(inconclusive.details.effects, []);
}

async function runTerminalActions(exec, ui) {
  const blocked = await exec("pstack_run", { action: "blocked", runId: "r1", reason: "upstream outage" });
  assert.equal(
    text(blocked),
    "r1 phase=BLOCKED iterations=0 discards=0 fires=0/50 predicate=green build\nblockedReason: upstream outage\nrun r1 BLOCKED: upstream outage",
  );
  assert.deepEqual(ui.notifications.at(-1), ["info", "run r1 BLOCKED: upstream outage"]);
  const handoff = await exec("pstack_run", { action: "handoff", runId: "r2", endpoint: "https://worker.example.test" });
  assert.equal(handoff.details.run.phase, "BLOCKED");
  assert.deepEqual(handoff.details.run.remote, {
    required: true,
    handedOff: true,
    endpoint: "https://worker.example.test",
  });
  assert.deepEqual(ui.notifications.slice(-2), [
    ["info", "run r2 hosted handoff recorded for https://worker.example.test; no local continuation"],
    ["info", "run r2 handed off to https://worker.example.test; BLOCKED locally until the hosted worker exists"],
  ]);
  assert.equal(text(await exec("pstack_run", { action: "stop", runId: "r1" })), "no armed loop for r1");
  assert.deepEqual((await exec("pstack_run", { action: "stop", runId: "r2" })).details, { runId: "r2", stopped: true });
  assert.equal((await exec("pstack_run", { action: "stop", runId: "r99" })).details.stopped, false);
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
    await assert.rejects(() => exec("pstack_run", params), new Error(message));
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
        assert.equal(record.phase, "BLOCKED");
        assert.equal(
          record.blockedReason,
          "local runtime session ended without completion; hand off to a hosted worker or re-arm",
        );
      }),
    );
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

async function loopToolScenarios(exec, ui) {
  const empty = await exec("pstack_loop", { action: "status" });
  assert.equal(text(empty), "(no active loops)");
  assert.deepEqual(empty.details, { loops: [], action: "status" });
  assert.deepEqual((await exec("pstack_loop", { action: "list" })).details, { loops: [], action: "list" });
  const armed = await exec("pstack_loop", { action: "arm", prompt: "check the build", intervalSeconds: 5 });
  assert.equal(text(armed), "Armed loop-1 mode=interval intervalSeconds=5 maxFires=50 coalesceMs=2500");
  assert.deepEqual(armed.details, { id: "loop-1", mode: "interval", coalesceMs: 2500 });
  assert.deepEqual(ui.statuses.at(-1), ["pstack-loop", "loop-1"]);
  const status = await exec("pstack_loop", { action: "status" });
  assert.equal(text(status), "loop-1 mode=interval fires=0/50 armed=true lastReason=-");
  assert.deepEqual(status.details.loops, ["loop-1"]);
  const watcher = await exec("pstack_loop", {
    action: "arm",
    id: "watch",
    prompt: "watch the queue",
    mode: "watcher",
    intervalSeconds: 5,
    watchArgv: ["git", "status", "--short"],
  });
  assert.equal(text(watcher), "Armed watch mode=watcher intervalSeconds=5 maxFires=50 watcher=on coalesceMs=2500");
  assert.deepEqual((await exec("pstack_loop", { action: "stop", id: "watch" })).details, {});
  assert.equal(text(await exec("pstack_loop", { action: "stop" })), "stopped");
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
    await assert.rejects(() => exec("pstack_loop", params), new Error(message));
  }
}

async function loopCommandScenarios(f, ui) {
  const command = commandOf(f, "pstack-loop");
  const ctx = f.session._extensionRunner.createContext();
  await command.handler("status", ctx);
  assert.deepEqual(ui.notifications.at(-1), ["info", "(no active loops)"]);
  await command.handler("5 probe every five", ctx);
  assert.deepEqual(ui.notifications.at(-1), ["info", "Armed loop-5 every 5s"]);
  await command.handler("list", ctx);
  assert.deepEqual(ui.notifications.at(-1), ["info", "loop-5 mode=interval fires=0/100 armed=true lastReason=-"]);
  await command.handler("stop loop-99", ctx);
  assert.deepEqual(ui.notifications.at(-1), ["info", "No loop loop-99"]);
  await command.handler("nonsense", ctx);
  assert.deepEqual(ui.notifications.at(-1), [
    "error",
    "Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop status|list  |  /pstack-loop stop [id]  |  /pstack-loop off",
  ]);
  await command.handler("off", ctx);
  assert.deepEqual(ui.notifications.at(-1), ["info", "All pstack loops stopped."]);
  await command.handler("", ctx);
  assert.deepEqual(ui.statuses.at(-1), ["pstack-loop", undefined]);
  await commandOf(f, "deslop").handler("", ctx);
  assert.deepEqual(ui.notifications.at(-1), ["info", "Queued deslop twin"]);
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
  assert.equal(empty.details.count, 0);
  assert.match(text(empty), /pstack-managed under \.pstack-worktrees: 0\/12$/);
  const created = await exec("pstack_worktree", { action: "create", name: "probe", base: "HEAD" });
  assert.deepEqual(created.details, { path: join(f.tmp.cwd, ".pstack-worktrees", "probe"), branch: "pstack/probe" });
  assert.equal((await exec("pstack_worktree", { action: "list" })).details.count, 1);
  await exec("pstack_worktree", { action: "create", name: "probe2" });
  const cleaned = await exec("pstack_worktree", { action: "cleanup" });
  assert.deepEqual([...cleaned.details.removed].toSorted(), ["probe", "probe2"]);
  assert.deepEqual(cleaned.details.skipped, []);
  assert.equal(cleaned.details.pruned, "pruned");
  assert.equal(cleaned.details.removed.length, 2);
  assert.equal(f.exists(join(".pstack-worktrees", "probe")), false);
  assert.equal(text(await exec("pstack_worktree", { action: "prune" })), "pruned");
  await exec("pstack_worktree", { action: "create", name: "probe3" });
  const removed = await exec("pstack_worktree", { action: "remove", name: "probe3" });
  assert.equal(removed.details.path, join(f.tmp.cwd, ".pstack-worktrees", "probe3"));
  assert.equal(f.exists(join(".pstack-worktrees", "probe3")), false);
}

async function worktreeRefusals(f, exec) {
  const cases = [
    [{ action: "remove" }, /^Error: name required for remove$/],
    [{ action: "create", name: "../evil" }, /^WorktreeSanitizeError: worktree name must not contain '\.\.', path separators, or NUL$/],
    [{ action: "create", name: "-flag" }, /^WorktreeSanitizeError: worktree name must not start with '-'$/],
    [{ action: "create", name: "ok", base: "-HEAD" }, /^WorktreeSanitizeError: base ref must not start with '-'$/],
    [{ action: "create", name: "ok", base: "main branch" }, /^WorktreeSanitizeError: base ref must not contain '\.\.', whitespace, or NUL$/],
    [{ action: "explode" }, /^Error: action must be create\|list\|remove\|prune\|cleanup$/],
  ];
  for (const [params, message] of cases) {
    await assert.rejects(() => exec("pstack_worktree", params), message);
  }
  await exec("pstack_worktree", { action: "create", name: "probe4" });
  await f.session._extensionRunner.emit({ type: "session_shutdown" });
  assert.equal(f.exists(join(".pstack-worktrees", "probe4")), false);
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
  assert.equal(listed.details.available, 2);
  assert.equal(listed.details.total, 9);
  assert.match(text(listed), /^pstack_integrations list: 2\/9 categories available$/m);
  assert.equal(
    listed.details.categories.map((category) => category.id).join(","),
    "source-control,issue-tracker,long-form-docs,team-chat,observability,error-tracking,analytics,browser-ui,cli-tui",
  );
  const source = listed.details.categories.find((category) => category.id === "source-control");
  assert.equal(source.missing, "cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)");
  assert.equal(listed.details.categories.find((category) => category.id === "browser-ui").availability, "available");
  assert.equal(listed.details.categories.find((category) => category.id === "cli-tui").tool, "pstack_control_cli");
  assert.equal((await exec("pstack_integrations", { action: "status" })).details.action, "status");
  assert.equal((await exec("pstack_integrations", { action: "probe" })).details.action, "probe");
}

async function integrationGaps(exec, configPath) {
  await assert.rejects(
    () => exec("pstack_integrations", { action: "explode" }),
    new Error("action must be one of list, status, probe, query"),
  );
  await assert.rejects(
    () => exec("pstack_integrations", { action: "query", capability: "nope" }),
    new Error("capability must be one of source-control, issue-tracker, long-form-docs, team-chat, observability, error-tracking, analytics, browser-ui, cli-tui"),
  );
  const gap = await exec("pstack_integrations", { action: "query", capability: "source-control" });
  assert.deepEqual(gap.details, {
    capability: "source-control",
    availability: "unavailable",
    coverageGap: true,
    substituted: false,
    missing: "cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)",
  });
  assert.equal(
    text(gap),
    "pstack_integrations coverage gap: capability 'source-control' is unavailable.\nmissing prerequisite: cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)\nno other capability was queried in its place; report this as a null finding in /why, not a skip.",
  );
  const chat = await exec("pstack_integrations", { action: "query", capability: "team-chat" });
  assert.equal(chat.details.missing, `add a 'command' adapter for capability 'team-chat' to ${configPath}`);
  const ui = await exec("pstack_integrations", { action: "query", capability: "browser-ui" });
  assert.deepEqual(ui.details, {
    capability: "browser-ui",
    delegatedTo: "pstack_control_ui",
    executed: false,
    coverageGap: false,
  });
  assert.equal(
    (await exec("pstack_integrations", { action: "query", capability: "cli-tui" })).details.delegatedTo,
    "pstack_control_cli",
  );
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
  assert.equal(adapted.details.plan, "repo root");
  assert.equal(adapted.details.code, 0);
  assert.match(text(adapted), /^analytics repo root: exit 0\n\n/);
  const withRepo = await exec("pstack_integrations", { action: "list" });
  assert.equal(withRepo.details.available, 4);
  assert.equal(withRepo.details.categories.find((category) => category.id === "source-control").availability, "available");
  const log = await exec("pstack_integrations", { action: "query", capability: "source-control" });
  assert.equal(log.details.plan, "log (git)");
  assert.match(text(log), /^source-control log \(git\): exit 0\n\n/);
  const blame = await exec("pstack_integrations", {
    action: "query",
    capability: "source-control",
    query: "blame:app.ts:1",
  });
  assert.equal(blame.details.plan, "blame (git)");
  assert.match(text(blame), /filename app\.ts\n\texport const one = 1;/);
  const prs = await exec("pstack_integrations", {
    action: "query",
    capability: "source-control",
    query: "prs:anything",
  });
  assert.equal(prs.details.plan, "prs (gh)");
  assert.equal(prs.details.code, 0);
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
  assert.match(current.details.file, /\.jsonl$/);
  assert.equal(text(current), `current session: ${current.details.file}`);
  const listed = await exec("pstack_sessions", { action: "list" });
  assert.equal(listed.details.files.length, 1);
  assert.equal(listed.details.files[0].path, seeded);
  const hit = await exec("pstack_sessions", { action: "grep", query: "needle" });
  assert.equal(hit.details.hitCount, 1);
  assert.equal(text(hit), `${seeded}\n  {"type":"message","text":"needle in the corpus"}`);
  assert.equal(text(await exec("pstack_sessions", { action: "grep", query: "absent" })), "(no hits for absent)");
  await assert.rejects(
    () => exec("pstack_sessions", { action: "grep" }),
    new Error("query required for grep"),
  );
  await assert.rejects(
    () => exec("pstack_sessions", { action: "explode" }),
    new Error("action must be list|grep|current|recall"),
  );
  const recall = await exec("pstack_sessions", { action: "recall", query: "needle", days: 30 });
  assert.equal(recall.details.sessionHits, 1);
  assert.equal(recall.details.rankedHits, 1);
  assert.deepEqual(recall.details.corpus, ["sessions", "git-log", "gh-prs", "ranked-merge"]);
  assert.match(text(recall), /^## Recall corpus \(local, ranked\)\nquery=needle days=30\n/);
  assert.match(text(recall), /### gh PRs\n\(no matching PRs\)/);
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
  assert.equal(view.details.code, 0);
  assert.equal(JSON.parse(text(view)).number, 7);
  const stack = await exec("pstack_ship", { action: "stack-status", stackPrs: ["7"] });
  assert.deepEqual([stack.details.verdict, stack.details.frontier, stack.details.problems], ["ADVANCE", "7", []]);
  assert.equal(text(stack), "stack ADVANCE frontier=#7\n7 state=OPEN mergeStateStatus=CLEAN");
  const gate = await exec("pstack_ship", { action: "gate-check", pr: "7" });
  assert.equal(gate.details.gate.number, 7);
  assert.match(text(gate), /^gate-check PASS\n/);
  const merged = await exec("pstack_ship", { action: "merge", pr: "7", mergeMethod: "squash" });
  assert.equal(merged.details.code, 0);
  assert.match(text(merged), /^Merged PR 7 after gate check \(mergeStateStatus=CLEAN\)\.\nmerged 7/);
  await assert.rejects(
    () => exec("pstack_ship", { action: "merge", pr: "8" }),
    /^Error: merge gate check failed \(fail closed\): cannot view PR/,
  );
  const cases = [
    [{ action: "view" }, "pr required"],
    [{ action: "stack-status" }, "stackPrs or pr required"],
    [{ action: "explode" }, "action must be view|merge|stack-status|gate-check"],
  ];
  for (const [params, message] of cases) {
    await assert.rejects(() => exec("pstack_ship", params), new Error(message));
  }
}

async function babysitScenarios(exec) {
  const recipe = await exec("pstack_babysit", { pr: "7", recipeId: "gh-view-json", armLoopHint: false });
  assert.deepEqual([recipe.details.via, recipe.details.recipeId], ["gh-recipe", "gh-view-json"]);
  assert.deepEqual(recipe.details.watchArgv, [
    "gh",
    "pr",
    "view",
    "7",
    "--json",
    "state,mergeStateStatus,statusCheckRollup,reviewDecision",
  ]);
  const watched = await exec("pstack_babysit", { pr: "7", statusOnly: true, armLoopHint: false });
  assert.deepEqual([watched.details.via, watched.details.recipeId], ["watch-pr", "watch-pr-status"]);
  assert.equal(text(watched), "watched the pr\n");
  const hinted = await exec("pstack_babysit", { pr: "7", statusOnly: true });
  assert.match(text(hinted), /pstack_loop dynamic arm \(default babysit recipe watch-pr-status\)/);
  await assert.rejects(
    () => exec("pstack_babysit", { pr: "7", recipeId: "nope" }),
    new Error("unknown babysit recipeId 'nope'. Known: watch-pr-status, watch-pr-drive, watch-pr-stack, watch-pr-queued-stack, gh-checks-watch, gh-view-json"),
  );
  await assert.rejects(
    () => exec("pstack_babysit", { pr: "7", recipeId: "watch-pr-queued-stack" }),
    new Error("recipeId=watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers)"),
  );
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
  assert.deepEqual(found.details.findings, [
    { label: "narration / alibi comment", severity: "high", count: 1, samples: ["app.ts: // Phase 1: add cards"], suggestion: "delete-line", safeDelete: true },
  ]);
  assert.deepEqual(found.details.suggestions, [
    { file: "app.ts", line: "// Phase 1: add cards", label: "narration / alibi comment", severity: "high", action: "delete-line", safeDelete: true },
  ]);
  assert.match(text(found), /Added lines scanned: 2\.$/);
  const dry = await exec("pstack_deslop", { dryRun: true });
  assert.deepEqual(dry.details.apply, { applied: 0, files: ["app.ts"], dryRun: true });
  assert.match(text(dry), /dryRun: would remove 1 safeDelete line\(s\) across 1 file\(s\) \(no writes\)$/);
}

async function deslopApplies(f, exec) {
  const applied = await exec("pstack_deslop", { applySafe: true });
  assert.deepEqual(applied.details.apply, { applied: 1, files: ["app.ts"] });
  assert.equal(f.read("app.ts"), "export const one = 1;\nexport const two = 2;\n");
  f.write("app.ts", "export const one = 1;\n// Phase 1: add cards\nexport const two = 2;\n");
  const auto = await exec("pstack_deslop", { autoApply: true });
  assert.deepEqual(auto.details.apply, { applied: 1, files: ["app.ts"] });
  assert.deepEqual(f.ui.dialogs.at(-1), {
    method: "confirm",
    title: "pstack_deslop autoApply",
    message: "Delete 1 safe slop line(s)?",
  });
  const clean = await exec("pstack_deslop", {});
  assert.deepEqual(clean.details.findings, []);
  assert.equal(
    text(clean),
    "pstack_deslop: no common slop patterns in added lines (still run /skill:unslop on prose surfaces).",
  );
}

async function deslopRefusals(exec) {
  const cases = [
    [{ base: "-main" }, "invalid git diff base"],
    [{ base: "main..other" }, "invalid git diff base"],
    [{ base: "two words" }, "invalid git diff base"],
    [{ paths: ["-x"] }, "invalid path: -x"],
  ];
  for (const [params, message] of cases) {
    await assert.rejects(() => exec("pstack_deslop", params), new Error(message));
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
  assert.equal(text(logged), `Logged decision to ${join(f.tmp.cwd, ".pi", "decisions.tsv")}`);
  assert.deepEqual(logged.details, {
    path: join(f.tmp.cwd, ".pi", "decisions.tsv"),
    decision: "cover the loader",
    phase: "probe",
  });
  assert.match(
    f.read(join(".pi", "decisions.tsv")),
    /^ts\tphase\tdecision\twhy\tevidence\tresult\n\S+\tprobe\tcover the loader\t/,
  );
  const audit = await exec("pstack_decision_log", {
    path: "@.pi/audit/wave.tsv",
    phase: "probe",
    decision: "audit row",
    why: "exercise the at-prefix strip",
  });
  assert.equal(audit.details.path, join(f.tmp.cwd, ".pi", "audit", "wave.tsv"));
  await assert.rejects(
    () => exec("pstack_decision_log", { phase: "p", decision: "d", why: "w", path: "../escape.tsv" }),
    /pstack_decision_log path must stay under/,
  );
  await assert.rejects(
    () => exec("pstack_decision_log", { phase: "p", decision: "d", why: "w", path: ".pi" }),
    /pstack_decision_log path must stay under/,
  );
}

async function jobsScenarios(exec) {
  const jobs = await exec("pstack_jobs", { action: "list" });
  assert.equal(text(jobs), "concurrency 0/8 waiting=0\n(no background jobs)");
  assert.deepEqual(jobs.details.concurrency, { active: 0, cap: 8, waiting: 0 });
  assert.deepEqual(jobs.details.jobs, []);
  const cases = [
    [{ action: "status" }, "id required for status|await"],
    [{ action: "abort" }, "id required for abort"],
    [{ action: "status", id: "ghost" }, "unknown job: ghost"],
    [{ action: "cancel", id: "ghost" }, "unknown job: ghost"],
    [{ action: "await", id: "ghost", timeoutMs: 1000 }, "unknown background job: ghost"],
  ];
  for (const [params, message] of cases) {
    await assert.rejects(() => exec("pstack_jobs", params), new Error(message));
  }
}

async function controlCliScenarios(exec) {
  const cli = await exec("pstack_control_cli", { argv: ["git", "--version"] });
  assert.equal(cli.details.code, 0);
  assert.match(text(cli), /^exit 0\n\ngit version /);
  const cwdProbe = await exec("pstack_control_cli", { argv: ["git", "rev-parse", "--is-inside-work-tree"] });
  assert.equal(cwdProbe.details.code, 128);
  await assert.rejects(
    () => exec("pstack_control_cli", { argv: ["rm", "-rf", "/tmp"] }),
    new Error("command 'rm' not in control_cli allowlist (npm, pnpm, yarn, bun, node, python, python3, go, cargo, make, pytest, git, gh, pi, tsx, npx)"),
  );
  await assert.rejects(
    () => exec("pstack_control_cli", { argv: ["/tmp/git", "status"] }),
    /^Error: command path '\/tmp\/git' is not in a trusted binary directory/,
  );
  await withEnv({ PSTACK_CONTROL_CLI_INTERPRETERS: "0" }, async () => {
    await assert.rejects(
      () => exec("pstack_control_cli", { argv: ["python3", "-c", "print(1)"] }),
      new Error("interpreter 'python3' requires an explicit allowInterpreters opt-in"),
    );
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
  assert.equal(text(ok), "HTTP 200 ok=true\n\nprobe body");
  assert.deepEqual(ok.details, { status: 200, ok: true });
  const redirected = await exec("pstack_control_ui", { url: `${origin}/redirect`, allowHosts });
  assert.deepEqual(redirected.details, { status: 200, ok: true });
  const mismatched = await exec("pstack_control_ui", { url: `${origin}/ok`, expectStatus: 204, allowHosts });
  assert.deepEqual(mismatched.details, { status: 200, ok: false });
  await assert.rejects(
    () => exec("pstack_control_ui", { url: `${origin}/ok` }),
    /^Error: pstack_control_ui refused http:\/\/127\.0\.0\.1:\d+\/ok: host '127\.0\.0\.1' is a private, loopback, or link-local target$/,
  );
  await assert.rejects(
    () => exec("pstack_control_ui", { url: "http://169.254.169.254/latest" }),
    new Error("pstack_control_ui refused http://169.254.169.254/latest: host '169.254.169.254' is a metadata or local-only host"),
  );
  await assert.rejects(
    () => exec("pstack_control_ui", { url: "file:///etc/passwd" }),
    new Error("pstack_control_ui refused file:///etc/passwd: scheme 'file:' is not http or https"),
  );
}

async function bennyScenarios(f, exec) {
  await withEnv({ HOME: f.tmp.home }, async () => {
    const wakeFile = join(f.tmp.home, ".pi", "agent", "pstack-benny-wakes.jsonl");
    const wakePath = await exec("pstack_benny_wake", { action: "path" });
    assert.equal(text(wakePath), wakeFile);
    assert.deepEqual(wakePath.details, { path: wakeFile });
    await assert.rejects(
      () => exec("pstack_benny_wake", { action: "append" }),
      new Error("pstack_benny_wake append requires a non-empty payload JSON string"),
    );
    const appended = await exec("pstack_benny_wake", {
      action: "append",
      payload: '{"issue":42}',
      intent: "repro",
    });
    assert.deepEqual(appended.details, { ok: true, path: wakeFile });
    const drained = await exec("pstack_benny_wake", { action: "drain" });
    assert.equal(drained.details.count, 1);
    assert.match(text(drained), /^Drained 1 wake\(s\):\n\{"ts":".+","intent":"repro","payload":\{"issue":42\}\}$/);
    const empty = await exec("pstack_benny_wake", { action: "drain" });
    assert.equal(text(empty), "No pending Benny wakes.");
    assert.equal(empty.details.count, 0);
  });
}

async function spawnRefusals(exec) {
  await withEnv({ PSTACK_HOSTED_URL: "" }, async () => {
    await assert.rejects(
      () => exec("pstack_spawn", { task: "probe", model: "gpt-4o" }),
      /^Error: Refused bare model slug 'gpt-4o'\. Pass provider\/id /,
    );
    await assert.rejects(
      () => exec("pstack_spawn", { task: "probe", cwd: "../escape" }),
      /^Error: pstack_spawn cwd escapes the workspace root: /,
    );
    await assert.rejects(
      () => exec("pstack_task", { prompt: "probe", model: "gpt-4o" }),
      /^Error: Refused bare model slug 'gpt-4o'\./,
    );
    await assert.rejects(
      () => exec("pstack_task", { prompt: "probe", model: "inherit-parent", environment: "hosted" }),
      /^Error: pstack_task environment=hosted requires PSTACK_HOSTED_URL/,
    );
  });
  await assert.rejects(
    () => exec("pstack_arena", { prompt: "probe", candidates: [{ label: "a" }] }),
    /^Error: git worktree add failed: /,
  );
  await assert.rejects(
    () => exec("pstack_swarm", { workers: [{ task: "probe" }] }),
    /^Error: git worktree add failed: /,
  );
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
