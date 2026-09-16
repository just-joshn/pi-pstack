import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_CHILD_SOURCE } from "../../support/pi-host.mjs";

const PARENT_MODEL = "acceptance/parent";
const PARENT_TOOLS = "read,write,edit,bash,grep,find,ls";
const READONLY_TOOLS = "read,grep,find,ls";
const SPAWN_TASK = "Investigate X and report PASS/ISSUES/BLOCKED";
const ARENA_PROMPT = "Solve the shared design problem";
const SWARM_TASKS = [
  "Cover package pi-ai; report PASS/ISSUES/BLOCKED",
  "Cover package pi-agent-core; report PASS/ISSUES/BLOCKED",
  "Cover package pi-coding-agent; report PASS/ISSUES/BLOCKED",
];
const WATCH_COMMAND_ERROR =
  "watchCommand is rejected (no bash -lc of model strings); pass watchArgv as an argv array";
const WATCH_PR_SCRIPT_REL = "skills/poteto-mode/scripts/watch-pr/watch-pr";
const WATCH_PR_SCRIPT_ABS = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", WATCH_PR_SCRIPT_REL);
const WATCH_OUTPUT = "watch-pr: PR 42 checks pending";
const GH_OUTPUT = "checks pending";

const RICH_CHILD_SOURCE = STUB_CHILD_SOURCE.replace(
  '"stub-child prompt=" + (argv.at(-1) ?? ""),',
  [
    '"stub-child prompt=" + (argv.at(-1) ?? ""),',
    '"stub-child argv=" + JSON.stringify(argv.slice(2)),',
  ].join("\n"),
);

/** The child reports process.cwd(), which resolves the macOS /var symlink; the facade path does not. */
function childCwd(user) {
  return realpathSync(user.path(""));
}

/** Sleeps until killed so a background job stays running for an abort. */
const HANGING_CHILD_SOURCE = ["setInterval(() => {}, 1000);", ""].join("\n");

function backgroundJobId(text) {
  const match = /^Background job (bg-\S+) started /.exec(text);
  assert.ok(match, `unexpected background start: ${text}`);
  return match[1];
}

async function abortAndCancel(user) {
  user.stubChild(HANGING_CHILD_SOURCE);
  const running = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: true });
  const runningId = backgroundJobId(running.content[0].text);
  const first = await user.tool("pstack_jobs", { action: "abort", id: runningId });
  assert.equal(first.content[0].text, `abort requested; job ${runningId} status=aborted`);
  const awaited = await user.tool("pstack_jobs", { action: "await", id: runningId, timeoutMs: 5000 });
  assert.equal(awaited.details.job.status, "aborted");
  const rows = await user.tool("pstack_jobs", { action: "list" });
  assert.ok(rows.content[0].text.includes(`${runningId} status=aborted`), rows.content[0].text);

  const second = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: true });
  const secondId = backgroundJobId(second.content[0].text);
  const cancelled = await user.tool("pstack_jobs", { action: "cancel", id: secondId });
  assert.equal(cancelled.content[0].text, `abort requested; job ${secondId} status=aborted`);
  const settled = await user.tool("pstack_jobs", { action: "await", id: secondId, timeoutMs: 5000 });
  assert.equal(settled.details.job.status, "aborted");
}

function expectedChildBody(user, tools, task) {
  return [
    `stub-child cwd=${childCwd(user)}`,
    `stub-child model=${PARENT_MODEL}`,
    `stub-child tools=${tools}`,
    `stub-child prompt=${task}`,
    "PASS",
  ].join("\n");
}

function spawnHeadDir(head, model = PARENT_MODEL) {
  const prefix = `### pstack_spawn (general, ${model}, exit 0, sessionDir=`;
  assert.ok(head.startsWith(prefix), `unexpected spawn head: ${head}`);
  assert.ok(head.endsWith(")"), `spawn head has no closing paren: ${head}`);
  return head.slice(prefix.length, -1);
}

function assertSessionDir(user, dir) {
  assert.ok(dir.startsWith(user.path(".pi/pstack-child-sessions/c-")), `unexpected child session dir: ${dir}`);
}

