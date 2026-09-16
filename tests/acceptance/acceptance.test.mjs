/**
 * Definition-of-done acceptance suite for the Pi port of pstack.
 *
 * Drives extensions/index.ts (the real composition root) through a fake Pi host:
 * real command handlers, real event handlers, real tools. Child agents are stubbed
 * at the process.argv[1] seam the unit tests use, so the argv a tool builds is
 * observed rather than a mock's echo. Worktree isolation runs through a fake git
 * on PATH. No network, no real Pi session, no real child model.
 *
 * One Vitest test per scenario. Soft assertions accumulate every failure in a
 * scenario instead of stopping at the first, so one run reports the whole picture.
 */
import { expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import piPstack from "../../extensions/index.ts";
import { defaultModelsConfig, loadModelsConfig } from "../../extensions/models/config.ts";
import { matchPlaybook } from "../../extensions/sticky-playbook.ts";
import { stripFrontmatter } from "../../extensions/sticky-poteto.ts";
import {
  createHost,
  installChildScript,
  installEnvVar,
  installFakeGh,
  installFakeGit,
  installHome,
  makeHostTempRoot,
  runGit,
  writeModelsConfig,
  writeStubChild,
} from "../support/pi-host.mjs";
import { repoRoot } from "../support/repo-root.mjs";

const ROOT = repoRoot(import.meta.url);
const SKILLS = join(ROOT, "skills");
const FINISH_CONDITION = "finish condition: every acceptance scenario reports PASS";
const SCENARIO_NAMES = [
  "poteto-mode", "poteto-mode-off", "pstack", "how", "why", "recall", "blast-radius",
  "architect", "arena", "swarm", "interrogate", "setup-pstack", "reflect", "teach", "tdd",
  "no-comments", "figure-it-out", "show-me-your-work", "unslop", "bro", "technical-writing",
  "deslop", "pstack-readonly", "pstack-readonly-off", "babysit", "ship",
];
const DOD_SKILL_HEADINGS = {
  "blast-radius": "# Blast radius",
  bro: "Restate your last message.",
  "figure-it-out": "# Figure it out",
  "no-comments": "# No comments",
  reflect: "# Reflect",
  teach: "# Teach",
  "technical-writing": "# Technical writing",
  unslop: "# Unslop",
};

function readText(path) {
  return readFileSync(path, "utf8");
}

function skillText(name) {
  return stripFrontmatter(readText(join(SKILLS, name, "SKILL.md")));
}

function flush() {
  return new Promise((done) => setImmediate(done));
}

function acceptanceExec() {
  return { code: 0, stdout: "acceptance-watcher: finish condition observed", stderr: "", killed: false };
}

function createScenarioEnv(tmp) {
  return {
    tmp,
    cwd: tmp.cwd,
    newHost() {
      return createHost(tmp.cwd, { entry: (pi) => piPstack(pi), exec: acceptanceExec });
    },
  };
}

async function scenarioBugFix(env, host) {
  await host.commands.get("poteto-mode").handler("fix this bug", host.ctx());
  const entry = host.lastEntry("pstack-poteto-mode");
  expect.soft(entry?.data?.enabled, "entry.enabled").toEqual(true);
  expect.soft(entry?.data?.matchedPlaybookId, "entry.playbook").toEqual("bug-fix");
  expect.soft(entry?.data?.matchedScore, "entry.score").toEqual(3);
  expect.soft(host.messages().at(-1)?.text, "message").toEqual("/skill:poteto-mode playbooks/bug-fix fix this bug");
  const injected = await host.emitBeforeAgentStart("fix this bug", "SYS");
  expect.soft(String(injected), "injected.bug-fix-id").toContain("force-invoke fallback → **bug-fix**");
  expect.soft(String(injected), "injected.repro-step").toContain("Reproduce it yourself");
  expect.soft(String(injected), "injected.bisect-step").toContain("Binary-search the cause");
  const before = host.entries().length;
  const extensionTurn = await host.emitInput(host.messages().at(-1)?.text ?? "", "extension");
  expect.soft(extensionTurn.text, "extension-turn.text").toEqual("/skill:poteto-mode playbooks/bug-fix fix this bug");
  expect.soft(host.entries().length, "extension-turn.no-entry").toEqual(before);
  await host.emitSessionStart();
  expect.soft(host.statuses().at(-1), "restored.status").toEqual(["pstack", "poteto:bug-fix"]);
  return "sticky=true id=bug-fix score=3 msg=/skill:poteto-mode playbooks/bug-fix fix this bug injected=bug-fix.md steps restored=poteto:bug-fix";
}

async function scenarioHow(env, host) {
  await host.commands.get("how").handler("does this subsystem work?");
  expect.soft(host.messages().at(-1)?.text, "how-message").toEqual("/skill:how does this subsystem work?");
  const turn = await host.emitInput("how does this subsystem work?", "interactive");
  expect.soft(turn.text, "transform").toEqual("/skill:poteto-mode playbooks/investigation how does this subsystem work?");
  const entry = host.lastEntry("pstack-poteto-mode");
  expect.soft(entry?.data?.matchedPlaybookId, "entry.playbook").toEqual("investigation");
  expect.soft(entry?.data?.matchedScore, "entry.score").toEqual(5);
  expect.soft(host.activeTools().includes("bash"), "readonly.bash-removed").toEqual(false);
  expect.soft(host.statuses().at(-1), "readonly.status").toEqual(["pstack-ro", "readonly"]);
  const injected = await host.emitBeforeAgentStart("how does this subsystem work?", "SYS");
  expect.soft(String(injected), "injected.how-shape").toContain("Overview / Key Concepts / How It Works / Where Things Live / Gotchas");
  expect.soft(String(injected), "injected.how-route").toContain("Route through the **how** skill");
  expect.soft(skillText("how"), "how-skill.shape").toContain("Overview, Key Concepts, How It Works, Where Things Live, Gotchas.");
  return "playbook=investigation score=5 readonly=on shape=Overview/Key Concepts/How It Works/Where Things Live/Gotchas";
}

async function scenarioWhy(env, host) {
  await host.commands.get("why").handler("was this designed this way?");
  expect.soft(host.messages().at(-1)?.text, "why-message").toEqual("/skill:why was this designed this way?");
  const turn = await host.emitInput("why was this designed this way?", "interactive");
  expect.soft(turn.text, "transform").toEqual("/skill:poteto-mode playbooks/investigation why was this designed this way?");
  expect.soft(host.lastEntry("pstack-poteto-mode")?.data?.matchedPlaybookId, "entry.playbook").toEqual("investigation");
  const injected = await host.emitBeforeAgentStart("why was this designed this way?", "SYS");
  expect.soft(String(injected), "injected.why-route").toContain("For motivation questions, also route through the **why** skill");
  const sections = [
    "The Question", "The Code in Question", "What We Found", "What We Can Reasonably Infer",
    "Competing Hypotheses", "What We Don't Know", "Sources Consulted", "Confidence Summary",
  ];
  for (const section of sections) {
    expect.soft(skillText("why"), `why-skill.${section}`).toContain(section);
  }
  return `playbook=investigation why-route=on why-sections=${sections.length}`;
}

async function scenarioArchitect(env, host) {
  await host.commands.get("architect").handler("this before coding");
  expect.soft(host.messages().at(-1)?.text, "architect-message").toEqual("/skill:architect this before coding");
  expect.soft(skillText("architect"), "architect.phase-b-arena").toContain("Run the **arena** skill");
  expect.soft(skillText("architect"), "architect.panel-role").toContain("architect runners");
  const panel = ["stub/arch-a", "stub/arch-b", "stub/arch-c"];
  writeModelsConfig(env.cwd, { "architect runners": panel, "arena runners": panel });
  expect.soft(loadModelsConfig(env.cwd)?.roles?.["architect runners"], "config.panel").toEqual(panel);
  expect.soft(defaultModelsConfig().roles["architect runners"].length, "default-panel.length").toEqual(4);
  const candidates = panel.map((_model, index) => ({ label: `design-${index + 1}` }));
  const prompt = "Sketch the module boundary before coding";
  const outcome = await host.tools.get("pstack_arena").execute("a", { prompt, candidates }, undefined, undefined, host.ctx());
  const results = outcome.details.results;
  const models = results.map((result) => result.result.model);
  expect.soft(results.length, "candidates").toEqual(panel.length);
  expect.soft(models, "candidate-models").toEqual(panel);
  expect.soft(new Set(results.map((result) => result.cwd)).size, "distinct-cwds").toEqual(3);
  return `panel=${panel.length} models=${models.join(",")} distinct-cwds=3 default-panel=4`;
}

async function scenarioArena(env, host) {
  await host.commands.get("arena").handler("solve this three ways");
  expect.soft(host.messages().at(-1)?.text, "arena-message").toEqual("/skill:arena solve this three ways");
  const candidates = [
    { label: "alpha", model: "stub/alpha", outputPath: "artifact-alpha.md" },
    { label: "beta", model: "stub/beta", outputPath: "artifact-beta.md" },
    { label: "gamma", model: "stub/gamma", outputPath: "artifact-gamma.md" },
  ];
  const params = { prompt: "Solve the shared design problem", candidates, crossJudge: true, judgeModel: "stub/cross-judge", rubric: "Prefer the smallest diff" };
  const outcome = await host.tools.get("pstack_arena").execute("a", params, undefined, undefined, host.ctx());
  const results = outcome.details.results;
  expect.soft(results.length, "candidates").toEqual(3);
  expect.soft(results.map((result) => result.label), "labels").toEqual(["alpha", "beta", "gamma"]);
  expect.soft(new Set(results.map((result) => result.cwd)).size, "distinct-cwds").toEqual(3);
  expect.soft(new Set(results.map((result) => result.outputPath)).size, "distinct-output-paths").toEqual(3);
  const text = outcome.content[0].text;
  expect.soft(text.split("## Cross-judge (").length - 1, "judge-sections").toEqual(1);
  const judgeIndex = text.indexOf("## Cross-judge (stub/cross-judge)");
  expect.soft(judgeIndex > text.indexOf("### gamma"), "judge.after-candidates").toBeTruthy();
  const judgeSection = judgeIndex >= 0 ? text.slice(judgeIndex) : "";
  for (const label of ["alpha", "beta", "gamma"]) {
    expect.soft(judgeSection, `judge.saw-${label}`).toContain(`### ${label} (stub/${label})`);
  }
  return "candidates=3 labels=alpha,beta,gamma distinct=cwds:3,paths:3 judges=1 judge-saw=3";
}

async function scenarioSwarm(env, host) {
  await host.commands.get("swarm").handler("investigate these packages in parallel");
  expect.soft(host.messages().at(-1)?.text, "swarm-message").toEqual("/skill:swarm investigate these packages in parallel");
  const packages = ["pi-ai", "pi-agent-core", "pi-coding-agent"];
  const workers = packages.map((name) => ({ task: `Investigate package ${name} and report PASS/ISSUES/BLOCKED` }));
  const outcome = await host.tools.get("pstack_swarm").execute("s", { workers, selection: "coverage" }, undefined, undefined, host.ctx());
  const results = outcome.details.results;
  expect.soft(results.length, "workers").toEqual(packages.length);
  expect.soft(new Set(results.map((result) => result.cwd)).size, "distinct-cwds").toEqual(3);
  const outside = results.filter((result) => !result.cwd.startsWith(join(env.cwd, ".pstack-worktrees")));
  expect.soft(outside.length, "all-isolated").toEqual(0);
  for (const [index, name] of packages.entries()) {
    expect.soft(results[index]?.output, `worker.${name}`).toContain(`package ${name}`);
  }
  expect.soft(outcome.content[0].text, "report.header").toContain("## Swarm report (coverage)");
  return `workers=3 packages=${packages.join(",")} distinct-cwds=3 root=.pstack-worktrees`;
}

async function scenarioInterrogate(env, host) {
  await host.commands.get("interrogate").handler("this diff");
  expect.soft(host.messages().at(-1)?.text, "interrogate-message").toEqual("/skill:interrogate this diff");
  expect.soft(skillText("interrogate"), "interrogate.one-per-model").toContain("Spawn one reviewer per configured model");
  expect.soft(skillText("interrogate"), "interrogate.readonly-true").toContain("`readonly`: `true`");
  const reviewers = ["stub/rev-a", "stub/rev-b", "stub/rev-c"];
  writeModelsConfig(env.cwd, { "interrogate reviewers": reviewers });
  expect.soft(loadModelsConfig(env.cwd)?.roles?.["interrogate reviewers"], "configured-reviewers").toEqual(reviewers);
  const spawn = host.tools.get("pstack_spawn");
  let observed = [];
  for (const [index, model] of reviewers.entries()) {
    const params = { task: `Adversarially review the diff (reviewer ${index + 1})`, model, readonly: true, background: false };
    const outcome = await spawn.execute(`r${index}`, params, undefined, undefined, host.ctx());
    observed = [...observed, outcome.details.result];
  }
  expect.soft(observed.length, "reviewer-count").toEqual(reviewers.length);
  expect.soft(observed.map((result) => result.model), "reviewer-models").toEqual(reviewers);
  for (const [index, result] of observed.entries()) {
    expect.soft(String(result.output), `reviewer.${index + 1}.readonly-argv`).toContain("stub-child tools=read,grep,find,ls");
  }
  const labels = reviewers.map((_model, index) => `Reviewer ${String.fromCharCode(65 + index)}`);
  const judgeParams = { prompt: "Adversarially review the diff", candidates: reviewers.map((model, index) => ({ label: labels[index], model })), crossJudge: true, judgeModel: "stub/rev-judge" };
  const judged = await host.tools.get("pstack_arena").execute("j", judgeParams, undefined, undefined, host.ctx());
  const text = judged.content[0].text;
  const judgeIndex = text.indexOf("## Cross-judge (stub/rev-judge)");
  const judgeSection = judgeIndex >= 0 ? text.slice(judgeIndex) : "";
  for (const label of labels) {
    expect.soft(judgeSection, `judge.saw-${label}`).toContain(`### ${label} (`);
  }
  return `reviewers=3 models=${reviewers.join(",")} readonly-argv=--tools-read,grep,find,ls judge=received:3`;
}

async function scenarioTdd(env, host) {
  await host.commands.get("tdd").handler("implement this");
  expect.soft(host.messages().at(-1)?.text, "tdd-message").toEqual("/skill:tdd implement this");
  const stages = [
    "Understand the bug", "Choose the narrowest executable check", "Write the failing test first",
    "Run the new test before fixing", "Fix the bug", "Rerun the regression test", "Run nearby validation",
  ];
  for (const stage of stages) {
    expect.soft(skillText("tdd"), `tdd-stage.${stage}`).toContain(stage);
  }
  const sticky = matchPlaybook("implement this");
  expect.soft(sticky?.id, "sticky-match.id").toEqual("feature");
  expect.soft(sticky?.score, "sticky-match.score").toEqual(2);
  return `skill=tdd stages=${stages.length} sticky-match=feature/2`;
}

async function scenarioAutonomousRun(env, host) {
  const loop = host.tools.get("pstack_loop");
  const params = { action: "arm", mode: "dynamic", prompt: FINISH_CONDITION, maxFires: 1, intervalSeconds: 30, watchArgv: ["acceptance-watch", "finish-condition"] };
  const armed = await loop.execute("l", params, undefined, undefined, host.ctx());
  expect.soft(armed.content[0].text, "loop.arm.mode").toContain("mode=dynamic");
  expect.soft(armed.content[0].text, "loop.arm.watcher").toContain("watcher=on");
  await flush();
  await flush();
  const fired = host.messages().at(-1)?.text ?? "";
  expect.soft(fired, "loop.fire.reason").toContain("reason=watcher");
  expect.soft(fired, "loop.fire.prompt").toContain(FINISH_CONDITION);
  expect.soft(host.execCalls().at(-1)?.args, "loop.watch-argv").toEqual(["finish-condition"]);
  await host.commands.get("poteto-mode").handler("run this autonomously until the finish condition passes", host.ctx());
  const paraphrase = host.lastEntry("pstack-poteto-mode")?.data;
  expect.soft(paraphrase?.enabled, "entry.enabled").toEqual(true);
  expect.soft(paraphrase?.matchedPlaybookId, "entry.playbook").toEqual("autonomous-run");
  await host.commands.get("poteto-mode").handler("run until done", host.ctx());
  const canonical = host.lastEntry("pstack-poteto-mode")?.data;
  expect.soft(canonical?.matchedPlaybookId, "canonical-playbook").toEqual("autonomous-run");
  return "loop=dynamic maxFires=1 fired=reason=watcher prompt=finish-condition canonical-cue=run-until-done";
}

const DECISION_ROW = {
  phase: "acceptance",
  decision: "ship the acceptance harness",
  why: "one runnable definition-of-done for the Pi port",
  evidence: "tests/acceptance/acceptance.test.mjs",
  result: "row appended",
};

async function scenarioDecisionLog(env, host) {
  await host.commands.get("show-me-your-work").handler("");
  expect.soft(host.messages().at(-1)?.text, "command-message").toEqual("/skill:show-me-your-work");
  const outcome = await host.tools.get("pstack_decision_log").execute("d", { ...DECISION_ROW }, undefined, undefined, host.ctx());
  const path = join(env.cwd, ".pi", "decisions.tsv");
  expect.soft(outcome.content[0].text, "result.text").toEqual(`Logged decision to ${path}`);
  const rows = readText(path).trimEnd().split("\n");
  expect.soft(rows[0], "file.header").toEqual("ts\tphase\tdecision\twhy\tevidence\tresult");
  const fields = rows[1]?.split("\t") ?? [];
  expect.soft(fields.length, "row.columns").toEqual(6);
  expect.soft(fields[1], "row.phase").toEqual(DECISION_ROW.phase);
  expect.soft(fields[2], "row.decision").toEqual(DECISION_ROW.decision);
  expect.soft(fields[3], "row.why").toEqual(DECISION_ROW.why);
  expect.soft(fields[4], "row.evidence").toEqual(DECISION_ROW.evidence);
  expect.soft(fields[5], "row.result").toEqual(DECISION_ROW.result);
  const ts = fields[0] ?? "";
  expect.soft(ts.length > 0 && new Date(ts).toISOString() === ts, "row.ts.iso").toBeTruthy();
  expect.soft(host.entries().at(-1)?.customType, "entry.type").toEqual("pstack-decision");
  return `rows=1 columns=6 phase=acceptance ts=${ts}`;
}

async function scenarioRecall(env, host) {
  await host.commands.get("recall").handler("this topic");
  expect.soft(host.messages().at(-1)?.text, "recall-message").toEqual("/skill:recall this topic");
  const marker = "acceptance-recall-marker";
  const sessionPath = join(env.cwd, ".pi", "sessions", "acceptance-recall.jsonl");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify({ role: "user", content: `recall ${marker} from the transcript` })}\n`, "utf8");
  runGit(env, ["init", "-q"]);
  runGit(env, ["commit", "--allow-empty", "-q", "-m", `docs: ${marker} fixture commit`]);
  const params = { action: "recall", query: marker, limit: 5, days: 7 };
  const outcome = await host.tools.get("pstack_sessions").execute("s", params, undefined, undefined, host.ctx());
  const details = outcome.details;
  expect.soft(details.corpus, "corpus").toEqual(["sessions", "git-log", "gh-prs", "ranked-merge"]);
  expect.soft(details.rankedHits >= 1, "ranked-hits.at-least-1").toBeTruthy();
  expect.soft(details.top?.[0]?.source, "top.source").toEqual("session");
  expect.soft((details.top ?? []).some((hit) => hit.source === "git"), "top.has-git").toBeTruthy();
  const body = outcome.content[0].text;
  expect.soft(String(body), "body.header").toContain("## Recall corpus (local, ranked)");
  expect.soft(String(body), "body.query").toContain(`query=${marker} days=7`);
  expect.soft(String(body), "body.gh-offline").toContain("(gh not available — skipped PR corpus)");
  return `corpus=sessions,git-log,gh-prs,ranked-merge hits=${details.rankedHits} top=${details.top?.[0]?.source} gh=skipped-offline`;
}

async function scenarioCommandSurface(env) {
  const names = SCENARIO_NAMES;
  const first = env.newHost();
  await first.emitSessionStart();
  const all = first.registrations();
  for (const name of names) {
    expect.soft(all.filter((entry) => entry === name).length, `registered-once.${name}`).toEqual(1);
  }
  const globalDups = [...new Set(all.filter((name, index) => all.indexOf(name) !== index))];
  expect.soft(globalDups.filter((name) => names.includes(name)), "scenario-names.duplicates").toEqual([]);
  await first.commands.get("poteto-mode").handler("fix this bug", first.ctx());
  const potetoMessage = first.messages().at(-1)?.text;
  const potetoEntry = first.lastEntry("pstack-poteto-mode")?.data;
  const second = env.newHost();
  await second.emitSessionStart();
  await second.commands.get("pstack").handler("fix this bug", second.ctx());
  const pstackMessage = second.messages().at(-1)?.text;
  const pstackEntry = second.lastEntry("pstack-poteto-mode")?.data;
  expect.soft(pstackMessage, "alias.message-equal").toEqual(potetoMessage);
  expect.soft(pstackMessage, "alias.message").toEqual("/skill:poteto-mode playbooks/bug-fix fix this bug");
  expect.soft(pstackEntry?.matchedPlaybookId, "alias.playbook-equal").toEqual(potetoEntry?.matchedPlaybookId);
  expect.soft(pstackEntry?.matchedPlaybookId, "alias.playbook").toEqual("bug-fix");
  expect.soft(pstackEntry?.matchedScore, "alias.score-equal").toEqual(potetoEntry?.matchedScore);
  await first.commands.get("setup-pstack").handler("", first.ctx());
  const configPath = join(env.tmp.home, ".pi", "agent", "pstack-models.json");
  const written = existsSync(configPath) ? JSON.parse(readText(configPath)) : undefined;
  expect.soft(written?.roles?.["arena runners"]?.length, "setup-pstack.rich-handler").toEqual(4);
  const dupNote = globalDups.length === 0 ? "none" : `${globalDups.join(",")}(effective=models-handler)`;
  return `slash-names=${names.length}-each-once alias=pstack→poteto-mode msg=/skill:poteto-mode playbooks/bug-fix fix this bug global-dups=${dupNote}`;
}

async function scenarioDeslop(env, host) {
  await host.commands.get("deslop").handler("", host.ctx());
  expect.soft(host.messages().at(-1)?.text, "command-message").toEqual(
    "Run pstack_deslop on the current diff against main (consider applySafe:true for safe comment deletes), then apply /skill:unslop to any prose surfaces and fix remaining findings with edit.",
  );
  const outcome = await host.tools
    .get("pstack_deslop")
    .execute("d", { dryRun: true }, undefined, undefined, host.ctx());
  expect.soft(outcome.content[0].text, "result.headline").toEqual(
    "pstack_deslop: no common slop patterns in added lines (still run /skill:unslop on prose surfaces).",
  );
  return "tool=pstack_deslop dryRun=clean-headline";
}

async function scenarioSkillSurface(env, host) {
  const names = Object.keys(DOD_SKILL_HEADINGS);
  for (const name of names) {
    await host.commands.get(name).handler("x", host.ctx());
    expect.soft(host.messages().at(-1)?.text, `forwarded.${name}`).toEqual(`/skill:${name} x`);
    expect.soft(skillText(name).includes(DOD_SKILL_HEADINGS[name]), `body-loaded.${name}`).toEqual(true);
  }
  return `skills=${names.length} forwarded-and-loaded`;
}

async function runScenario(descriptor) {
  const tmp = makeHostTempRoot("pstack-acceptance-");
  const restores = [
    installHome(tmp.home),
    installEnvVar("PSTACK_CHILD_ROLE", undefined),
    installChildScript(writeStubChild(tmp.root)),
    ...(descriptor.fakeGit ? [installFakeGit(tmp.root)] : []),
    ...(descriptor.fakeGh ? [installFakeGh(tmp.root)] : []),
  ];
  try {
    const env = createScenarioEnv(tmp);
    const host = env.newHost();
    await host.emitSessionStart();
    try {
      return await descriptor.run(env, host);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect.soft(false, `threw:[${message}]`).toBe(true);
      return undefined;
    }
  } finally {
    for (const restore of restores.toReversed()) restore();
    rmSync(tmp.root, { recursive: true, force: true });
  }
}

async function annotateNote(ctx, note) {
  if (note === undefined) return;
  // Vitest refuses an annotation once the test leaves the "run" state, so a soft failure drops the note.
  const state = ctx.task.result?.state;
  if (state !== undefined && state !== "run") return;
  await ctx.annotate(note, "scenario");
}

test("scenario 0: the slash-command surface registers each name once and keeps the pstack alias", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioCommandSurface }));
});

test("scenario 1: /poteto-mode matches the bug-fix playbook", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioBugFix }));
});

test("scenario 2: /how injects the investigation how-shape", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioHow }));
});

test("scenario 3: /why routes motivation questions through the why skill", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioWhy }));
});

test("scenario 4: /architect fans out the configured architect panel", async (ctx) => {
  await annotateNote(ctx, await runScenario({ fakeGit: true, run: scenarioArchitect }));
});

test("scenario 5: /arena isolates candidates and appends one cross-judge section", async (ctx) => {
  await annotateNote(ctx, await runScenario({ fakeGit: true, run: scenarioArena }));
});

test("scenario 6: /swarm isolates workers under .pstack-worktrees and reports coverage", async (ctx) => {
  await annotateNote(ctx, await runScenario({ fakeGit: true, run: scenarioSwarm }));
});

test("scenario 7: /interrogate spawns one readonly reviewer per configured model", async (ctx) => {
  await annotateNote(ctx, await runScenario({ fakeGit: true, run: scenarioInterrogate }));
});

test("scenario 8: /tdd loads the staged TDD skill and matches the feature playbook", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioTdd }));
});

test("scenario 9: /poteto-mode matches the autonomous-run playbook and fires the watcher", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioAutonomousRun }));
});

test("scenario 10: /show-me-your-work appends a decision-trail row", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioDecisionLog }));
});

test("scenario 11: /recall ranks the local corpus with gh offline", async (ctx) => {
  await annotateNote(ctx, await runScenario({ fakeGh: true, run: scenarioRecall }));
});

test("scenario 12: /deslop forwards the diff-review prompt and reports a clean scan", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioDeslop }));
});

test("scenario 13: the DOD skill surface forwards each skill and loads its body", async (ctx) => {
  await annotateNote(ctx, await runScenario({ run: scenarioSkillSurface }));
});
