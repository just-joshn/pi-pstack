/**
 * Definition-of-done acceptance run for the Pi port of pstack.
 *
 * Drives extensions/index.ts (the real composition root) through a fake Pi host:
 * real command handlers, real event handlers, real tools. Child agents are stubbed
 * at the process.argv[1] seam the unit tests use, so the argv a tool builds is
 * observed rather than a mock's echo. Worktree isolation runs through a fake git
 * on PATH. No network, no real Pi session, no real child model.
 *
 * Run: node --experimental-strip-types --import ./extensions/test/peer-deps.mjs tests/acceptance/run.mjs
 * Exit 0 all pass, 1 any scenario fails, 2 harness error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripFrontmatter } from "../../extensions/sticky-poteto.ts";
import { defaultModelsConfig, loadModelsConfig } from "../../extensions/models/config.ts";
import { matchPlaybook } from "../../extensions/sticky-playbook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILLS = join(ROOT, "skills");
const BUILTIN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const FINISH_CONDITION = "finish condition: every acceptance scenario reports PASS";
const SCENARIO_NAMES = [
  "poteto-mode", "how", "why", "architect", "arena",
  "swarm", "interrogate", "tdd", "show-me-your-work", "recall",
];
const STUB_CHILD_SOURCE = [
  "const argv = process.argv;",
  "function flagValue(name) {",
  "  const index = argv.indexOf(name);",
  '  return index >= 0 ? argv[index + 1] : "none";',
  "}",
  "const text = [",
  '  "stub-child cwd=" + process.cwd(),',
  '  "stub-child model=" + flagValue("--model"),',
  '  "stub-child tools=" + flagValue("--tools"),',
  '  "stub-child prompt=" + (argv.at(-1) ?? ""),',
  '  "PASS",',
  '].join("\\n");',
  'const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };',
  'process.stdout.write(JSON.stringify(event) + "\\n");',
  "",
].join("\n");

let assertionCount = 0;
let extensionEntry;

function readText(path) {
  return readFileSync(path, "utf8");
}

function skillText(name) {
  return stripFrontmatter(readText(join(SKILLS, name, "SKILL.md")));
}

function flush() {
  return new Promise((done) => setImmediate(done));
}

function formatValue(value) {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function valuesEqual(actual, expected) {
  if (actual === undefined || expected === undefined) return actual === expected;
  if (typeof actual === "string" || typeof expected === "string") return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function createReport() {
  let notes = [];
  let failures = [];
  const verify = (label, ok) => {
    assertionCount += 1;
    if (!ok) failures = [...failures, label];
    return ok;
  };
  return {
    note: (text) => {
      notes = [...notes, text];
    },
    expectEqual(label, actual, expected) {
      const ok = valuesEqual(actual, expected);
      verify(`${label} observed=${formatValue(actual)} expected=${formatValue(expected)}`, ok);
    },
    expect(label, condition) {
      verify(`${label} observed=${formatValue(condition)}`, Boolean(condition));
    },
    expectIncludes(label, haystack, needle) {
      const text = typeof haystack === "string" ? haystack : "";
      verify(`${label} missing=${formatValue(needle)}`, text.includes(needle));
    },
    record(label) {
      failures = [...failures, label];
    },
    notes: () => [...notes],
    failures: () => [...failures],
    failed: () => failures.length > 0,
  };
}

function makeHostCounters() {
  let registrations = [];
  let entries = [];
  let messages = [];
  let statuses = [];
  let notifications = [];
  let execCalls = [];
  let activeTools = [...BUILTIN_TOOLS];
  return {
    registrations: () => [...registrations],
    addRegistration: (name) => {
      registrations = [...registrations, name];
    },
    entries: () => [...entries],
    addEntry: (customType, data) => {
      entries = [...entries, { type: "custom", customType, data }];
    },
    messages: () => [...messages],
    addMessage: (text, options) => {
      messages = [...messages, { text, options }];
    },
    statuses: () => [...statuses],
    addStatus: (key, value) => {
      statuses = [...statuses, [key, value]];
    },
    notifications: () => [...notifications],
    addNotification: (level, message) => {
      notifications = [...notifications, [level, message]];
    },
    execCalls: () => [...execCalls],
    addExecCall: (command, args) => {
      execCalls = [...execCalls, { command, args: [...args] }];
    },
    activeTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
  };
}

function makeUiContext(counters) {
  return {
    setStatus: (key, value) => counters.addStatus(key, value),
    notify: (message, level) => counters.addNotification(level, message),
    confirm: async () => true,
    select: async () => undefined,
    input: async () => undefined,
    editor: async () => undefined,
  };
}

function makePiFacade(counters, commands, tools, handlers) {
  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, spec) {
      counters.addRegistration(name);
      commands.set(name, spec);
    },
    registerTool(definition) {
      if (tools.has(definition.name)) {
        throw new Error(`duplicate tool registration: ${definition.name}`);
      }
      tools.set(definition.name, definition);
    },
    appendEntry(customType, data) {
      counters.addEntry(customType, data);
    },
    sendUserMessage(content, options) {
      const text = typeof content === "string" ? content : JSON.stringify(content);
      counters.addMessage(text, options ?? {});
    },
    sendMessage(message) {
      counters.addMessage(String(message?.content ?? ""), { deliverAs: "custom" });
    },
    async exec(command, args) {
      counters.addExecCall(command, args);
      return { code: 0, stdout: "acceptance-watcher: finish condition observed", stderr: "", killed: false };
    },
    getActiveTools: () => counters.activeTools(),
    getAllTools: () => [...new Set([...BUILTIN_TOOLS, ...tools.keys()])].map((name) => ({ name })),
    setActiveTools(names) {
      counters.setActiveTools(names);
    },
  };
}

function makeHostState(cwd) {
  const counters = makeHostCounters();
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  return {
    pi: makePiFacade(counters, commands, tools, handlers),
    ui: makeUiContext(counters),
    commands,
    tools,
    handlers,
    cwd,
    registrations: counters.registrations,
    entries: counters.entries,
    messages: counters.messages,
    statuses: counters.statuses,
    notifications: counters.notifications,
    execCalls: counters.execCalls,
    activeTools: counters.activeTools,
  };
}

function makeCtx(state) {
  return {
    cwd: state.cwd,
    hasUI: true,
    model: { provider: "acceptance", id: "parent" },
    sessionManager: { getBranch: () => state.entries(), getSessionFile: () => undefined },
    ui: state.ui,
  };
}

function makeEmitters(state, ctx, emit) {
  return {
    emitSessionStart: () => emit("session_start", { type: "session_start", reason: "startup" }),
    emitBeforeAgentStart: async (prompt, systemPrompt) => {
      let current = systemPrompt;
      for (const handler of state.handlers.get("before_agent_start") ?? []) {
        const result = await handler(
          { type: "before_agent_start", prompt, images: undefined, systemPrompt: current },
          ctx(),
        );
        if (result?.systemPrompt !== undefined) current = result.systemPrompt;
      }
      return current;
    },
    emitInput: async (text, source) => {
      let current = { text, images: undefined };
      for (const handler of state.handlers.get("input") ?? []) {
        const result = await handler(
          { type: "input", text: current.text, images: current.images, source },
          ctx(),
        );
        if (result?.action === "handled") return { text: "", handled: true };
        if (result?.action === "transform") {
          current = { text: result.text, images: result.images ?? current.images };
        }
      }
      return { text: current.text, handled: false };
    },
  };
}

function makeHostApi(state) {
  const ctx = () => makeCtx(state);
  const emit = async (event, payload) => {
    let results = [];
    for (const handler of state.handlers.get(event) ?? []) {
      results = [...results, await handler(payload, ctx())];
    }
    return results;
  };

  return {
    ctx,
    commands: state.commands,
    tools: state.tools,
    registrations: state.registrations,
    entries: state.entries,
    messages: state.messages,
    statuses: state.statuses,
    notifications: state.notifications,
    execCalls: state.execCalls,
    activeTools: state.activeTools,
    lastEntry: (customType) => state.entries().filter((entry) => entry.customType === customType).at(-1),
    ...makeEmitters(state, ctx, emit),
  };
}

function createHost(cwd) {
  const state = makeHostState(cwd);
  return { pi: state.pi, ...makeHostApi(state) };
}

function prependPath(dir) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "PATH");
    else process.env.PATH = saved;
  };
}

function installHome(home) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = saved;
  };
}

function installEnvVar(name, value) {
  const saved = process.env[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = saved;
  };
}

function writeStubChild(root) {
  const path = join(root, "stub-child.mjs");
  writeFileSync(path, STUB_CHILD_SOURCE, "utf8");
  return path;
}

function installChildScript(stubPath) {
  const saved = process.argv[1];
  process.argv[1] = stubPath;
  return () => {
    if (saved === undefined) Reflect.deleteProperty(process.argv, 1);
    else process.argv[1] = saved;
  };
}

function installFakeGit(root) {
  const binDir = join(root, "fake-git-bin");
  mkdirSync(binDir, { recursive: true });
  const script = '#!/bin/sh\nif [ "$1" = "worktree" ] && [ "$2" = "add" ]; then mkdir -p "$5"; fi\nexit 0\n';
  writeFileSync(join(binDir, "git"), script, { mode: 0o755 });
  return prependPath(binDir);
}

function installFakeGh(root) {
  const binDir = join(root, "fake-gh-bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return prependPath(binDir);
}

function writeModelsConfig(cwd, roles) {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pstack-models.json"), `${JSON.stringify({ version: 1, roles }, null, 2)}\n`, "utf8");
}

function runGit(env, args) {
  execFileSync("git", args, {
    cwd: env.cwd,
    env: {
      ...process.env,
      HOME: env.tmp.home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Acceptance",
      GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Acceptance",
      GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
    },
    stdio: "ignore",
  });
}

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "pstack-acceptance-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { root, home, cwd };
}

function createScenarioEnv(tmp, report) {
  return {
    tmp,
    cwd: tmp.cwd,
    report,
    newHost() {
      const host = createHost(tmp.cwd);
      extensionEntry(host.pi);
      return host;
    },
  };
}

async function scenarioBugFix(env, host) {
  const report = env.report;
  await host.commands.get("poteto-mode").handler("fix this bug", host.ctx());
  const entry = host.lastEntry("pstack-poteto-mode");
  report.expectEqual("entry.enabled", entry?.data?.enabled, true);
  report.expectEqual("entry.playbook", entry?.data?.matchedPlaybookId, "bug-fix");
  report.expectEqual("entry.score", entry?.data?.matchedScore, 3);
  report.expectEqual("message", host.messages().at(-1)?.text, "/skill:poteto-mode playbooks/bug-fix fix this bug");
  const injected = await host.emitBeforeAgentStart("fix this bug", "SYS");
  report.expectIncludes("injected.bug-fix-id", injected, "force-invoke fallback → **bug-fix**");
  report.expectIncludes("injected.repro-step", injected, "Reproduce it yourself");
  report.expectIncludes("injected.bisect-step", injected, "Binary-search the cause");
  const before = host.entries().length;
  const extensionTurn = await host.emitInput(host.messages().at(-1)?.text ?? "", "extension");
  report.expectEqual("extension-turn.text", extensionTurn.text, "/skill:poteto-mode playbooks/bug-fix fix this bug");
  report.expectEqual("extension-turn.no-entry", host.entries().length, before);
  await host.emitSessionStart();
  report.expectEqual("restored.status", host.statuses().at(-1), ["pstack", "poteto:bug-fix"]);
  report.note("sticky=true id=bug-fix score=3 msg=/skill:poteto-mode playbooks/bug-fix fix this bug injected=bug-fix.md steps restored=poteto:bug-fix");
}

async function scenarioHow(env, host) {
  const report = env.report;
  await host.commands.get("how").handler("does this subsystem work?");
  report.expectEqual("how-message", host.messages().at(-1)?.text, "/skill:how does this subsystem work?");
  const turn = await host.emitInput("how does this subsystem work?", "interactive");
  report.expectEqual("transform", turn.text, "/skill:poteto-mode playbooks/investigation how does this subsystem work?");
  const entry = host.lastEntry("pstack-poteto-mode");
  report.expectEqual("entry.playbook", entry?.data?.matchedPlaybookId, "investigation");
  report.expectEqual("entry.score", entry?.data?.matchedScore, 5);
  report.expectEqual("readonly.bash-removed", host.activeTools().includes("bash"), false);
  report.expectEqual("readonly.status", host.statuses().at(-1), ["pstack-ro", "readonly"]);
  const injected = await host.emitBeforeAgentStart("how does this subsystem work?", "SYS");
  report.expectIncludes("injected.how-shape", injected, "Overview / Key Concepts / How It Works / Where Things Live / Gotchas");
  report.expectIncludes("injected.how-route", injected, "Route through the **how** skill");
  report.expectIncludes("how-skill.shape", skillText("how"), "Overview, Key Concepts, How It Works, Where Things Live, Gotchas.");
  report.note("playbook=investigation score=5 readonly=on shape=Overview/Key Concepts/How It Works/Where Things Live/Gotchas");
}

async function scenarioWhy(env, host) {
  const report = env.report;
  await host.commands.get("why").handler("was this designed this way?");
  report.expectEqual("why-message", host.messages().at(-1)?.text, "/skill:why was this designed this way?");
  const turn = await host.emitInput("why was this designed this way?", "interactive");
  report.expectEqual("transform", turn.text, "/skill:poteto-mode playbooks/investigation why was this designed this way?");
  const entry = host.lastEntry("pstack-poteto-mode");
  report.expectEqual("entry.playbook", entry?.data?.matchedPlaybookId, "investigation");
  const injected = await host.emitBeforeAgentStart("why was this designed this way?", "SYS");
  report.expectIncludes("injected.why-route", injected, "For motivation questions, also route through the **why** skill");
  const sections = [
    "The Question", "The Code in Question", "What We Found", "What We Can Reasonably Infer",
    "Competing Hypotheses", "What We Don't Know", "Sources Consulted", "Confidence Summary",
  ];
  for (const section of sections) report.expectIncludes(`why-skill.${section}`, skillText("why"), section);
  report.note(`playbook=investigation why-route=on why-sections=${sections.length}`);
}

async function scenarioArchitect(env, host) {
  const report = env.report;
  await host.commands.get("architect").handler("this before coding");
  report.expectEqual("architect-message", host.messages().at(-1)?.text, "/skill:architect this before coding");
  report.expectIncludes("architect.phase-b-arena", skillText("architect"), "Run the **arena** skill");
  report.expectIncludes("architect.panel-role", skillText("architect"), "architect runners");
  const panel = ["stub/arch-a", "stub/arch-b", "stub/arch-c"];
  writeModelsConfig(env.cwd, { "architect runners": panel, "arena runners": panel });
  report.expectEqual("config.panel", loadModelsConfig(env.cwd)?.roles?.["architect runners"], panel);
  report.expectEqual("default-panel.length", defaultModelsConfig().roles["architect runners"].length, 4);
  const candidates = panel.map((_model, index) => ({ label: `design-${index + 1}` }));
  const prompt = "Sketch the module boundary before coding";
  const outcome = await host.tools.get("pstack_arena").execute("a", { prompt, candidates }, undefined, undefined, host.ctx());
  const results = outcome.details.results;
  const models = results.map((result) => result.result.model);
  report.expectEqual("candidates", results.length, panel.length);
  report.expectEqual("candidate-models", models, panel);
  report.expectEqual("distinct-cwds", new Set(results.map((result) => result.cwd)).size, 3);
  report.note(`panel=${panel.length} models=${models.join(",")} distinct-cwds=3 default-panel=4`);
}

async function scenarioArena(env, host) {
  const report = env.report;
  await host.commands.get("arena").handler("solve this three ways");
  report.expectEqual("arena-message", host.messages().at(-1)?.text, "/skill:arena solve this three ways");
  const candidates = [
    { label: "alpha", model: "stub/alpha", outputPath: "artifact-alpha.md" },
    { label: "beta", model: "stub/beta", outputPath: "artifact-beta.md" },
    { label: "gamma", model: "stub/gamma", outputPath: "artifact-gamma.md" },
  ];
  const params = { prompt: "Solve the shared design problem", candidates, crossJudge: true, judgeModel: "stub/cross-judge", rubric: "Prefer the smallest diff" };
  const outcome = await host.tools.get("pstack_arena").execute("a", params, undefined, undefined, host.ctx());
  const results = outcome.details.results;
  report.expectEqual("candidates", results.length, 3);
  report.expectEqual("labels", results.map((result) => result.label), ["alpha", "beta", "gamma"]);
  report.expectEqual("distinct-cwds", new Set(results.map((result) => result.cwd)).size, 3);
  report.expectEqual("distinct-output-paths", new Set(results.map((result) => result.outputPath)).size, 3);
  const text = outcome.content[0].text;
  report.expectEqual("judge-sections", text.split("## Cross-judge (").length - 1, 1);
  const judgeIndex = text.indexOf("## Cross-judge (stub/cross-judge)");
  report.expect("judge.after-candidates", judgeIndex > text.indexOf("### gamma"));
  const judgeSection = judgeIndex >= 0 ? text.slice(judgeIndex) : "";
  for (const label of ["alpha", "beta", "gamma"]) {
    report.expectIncludes(`judge.saw-${label}`, judgeSection, `### ${label} (stub/${label})`);
  }
  report.note("candidates=3 labels=alpha,beta,gamma distinct=cwds:3,paths:3 judges=1 judge-saw=3");
}

async function scenarioSwarm(env, host) {
  const report = env.report;
  await host.commands.get("swarm").handler("investigate these packages in parallel");
  report.expectEqual("swarm-message", host.messages().at(-1)?.text, "/skill:swarm investigate these packages in parallel");
  const packages = ["pi-ai", "pi-agent-core", "pi-coding-agent"];
  const workers = packages.map((name) => ({ task: `Investigate package ${name} and report PASS/ISSUES/BLOCKED` }));
  const outcome = await host.tools.get("pstack_swarm").execute("s", { workers, selection: "coverage" }, undefined, undefined, host.ctx());
  const results = outcome.details.results;
  report.expectEqual("workers", results.length, packages.length);
  report.expectEqual("distinct-cwds", new Set(results.map((result) => result.cwd)).size, 3);
  const outside = results.filter((result) => !result.cwd.startsWith(join(env.cwd, ".pstack-worktrees")));
  report.expectEqual("all-isolated", outside.length, 0);
  for (const [index, name] of packages.entries()) {
    report.expectIncludes(`worker.${name}`, results[index]?.output, `package ${name}`);
  }
  report.expectIncludes("report.header", outcome.content[0].text, "## Swarm report (coverage)");
  report.note(`workers=3 packages=${packages.join(",")} distinct-cwds=3 root=.pstack-worktrees`);
}

async function scenarioInterrogate(env, host) {
  const report = env.report;
  await host.commands.get("interrogate").handler("this diff");
  report.expectEqual("interrogate-message", host.messages().at(-1)?.text, "/skill:interrogate this diff");
  report.expectIncludes("interrogate.one-per-model", skillText("interrogate"), "Spawn one reviewer per configured model");
  report.expectIncludes("interrogate.readonly-true", skillText("interrogate"), "`readonly`: `true`");
  const reviewers = ["stub/rev-a", "stub/rev-b", "stub/rev-c"];
  writeModelsConfig(env.cwd, { "interrogate reviewers": reviewers });
  report.expectEqual("configured-reviewers", loadModelsConfig(env.cwd)?.roles?.["interrogate reviewers"], reviewers);
  const spawn = host.tools.get("pstack_spawn");
  let observed = [];
  for (const [index, model] of reviewers.entries()) {
    const params = { task: `Adversarially review the diff (reviewer ${index + 1})`, model, readonly: true, background: false };
    const outcome = await spawn.execute(`r${index}`, params, undefined, undefined, host.ctx());
    observed = [...observed, outcome.details.result];
  }
  report.expectEqual("reviewer-count", observed.length, reviewers.length);
  report.expectEqual("reviewer-models", observed.map((result) => result.model), reviewers);
  for (const [index, result] of observed.entries()) {
    report.expectIncludes(`reviewer.${index + 1}.readonly-argv`, result.output, "stub-child tools=read,grep,find,ls");
  }
  const labels = reviewers.map((_model, index) => `Reviewer ${String.fromCharCode(65 + index)}`);
  const judgeParams = { prompt: "Adversarially review the diff", candidates: reviewers.map((model, index) => ({ label: labels[index], model })), crossJudge: true, judgeModel: "stub/rev-judge" };
  const judged = await host.tools.get("pstack_arena").execute("j", judgeParams, undefined, undefined, host.ctx());
  const text = judged.content[0].text;
  const judgeIndex = text.indexOf("## Cross-judge (stub/rev-judge)");
  const judgeSection = judgeIndex >= 0 ? text.slice(judgeIndex) : "";
  for (const label of labels) report.expectIncludes(`judge.saw-${label}`, judgeSection, `### ${label} (`);
  report.note(`reviewers=3 models=${reviewers.join(",")} readonly-argv=--tools-read,grep,find,ls judge=received:3`);
}

async function scenarioTdd(env, host) {
  const report = env.report;
  await host.commands.get("tdd").handler("implement this");
  report.expectEqual("tdd-message", host.messages().at(-1)?.text, "/skill:tdd implement this");
  const stages = [
    "Understand the bug", "Choose the narrowest executable check", "Write the failing test first",
    "Run the new test before fixing", "Fix the bug", "Rerun the regression test", "Run nearby validation",
  ];
  for (const stage of stages) report.expectIncludes(`tdd-stage.${stage}`, skillText("tdd"), stage);
  const sticky = matchPlaybook("implement this");
  report.expectEqual("sticky-match.id", sticky?.id, "feature");
  report.expectEqual("sticky-match.score", sticky?.score, 2);
  report.note(`skill=tdd stages=${stages.length} sticky-match=feature/2`);
}

async function scenarioAutonomousRun(env, host) {
  const report = env.report;
  const loop = host.tools.get("pstack_loop");
  const params = { action: "arm", mode: "dynamic", prompt: FINISH_CONDITION, maxFires: 1, intervalSeconds: 30, watchArgv: ["acceptance-watch", "finish-condition"] };
  const armed = await loop.execute("l", params, undefined, undefined, host.ctx());
  report.expectIncludes("loop.arm.mode", armed.content[0].text, "mode=dynamic");
  report.expectIncludes("loop.arm.watcher", armed.content[0].text, "watcher=on");
  await flush();
  await flush();
  const fired = host.messages().at(-1)?.text ?? "";
  report.expectIncludes("loop.fire.reason", fired, "reason=watcher");
  report.expectIncludes("loop.fire.prompt", fired, FINISH_CONDITION);
  report.expectEqual("loop.watch-argv", host.execCalls().at(-1)?.args, ["finish-condition"]);
  await host.commands.get("poteto-mode").handler("run this autonomously until the finish condition passes", host.ctx());
  const paraphrase = host.lastEntry("pstack-poteto-mode")?.data;
  report.expectEqual("entry.enabled", paraphrase?.enabled, true);
  report.expectEqual("entry.playbook", paraphrase?.matchedPlaybookId, "autonomous-run");
  await host.commands.get("poteto-mode").handler("run until done", host.ctx());
  const canonical = host.lastEntry("pstack-poteto-mode")?.data;
  report.expectEqual("canonical-playbook", canonical?.matchedPlaybookId, "autonomous-run");
  report.note(`loop=dynamic maxFires=1 fired=reason=watcher prompt=finish-condition canonical-cue=run-until-done`);
}

const DECISION_ROW = {
  phase: "acceptance",
  decision: "ship the acceptance harness",
  why: "one runnable definition-of-done for the Pi port",
  evidence: "tests/acceptance/run.mjs",
  result: "row appended",
};

async function scenarioDecisionLog(env, host) {
  const report = env.report;
  await host.commands.get("show-me-your-work").handler("");
  report.expectEqual("command-message", host.messages().at(-1)?.text, "/skill:show-me-your-work");
  const outcome = await host.tools.get("pstack_decision_log").execute("d", { ...DECISION_ROW }, undefined, undefined, host.ctx());
  const path = join(env.cwd, ".pi", "decisions.tsv");
  report.expectEqual("result.text", outcome.content[0].text, `Logged decision to ${path}`);
  const rows = readText(path).trimEnd().split("\n");
  report.expectEqual("file.header", rows[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
  const fields = rows[1]?.split("\t") ?? [];
  report.expectEqual("row.columns", fields.length, 6);
  report.expectEqual("row.phase", fields[1], DECISION_ROW.phase);
  report.expectEqual("row.decision", fields[2], DECISION_ROW.decision);
  report.expectEqual("row.why", fields[3], DECISION_ROW.why);
  report.expectEqual("row.evidence", fields[4], DECISION_ROW.evidence);
  report.expectEqual("row.result", fields[5], DECISION_ROW.result);
  const ts = fields[0] ?? "";
  report.expect("row.ts.iso", ts.length > 0 && new Date(ts).toISOString() === ts);
  report.expectEqual("entry.type", host.entries().at(-1)?.customType, "pstack-decision");
  report.note(`rows=1 columns=6 phase=acceptance ts=${ts}`);
}

async function scenarioRecall(env, host) {
  const report = env.report;
  await host.commands.get("recall").handler("this topic");
  report.expectEqual("recall-message", host.messages().at(-1)?.text, "/skill:recall this topic");
  const marker = "acceptance-recall-marker";
  const sessionPath = join(env.cwd, ".pi", "sessions", "acceptance-recall.jsonl");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify({ role: "user", content: `recall ${marker} from the transcript` })}\n`, "utf8");
  runGit(env, ["init", "-q"]);
  runGit(env, ["commit", "--allow-empty", "-q", "-m", `docs: ${marker} fixture commit`]);
  const params = { action: "recall", query: marker, limit: 5, days: 7 };
  const outcome = await host.tools.get("pstack_sessions").execute("s", params, undefined, undefined, host.ctx());
  const details = outcome.details;
  report.expectEqual("corpus", details.corpus, ["sessions", "git-log", "gh-prs", "ranked-merge"]);
  report.expect("ranked-hits.at-least-1", details.rankedHits >= 1);
  report.expectEqual("top.source", details.top?.[0]?.source, "session");
  report.expect("top.has-git", (details.top ?? []).some((hit) => hit.source === "git"));
  const body = outcome.content[0].text;
  report.expectIncludes("body.header", body, "## Recall corpus (local, ranked)");
  report.expectIncludes("body.query", body, `query=${marker} days=7`);
  report.expectIncludes("body.gh-offline", body, "(gh not available — skipped PR corpus)");
  report.note(`corpus=sessions,git-log,gh-prs,ranked-merge hits=${details.rankedHits} top=${details.top?.[0]?.source} gh=skipped-offline`);
}

async function scenarioCommandSurface(env) {
  const report = env.report;
  const names = SCENARIO_NAMES;
  const first = env.newHost();
  await first.emitSessionStart();
  const all = first.registrations();
  for (const name of names) {
    report.expectEqual(`registered-once.${name}`, all.filter((entry) => entry === name).length, 1);
  }
  const globalDups = [...new Set(all.filter((name, index) => all.indexOf(name) !== index))];
  report.expectEqual("scenario-names.duplicates", globalDups.filter((name) => names.includes(name)), []);
  await first.commands.get("poteto-mode").handler("fix this bug", first.ctx());
  const potetoMessage = first.messages().at(-1)?.text;
  const potetoEntry = first.lastEntry("pstack-poteto-mode")?.data;
  const second = env.newHost();
  await second.emitSessionStart();
  await second.commands.get("pstack").handler("fix this bug", second.ctx());
  const pstackMessage = second.messages().at(-1)?.text;
  const pstackEntry = second.lastEntry("pstack-poteto-mode")?.data;
  report.expectEqual("alias.message-equal", pstackMessage, potetoMessage);
  report.expectEqual("alias.message", pstackMessage, "/skill:poteto-mode playbooks/bug-fix fix this bug");
  report.expectEqual("alias.playbook-equal", pstackEntry?.matchedPlaybookId, potetoEntry?.matchedPlaybookId);
  report.expectEqual("alias.playbook", pstackEntry?.matchedPlaybookId, "bug-fix");
  report.expectEqual("alias.score-equal", pstackEntry?.matchedScore, potetoEntry?.matchedScore);
  await first.commands.get("setup-pstack").handler("", first.ctx());
  const configPath = join(env.tmp.home, ".pi", "agent", "pstack-models.json");
  const written = existsSync(configPath) ? JSON.parse(readText(configPath)) : undefined;
  report.expectEqual("setup-pstack.rich-handler", written?.roles?.["arena runners"]?.length, 4);
  const dupNote = globalDups.length === 0 ? "none" : `${globalDups.join(",")}(effective=models-handler)`;
  report.note(`slash-names=${names.length}-each-once alias=pstack→poteto-mode msg=/skill:poteto-mode playbooks/bug-fix fix this bug global-dups=${dupNote}`);
}

const SCENARIOS = [
  { n: 0, command: "command-surface", playbook: "-", run: scenarioCommandSurface },
  { n: 1, command: "/poteto-mode", playbook: "bug-fix", run: scenarioBugFix },
  { n: 2, command: "/how", playbook: "investigation", run: scenarioHow },
  { n: 3, command: "/why", playbook: "investigation", run: scenarioWhy },
  { n: 4, command: "/architect", playbook: "architect", fakeGit: true, run: scenarioArchitect },
  { n: 5, command: "/arena", playbook: "arena", fakeGit: true, run: scenarioArena },
  { n: 6, command: "/swarm", playbook: "swarm", fakeGit: true, run: scenarioSwarm },
  { n: 7, command: "/interrogate", playbook: "interrogate", fakeGit: true, run: scenarioInterrogate },
  { n: 8, command: "/tdd", playbook: "tdd", run: scenarioTdd },
  { n: 9, command: "/poteto-mode", playbook: "autonomous-run", run: scenarioAutonomousRun },
  { n: 10, command: "/show-me-your-work", playbook: "show-me-your-work", run: scenarioDecisionLog },
  { n: 11, command: "/recall", playbook: "recall", fakeGh: true, run: scenarioRecall },
];

async function runScenario(descriptor) {
  const tmp = makeTempRoot();
  const restores = [
    installHome(tmp.home),
    installEnvVar("PSTACK_CHILD_ROLE", undefined),
    installChildScript(writeStubChild(tmp.root)),
    ...(descriptor.fakeGit ? [installFakeGit(tmp.root)] : []),
    ...(descriptor.fakeGh ? [installFakeGh(tmp.root)] : []),
  ];
  const report = createReport();
  try {
    const env = createScenarioEnv(tmp, report);
    const host = env.newHost();
    await host.emitSessionStart();
    try {
      await descriptor.run(env, host);
    } catch (error) {
      report.record(`threw:[${error instanceof Error ? error.message : String(error)}]`);
    }
    return { ...descriptor, notes: report.notes(), failures: report.failures(), failed: report.failed() };
  } finally {
    for (const restore of restores.toReversed()) restore();
    rmSync(tmp.root, { recursive: true, force: true });
  }
}

function formatRow(row) {
  const notes = row.notes.join(" ");
  const assertion = row.failed ? `${notes} failed:[${row.failures.join(" | ")}]` : notes;
  return `scenario=${row.n} command=${row.command} playbook=${row.playbook} assertion=${assertion} ${row.failed ? "FAIL" : "PASS"}`;
}

async function main() {
  extensionEntry = (await import(pathToFileURL(join(ROOT, "extensions", "index.ts")).href)).default;
  let rows = [];
  for (const descriptor of SCENARIOS) {
    rows = [...rows, await runScenario(descriptor)];
  }
  const passed = rows.filter((row) => !row.failed).length;
  process.stdout.write(`${rows.map(formatRow).join("\n")}\n`);
  process.stdout.write(`acceptance: scenarios=${rows.length} passed=${passed} failed=${rows.length - passed} assertions=${assertionCount}\n`);
  process.exit(rows.some((row) => row.failed) ? 1 : 0);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`harness error: ${message}\n`);
  process.exit(2);
});