async function syncSpawn(user) {
  const plain = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: false });
  const [plainHead, plainBody] = plain.content[0].text.split("\n\n");
  const plainDir = spawnHeadDir(plainHead);
  assertSessionDir(user, plainDir);
  assert.equal(plain.details.sessionDir, plainDir);
  assert.equal(plain.details.readonly, false);
  assert.equal(plainBody, expectedChildBody(user, PARENT_TOOLS, SPAWN_TASK));

  const readonly = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: false, readonly: true });
  const [readonlyHead, readonlyBody] = readonly.content[0].text.split("\n\n");
  assertSessionDir(user, spawnHeadDir(readonlyHead));
  assert.equal(readonly.details.readonly, true);
  assert.equal(readonlyBody, expectedChildBody(user, READONLY_TOOLS, SPAWN_TASK));

  const isolated = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: false, inheritParentTools: false });
  const [isolatedHead, isolatedBody] = isolated.content[0].text.split("\n\n");
  assertSessionDir(user, spawnHeadDir(isolatedHead));
  assert.equal(isolatedBody, expectedChildBody(user, "none", SPAWN_TASK));
}

async function backgroundJob(user) {
  const spawned = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: true });
  const started = spawned.content[0].text;
  const match = /^Background job (bg-1-[a-z0-9]+) started \(role=general, model=acceptance\/parent sessionDir=/.exec(started);
  assert.ok(match, `unexpected background start: ${started}`);
  const jobId = match[1];
  assert.ok(started.includes(`Poll with pstack_jobs action=status|await id=${jobId}.`), started);
  assert.ok(started.endsWith("Concurrency 1/8 (waiting 0). Jobs remain queryable for this session."), started);
  assert.equal(spawned.details.jobId, jobId);
  assert.equal(spawned.details.background, true);
  assert.equal(spawned.details.status, "queued");

  const list = await user.tool("pstack_jobs", { action: "list" });
  assert.ok(list.content[0].text.startsWith("concurrency "), list.content[0].text);
  assert.ok(list.content[0].text.includes(`${jobId} status=`), list.content[0].text);
  assert.ok(list.content[0].text.includes("role=general model=acceptance/parent"), list.content[0].text);
  assert.equal(list.details.jobs.some((job) => job.id === jobId), true);

  const awaited = await user.tool("pstack_jobs", { action: "await", id: jobId });
  const awaitedText = awaited.content[0].text;
  assert.ok(awaitedText.startsWith(`### pstack_jobs await (${jobId}, status=done, sessionDir=`), awaitedText);
  assert.equal(awaitedText.slice(awaitedText.indexOf("\n\n") + 2), expectedChildBody(user, PARENT_TOOLS, SPAWN_TASK));
  assert.equal(awaited.details.job.status, "done");

  const status = await user.tool("pstack_jobs", { action: "status", id: jobId });
  const statusText = status.content[0].text;
  assert.ok(statusText.startsWith(`${jobId} status=done role=general model=acceptance/parent`), statusText);
  assert.ok(statusText.includes("\n\nexit 0\n"), statusText);
  assert.ok(statusText.endsWith(expectedChildBody(user, PARENT_TOOLS, SPAWN_TASK)), statusText);

  const complete = user.messages().at(-1);
  assert.ok(
    String(complete?.text).startsWith(
      `### pstack_spawn background complete (${jobId}, general, acceptance/parent, exit 0, status=done, sessionDir=`,
    ),
    String(complete?.text),
  );
  assert.equal(complete?.options?.deliverAs, "followUp");

  await assert.rejects(
    async () => user.tool("pstack_jobs", { action: "status", id: "bg-nope" }),
    { message: "unknown job: bg-nope" },
  );
}

async function spawnRefusals(user) {
  await assert.rejects(
    async () => user.tool("pstack_spawn", { task: SPAWN_TASK, background: false, resumeSessionDir: "missing-session" }),
    { message: `resumeSessionDir missing or unreadable: ${user.path("missing-session")}` },
  );
  const bareSlug = [
    "Refused bare model slug 'bare-slug'.",
    "Pass provider/id (e.g. anthropic/claude-sonnet-4-5), inherit-parent, or auto.",
    "Known maps: grok-4.6-fast-xhigh, grok-4.6, claude-fable-5-1-thinking-max, claude-opus-5-thinking-xhigh, gpt-5.6-sol-max, cursor-grok-4.6-medium-fast",
  ].join(" ");
  await assert.rejects(
    async () => user.tool("pstack_spawn", { task: SPAWN_TASK, background: false, model: "bare-slug" }),
    { message: bareSlug },
  );

  const mapped = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: false, model: "grok-4.6" });
  const [mappedHead, mappedBody] = mapped.content[0].text.split("\n\n");
  assertSessionDir(user, spawnHeadDir(mappedHead, "xai/grok-4"));
  assert.equal(mappedBody.split("\n")[1], "stub-child model=xai/grok-4");
}

async function resumeArgv(user) {
  user.stubChild(RICH_CHILD_SOURCE);
  user.write(".pi/resume-me/seed.jsonl", "{}\n");
  const result = await user.tool("pstack_spawn", { task: SPAWN_TASK, background: false, resumeSessionDir: ".pi/resume-me" });
  const [head, body] = result.content[0].text.split("\n\n");
  assert.equal(spawnHeadDir(head), user.path(".pi/resume-me"));
  const lines = body.split("\n");
  assert.deepEqual(lines.slice(0, 4), [
    `stub-child cwd=${childCwd(user)}`,
    `stub-child model=${PARENT_MODEL}`,
    `stub-child tools=${PARENT_TOOLS}`,
    `stub-child prompt=${SPAWN_TASK}`,
  ]);
  const argv = JSON.parse(lines[4].slice("stub-child argv=".length));
  const dirAt = argv.indexOf("--session-dir");
  assert.equal(argv[dirAt + 1], user.path(".pi/resume-me"));
  assert.equal(argv.includes("--continue"), true);
  assert.equal(argv.includes("--no-session"), false);
  assert.equal(lines[5], "PASS");
}

async function runDelegateOneChild(user) {
  await syncSpawn(user);
  await backgroundJob(user);
  await spawnRefusals(user);
  await resumeArgv(user);
  await abortAndCancel(user);
}

function swarmWorkers() {
  return SWARM_TASKS.map((task) => ({ task }));
}

async function swarmCoverage(user) {
  const result = await user.tool("pstack_swarm", { workers: swarmWorkers(), selection: "coverage" });
  const text = result.content[0].text;
  assert.ok(
    text.startsWith(
      "## Swarm report (coverage)\n\n| # | model | verdict | exit | stop | cwd |\n|---|-------|---------|------|------|-----|\n",
    ),
    text.slice(0, 200),
  );
  const cwds = result.details.results.map((entry) => entry.cwd);
  assert.equal(cwds.length, SWARM_TASKS.length);
  assert.equal(new Set(cwds).size, SWARM_TASKS.length, `swarm workers shared a worktree: ${cwds.join(", ")}`);
  for (const [index, cwd] of cwds.entries()) {
    assert.ok(text.includes(`| ${index + 1} | ${PARENT_MODEL} | PASS | exit 0 | - | ${cwd} |`), text.slice(0, 400));
    assert.ok(text.includes(`### Worker ${index + 1} (${PARENT_MODEL}, exit 0, cwd ${cwd})`), cwd);
    assert.ok(cwd.startsWith(`${user.path(".pstack-worktrees")}/auto-`), `worker not isolated: ${cwd}`);
  }
  assert.deepEqual(result.details.verdicts, ["PASS", "PASS", "PASS"]);
  assert.equal(result.details.selection, "coverage");
}

async function swarmBestOf(user) {
  const result = await user.tool("pstack_swarm", { workers: swarmWorkers(), selection: "best-of" });
  assert.ok(result.content[0].text.startsWith("## Swarm report (best-of)\n\n"));
  assert.ok(result.content[0].text.includes("\n\nDeclared rule `best-of`: take worker 1 (PASS).\n\n"));
  assert.equal(result.details.selection, "best-of");
  assert.equal(result.details.winner, 0);
}

async function swarmDupCwdRefusal(user) {
  const shared = user.path("shared-writer");
  await assert.rejects(
    async () => user.tool("pstack_swarm", { workers: [{ task: "one", cwd: shared }, { task: "two", cwd: shared }] }),
    {
      message:
        `multi-writer isolation: worker-2 and worker-1 share cwd ${shared}; pass unique cwd or omit cwd for auto worktree`,
    },
  );
}

function arenaCandidates() {
  return [
    { label: "alpha", outputPath: "artifact-alpha.md" },
    { label: "beta", outputPath: "artifact-beta.md" },
  ];
}

async function arenaDefault(user) {
  const result = await user.tool("pstack_arena", { prompt: ARENA_PROMPT, candidates: arenaCandidates() });
  const text = result.content[0].text;
  assert.ok(text.startsWith("## Arena candidates\n\n### alpha (acceptance/parent, exit 0)"), text.slice(0, 120));
  const cwds = result.details.results.map((entry) => entry.cwd);
  assert.equal(result.details.results.length, 2);
  assert.equal(new Set(cwds).size, 2, `arena candidates shared a worktree: ${cwds.join(", ")}`);
  assert.deepEqual(result.details.results.map((entry) => entry.outputPath), ["artifact-alpha.md", "artifact-beta.md"]);
  for (const [index, label] of ["alpha", "beta"].entries()) {
    assert.ok(text.includes(`### ${label} (${PARENT_MODEL}, exit 0)`), label);
    assert.ok(text.includes(`path: artifact-${label}.md`), label);
    assert.ok(text.includes(`Write your artifact under: artifact-${label}.md`), label);
    assert.ok(cwds[index].startsWith(`${user.path(".pstack-worktrees")}/auto-`), `candidate not isolated: ${cwds[index]}`);
  }
  assert.equal(text.includes("## Cross-judge ("), false);
}

async function arenaCrossJudge(user) {
  const result = await user.tool("pstack_arena", {
    prompt: ARENA_PROMPT,
    candidates: arenaCandidates(),
    crossJudge: true,
    rubric: "Prefer the smallest diff",
  });
  const text = result.content[0].text;
  assert.equal(text.split("## Cross-judge (").length - 1, 1, "expected exactly one cross-judge section");
  const judge = text.slice(text.indexOf("## Cross-judge ("));
  assert.ok(judge.startsWith(`## Cross-judge (${PARENT_MODEL})\n\n`), judge.slice(0, 80));
  assert.ok(judge.includes(`stub-child tools=${READONLY_TOOLS}`), "cross-judge child is not readonly");
  assert.ok(text.endsWith("\n\nNext: pick a base and graft per the arena skill."));
  assert.equal(result.details.results.length, 2);
}

async function runFanOutSwarmArena(user) {
  user.installFakeGit();
  await swarmCoverage(user);
  await swarmBestOf(user);
  await swarmDupCwdRefusal(user);
  await arenaDefault(user);
  await arenaCrossJudge(user);
}

function watcherResult(code, stdout) {
  return { code, stdout, stderr: "", killed: false };
}

function installLoopExec(user) {
  let dynRuns = 0;
  user.setExec((command) => {
    if (command === "dyn-stub") {
      dynRuns = dynRuns + 1;
      return dynRuns > 1 ? new Promise(() => {}) : watcherResult(0, "first wake");
    }
    if (command === "fail-stub") return watcherResult(1, "not yet green");
    return watcherResult(0, "watcher: checks green");
  });
}

async function armLoop(user, params) {
  const armed = await user.tool("pstack_loop", { action: "arm", ...params });
  const watcher = params.watchArgv?.length ? " watcher=on" : "";
  assert.equal(
    armed.content[0].text,
    `Armed ${params.id} mode=${params.mode} intervalSeconds=${params.intervalSeconds} maxFires=${params.maxFires}${watcher} coalesceMs=2500`,
  );
  assert.equal(armed.details.id, params.id);
  assert.equal(armed.details.mode, params.mode);
  assert.equal(user.status("pstack-loop"), params.id);
}

async function stopLoop(user, id) {
  const stopped = await user.tool("pstack_loop", { action: "stop", id });
  assert.equal(stopped.content[0].text, "stopped");
  assert.equal(user.status("pstack-loop"), undefined);
}

async function expectFire(user, opts) {
  const expected =
    `[pstack_loop ${opts.id} fire ${opts.fires}/${opts.maxFires} reason=${opts.reason}]\n` +
    `${opts.prompt}\n\n--- ${opts.label} ---\n${opts.output}`;
  await user.waitFor(() => user.message() === expected, 5000, `loop ${opts.id} fire`);
  assert.equal(user.message(), expected);
  assert.equal(user.messages().at(-1)?.options?.deliverAs, "followUp");
}

async function loopStatus(user, row) {
  const status = await user.tool("pstack_loop", { action: "status" });
  assert.equal(status.content[0].text, row);
  const list = await user.tool("pstack_loop", { action: "list" });
  assert.equal(list.content[0].text, row);
}

async function watcherWake(user) {
  await armLoop(user, {
    id: "w1",
    mode: "watcher",
    prompt: "re-check the PR checks",
    intervalSeconds: 120,
    maxFires: 1,
    watchArgv: ["watch-stub", "--once"],
  });
  await expectFire(user, {
    id: "w1",
    fires: 1,
    maxFires: 1,
    reason: "watcher",
    prompt: "re-check the PR checks",
    label: "watcher output",
    output: "watcher: checks green",
  });
  assert.equal(
    user.execCalls().some((call) => call.command === "watch-stub" && call.args[0] === "--once"),
    true,
  );
  await loopStatus(user, "w1 mode=watcher fires=1/1 armed=true lastReason=watcher");
  await stopLoop(user, "w1");
}

async function watcherErrorWake(user) {
  await armLoop(user, {
    id: "w2",
    mode: "watcher",
    prompt: "poll the failing check",
    intervalSeconds: 120,
    maxFires: 1,
    watchArgv: ["fail-stub"],
  });
  await expectFire(user, {
    id: "w2",
    fires: 1,
    maxFires: 1,
    reason: "watcher-error",
    prompt: "poll the failing check",
    label: "watcher output (exit 1)",
    output: "not yet green",
  });
  await loopStatus(user, "w2 mode=watcher fires=1/1 armed=true lastReason=watcher-error");
  await stopLoop(user, "w2");
}

async function dynamicReArm(user) {
  await armLoop(user, {
    id: "d1",
    mode: "dynamic",
    prompt: "drive the PR to green",
    intervalSeconds: 120,
    maxFires: 3,
    watchArgv: ["dyn-stub"],
  });
  await expectFire(user, {
    id: "d1",
    fires: 1,
    maxFires: 3,
    reason: "watcher",
    prompt: "drive the PR to green",
    label: "watcher output",
    output: "first wake",
  });
  await user.waitFor(
    () => user.execCalls().filter((call) => call.command === "dyn-stub").length === 2,
    5000,
    "dynamic watcher re-arm",
  );
  assert.equal(user.execCalls().filter((call) => call.command === "dyn-stub").length, 2);
  await stopLoop(user, "d1");
}

async function intervalAndSettleArms(user) {
  await armLoop(user, { id: "i1", mode: "interval", prompt: "keep the tests green", intervalSeconds: 240, maxFires: 50 });
  await stopLoop(user, "i1");
  await armLoop(user, { id: "s1", mode: "settle", prompt: "retry after settling", intervalSeconds: 120, maxFires: 50 });
  await stopLoop(user, "s1");
}

async function expectTimerFire(user, opts) {
  const expected = `[pstack_loop ${opts.id} fire ${opts.fires}/${opts.maxFires} reason=${opts.reason}]\n${opts.prompt}`;
  await user.waitFor(() => user.message() === expected, 8000, `loop ${opts.id} timer fire`);
  assert.equal(user.message(), expected);
  assert.equal(user.messages().at(-1)?.options?.deliverAs, "followUp");
}

async function settleFire(user) {
  await armLoop(user, { id: "s2", mode: "settle", prompt: "retry after settling", intervalSeconds: 5, maxFires: 1 });
  await user.emitAgentSettled();
  await expectTimerFire(user, { id: "s2", fires: 1, maxFires: 1, reason: "settle", prompt: "retry after settling" });
  await stopLoop(user, "s2");
}

async function intervalFire(user) {
  await armLoop(user, { id: "i2", mode: "interval", prompt: "keep the tests green", intervalSeconds: 5, maxFires: 1 });
  await expectTimerFire(user, { id: "i2", fires: 1, maxFires: 1, reason: "interval", prompt: "keep the tests green" });
  await stopLoop(user, "i2");
}

async function loopCommand(user) {
  await user.command("pstack-loop", "status");
  assert.deepEqual(user.notifications().at(-1), ["info", "(no active loops)"]);
  await user.command("pstack-loop", "45 keep the tests green");
  assert.deepEqual(user.notifications().at(-1), ["info", "Armed loop-1 every 45s"]);
  assert.equal(user.status("pstack-loop"), "loop-1");
  await user.command("pstack-loop", "status");
  assert.deepEqual(user.notifications().at(-1), ["info", "loop-1 mode=interval fires=0/100 armed=true lastReason=-"]);
  await user.command("pstack-loop", "stop loop-1");
  assert.deepEqual(user.notifications().at(-1), ["info", "Stopped loop-1"]);
  assert.equal(user.status("pstack-loop"), undefined);
  await user.command("pstack-loop", "off");
  assert.deepEqual(user.notifications().at(-1), ["info", "All pstack loops stopped."]);
  await user.command("pstack-loop", "not-a-number please");
  assert.deepEqual(user.notifications().at(-1), [
    "error",
    "Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop status|list  |  /pstack-loop stop [id]  |  /pstack-loop off",
  ]);
}

async function loopRefusals(user) {
  await assert.rejects(
    async () => user.tool("pstack_loop", { action: "arm", mode: "watcher", prompt: "x", watchCommand: "bash -lc true" }),
    { message: WATCH_COMMAND_ERROR },
  );
  await assert.rejects(
    async () => user.tool("pstack_loop", { action: "arm", mode: "sometimes", prompt: "x" }),
    { message: "mode must be interval|settle|watcher|dynamic" },
  );
  await assert.rejects(
    async () => user.tool("pstack_loop", { action: "arm", mode: "watcher", prompt: "x" }),
    { message: "watchArgv required for mode=watcher" },
  );
  await assert.rejects(
    async () => user.tool("pstack_loop", { action: "arm", mode: "interval" }),
    { message: "prompt required to arm" },
  );
  const stopped = await user.tool("pstack_loop", { action: "stop" });
  assert.equal(stopped.content[0].text, "stopped");
  assert.equal(user.status("pstack-loop"), undefined);
}

async function runLoopModes(user) {
  installLoopExec(user);
  await watcherWake(user);
  await watcherErrorWake(user);
  await dynamicReArm(user);
  await intervalAndSettleArms(user);
  await settleFire(user);
  await intervalFire(user);
  await loopCommand(user);
  await loopRefusals(user);
}

function installBabysitExec(user) {
  user.setExec((command, args) => {
    if (command === "bun" && args[0] === "--version") return { code: 0, stdout: "1.2.0\n", stderr: "", killed: false };
    if (command === "bun") return { code: 0, stdout: WATCH_OUTPUT, stderr: "", killed: false };
    if (command === "gh") return { code: 0, stdout: GH_OUTPUT, stderr: "", killed: false };
    return { code: 0, stdout: "", stderr: "", killed: false };
  });
}

function driveWatchArgv() {
  return ["bun", WATCH_PR_SCRIPT_REL, "--pr", "42"];
}

function driveLoopArm() {
  return {
    action: "arm",
    mode: "dynamic",
    intervalSeconds: 120,
    maxFires: 40,
    watchArgv: driveWatchArgv(),
    prompt: "Babysit frontier PR 42: re-read forge state and clear the next blocker.",
  };
}

function lastBunScriptCall(user) {
  return user.execCalls().filter((call) => call.command === "bun" && call.args[0] !== "--version").at(-1);
}

async function watchPrDrive(user) {
  const result = await user.tool("pstack_babysit", { pr: "42" });
  const text = result.content[0].text;
  const hint = "--- pstack_loop dynamic arm (default babysit recipe watch-pr-drive) ---";
  assert.ok(text.startsWith(`${WATCH_OUTPUT}\n\n${hint}\n`), text.slice(0, 200));
  assert.equal(text.split(hint).length, 2);
  assert.ok(text.endsWith(`watchArgv=${JSON.stringify(driveWatchArgv())}`), text.slice(-120));
  assert.equal(result.details.code, 0);
  assert.equal(result.details.via, "watch-pr");
  assert.equal(result.details.recipeId, "watch-pr-drive");
  assert.deepEqual(result.details.watchArgv, driveWatchArgv());
  assert.deepEqual(result.details.loopArm, driveLoopArm());
  assert.deepEqual(lastBunScriptCall(user).args, [WATCH_PR_SCRIPT_ABS, "--pr", "42"]);
  assert.equal(user.execCalls().some((call) => call.command === "bun" && call.args[0] === "--version"), true);
}

async function watchPrStatusOnly(user) {
  const result = await user.tool("pstack_babysit", { pr: "42", statusOnly: true });
  assert.equal(result.details.recipeId, "watch-pr-status");
  assert.equal(result.details.via, "watch-pr");
  assert.deepEqual(result.details.watchArgv, ["bun", WATCH_PR_SCRIPT_REL, "--pr", "42", "--status-only"]);
  assert.ok(result.content[0].text.includes("--- pstack_loop dynamic arm (default babysit recipe watch-pr-status) ---"));
  assert.deepEqual(lastBunScriptCall(user).args, [WATCH_PR_SCRIPT_ABS, "--pr", "42", "--status-only"]);
}

async function ghChecksRecipe(user) {
  user.installFakeGh({ "pr checks 42 --watch": { code: 0, stdout: GH_OUTPUT, stderr: "" } });
  const result = await user.tool("pstack_babysit", { pr: "42", recipeId: "gh-checks-watch" });
  const text = result.content[0].text;
  assert.equal(result.details.via, "gh-recipe");
  assert.equal(result.details.recipeId, "gh-checks-watch");
  assert.ok(text.startsWith(`${GH_OUTPUT}\n\n--- pstack_loop dynamic arm ---\n`), text.slice(0, 120));
  assert.equal(text.includes("watchArgv="), false);
  assert.equal(text.includes("(default babysit recipe"), false);
  assert.deepEqual(result.details.watchArgv, ["gh", "pr", "checks", "42", "--watch"]);
  const ghCall = user.execCalls().filter((call) => call.command === "gh").at(-1);
  assert.deepEqual(ghCall.args, ["pr", "checks", "42", "--watch"]);
}

async function babysitRefusals(user) {
  await assert.rejects(
    async () => user.tool("pstack_babysit", { pr: "42", recipeId: "watch-pr-queued-stack" }),
    { message: "recipeId=watch-pr-queued-stack requires stackPrs (bottom-to-top PR numbers)" },
  );
  await assert.rejects(
    async () => user.tool("pstack_babysit", { pr: "42", recipeId: "watch-pr-nope" }),
    {
      message:
        "unknown babysit recipeId 'watch-pr-nope'. Known: watch-pr-status, watch-pr-drive, watch-pr-stack, watch-pr-queued-stack, gh-checks-watch, gh-view-json",
    },
  );
  const bare = await user.tool("pstack_babysit", { pr: "42", armLoopHint: false });
  assert.equal(bare.content[0].text, WATCH_OUTPUT);
  assert.equal(bare.details.loopArm, undefined);
  assert.equal(bare.content[0].text.includes("--- pstack_loop dynamic arm"), false);
}

async function runBabysitAPr(user) {
  installBabysitExec(user);
  await watchPrDrive(user);
  await watchPrStatusOnly(user);
  await ghChecksRecipe(user);
  await babysitRefusals(user);
}

export const JOURNEYS = [
  {
    id: "delegate-one-child",
    title: "a user delegates one child and drains the background job",
    critical: true,
    surfaces: ["spawn", "jobs"],
    run: runDelegateOneChild,
  },
  {
    id: "fan-out-swarm-arena",
    title: "a user fans out to a swarm and an arena",
    critical: true,
    surfaces: ["swarm", "arena"],
    run: runFanOutSwarmArena,
  },
  {
    id: "loop-modes",
    title: "a user arms and stops heartbeat loops",
    critical: true,
    surfaces: ["loop"],
    run: runLoopModes,
  },
  {
    id: "babysit-a-pr",
    title: "a user babysits a pull request",
    critical: true,
    surfaces: ["babysit", "loop"],
    run: runBabysitAPr,
  },
];
