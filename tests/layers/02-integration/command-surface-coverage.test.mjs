import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSession } from "../../support/session.mjs";
import {
  PI_ONLY_COMMANDS,
  registerPiOnlyCommands,
  registerSkillCommands,
} from "../../../extensions/commands/skill-commands.ts";
import { registerBenny } from "../../../extensions/benny/index.ts";
import { registerCompanions } from "../../../extensions/companions/index.ts";
import { armProgrammaticLoop, registerHeartbeat, stopProgrammaticLoop } from "../../../extensions/heartbeat/index.ts";
import { registerIntegrations } from "../../../extensions/integrations/index.ts";

const SKILL_SOURCES = {
  alpha: "---\nname: alpha\ndescription: Alpha skill\nicon: A\ncolor: blue\n---\nbody\n",
  beta: "---\nname: beta\ndescription: Beta skill\ncolor: not-a-token\n---\nbody\n",
  plain: '---\nname: plain\ndescription: ""\n---\nbody\n',
  nodesc: "---\nname: nodesc\n---\nbody\n",
  "reserved-one": "---\nname: reserved-one\ndescription: reserved\n---\nbody\n",
  "shadow-one": "---\nname: shadow-one\ndescription: shadowed\n---\nbody\n",
  "dupe-a": "---\nname: dup\ndescription: first\n---\nbody\n",
  "dupe-b": "---\nname: dup\ndescription: second\n---\nbody\n",
  "no-name": "---\ndescription: nameless\n---\nbody\n",
};

function makeSkillsDir(sources) {
  const root = mkdtempSync(join(tmpdir(), "pstack-skills-"));
  for (const [dir, contents] of Object.entries(sources)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "SKILL.md"), contents, "utf8");
  }
  mkdirSync(join(root, "no-skillmd"), { recursive: true });
  return root;
}

function commandOf(f, name) {
  for (const ext of f.session.resourceLoader.getExtensions().extensions) {
    if (ext.commands?.has(name)) return ext.commands.get(name);
  }
  return undefined;
}

function forwardedTexts(f) {
  let texts = [];
  for (const event of f.events) {
    if (event.type === "queue_update" && Array.isArray(event.followUp)) texts = [...texts, ...event.followUp];
    if (event.type === "message_end" && event.message?.role === "user") {
      texts = [...texts, event.message.content.map((part) => part.text).join("")];
    }
  }
  return texts;
}

function seedResponses(f, count) {
  f.faux.setResponses(Array.from({ length: count }, () => f.faux.assistant("ok")));
}

function statusRecorder(theme) {
  let statuses = [];
  return {
    ctx: {
      ui: {
        setStatus: (key, value) => {
          statuses = [...statuses, [key, value]];
        },
        ...(theme ? { theme } : {}),
      },
    },
    all: () => statuses,
  };
}

function toolExecutor(f, name) {
  const tool = f.tool(name);
  expect(tool, `${name} is registered`).toBeTruthy();
  const ctx = f.session._extensionRunner.createContext();
  return (params) => tool.definition.execute(name, params, undefined, undefined, ctx);
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

function initRepo(cwd) {
  const git = (args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(["init", "-q"]);
  writeFileSync(join(cwd, "app.ts"), "export const one = 1;\n", "utf8");
  git(["add", "-A"]);
  git(["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-q", "-m", "base"]);
}

test("programmatic loop controls require a registered heartbeat runtime", () => {
  expect(() => armProgrammaticLoop({ id: "ghost", prompt: "p" })).toThrow(
    "armProgrammaticLoop requires a registered heartbeat runtime; call registerHeartbeat first",
  );
  expect(stopProgrammaticLoop("ghost")).toBe(false);
});

test("skill commands register real skills and skip reserved and shadowed names", async () => {
  await withSession(
    async (f) => {
      const names = f.session.resourceLoader.getExtensions().extensions.flatMap((ext) => [...ext.commands.keys()]);
      expect(names.includes("recall"), `recall missing from ${JSON.stringify(names)}`).toBe(true);
      expect(names.includes("unslop")).toBe(true);
      expect(names.includes("poteto-mode"), "the reserved skill must not be re-registered").toBe(false);
      expect(names.includes("setup-pstack"), "the shadowed skill must not be re-registered").toBe(false);

      seedResponses(f, 8);
      await f.prompt("/recall topic one");
      expect(forwardedTexts(f).at(-1)).toBe("/skill:recall topic one");
      await f.prompt("/recall   padded   ");
      expect(forwardedTexts(f).at(-1)).toBe("/skill:recall padded");
      await f.prompt("/recall");
      expect(forwardedTexts(f).at(-1)).toBe("/skill:recall");

      expect(commandOf(f, "babysit").description).toBe("Babysit a PR to green");
      await f.prompt("/babysit topic 7");
      expect(forwardedTexts(f).at(-1)).toBe(`${PI_ONLY_COMMANDS[0].body} topic 7`);
      await f.prompt("/babysit");
      expect(forwardedTexts(f).at(-1)).toBe(PI_ONLY_COMMANDS[0].body);
      await f.prompt("/ship");
      expect(forwardedTexts(f).at(-1)).toBe(PI_ONLY_COMMANDS[1].body);
    },
    {
      extensionPaths: [],
      extensionFactories: [
        (pi) => {
          registerSkillCommands(pi);
          registerPiOnlyCommands(pi);
        },
      ],
    },
  );
});

test("skill commands honor a custom directory and skip nameless, missing, and duplicate entries", async () => {
  const skillsDir = makeSkillsDir(SKILL_SOURCES);
  try {
    await withSession(
      async (f) => {
        const names = f.session.resourceLoader.getExtensions().extensions.flatMap((ext) => [...ext.commands.keys()]);
        expect(names.toSorted()).toEqual(["alpha", "beta", "custom-probe", "dup", "nodesc", "plain"]);

        seedResponses(f, 6);
        await f.prompt("/plain x");
        expect(forwardedTexts(f).at(-1)).toBe("/skill:plain x");
        await f.prompt("/custom-probe arg");
        expect(forwardedTexts(f).at(-1)).toBe("CUSTOM BODY arg");
        await f.prompt("/custom-probe");
        expect(forwardedTexts(f).at(-1)).toBe("CUSTOM BODY");
      },
      {
        extensionPaths: [],
        extensionFactories: [
          (pi) => registerSkillCommands(pi, { skillsDir, reserved: ["reserved-one"], shadowed: ["shadow-one"] }),
          (pi) => registerSkillCommands(pi, { skillsDir: join(skillsDir, "absent") }),
          (pi) =>
            registerPiOnlyCommands(pi, [{ name: "custom-probe", description: "custom", body: "CUSTOM BODY" }]),
        ],
      },
    );
  } finally {
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test("skill command handlers render declared chrome and forward trimmed args", async () => {
  const skillsDir = makeSkillsDir(SKILL_SOURCES);
  try {
    await withSession(
      async (f) => {
        const alpha = commandOf(f, "alpha");
        const beta = commandOf(f, "beta");
        const themed = statusRecorder({ fg: (token, text) => `<${token}:${text}>` });
        seedResponses(f, 6);

        await alpha.handler("topic", themed.ctx);
        expect(themed.all().at(-1)).toEqual(["pstack-skill", "<accent:A alpha>"]);
        await f.prompt("/alpha topic");
        expect(forwardedTexts(f).at(-1)).toBe("/skill:alpha topic");
        await f.prompt("/alpha");
        expect(forwardedTexts(f).at(-1)).toBe("/skill:alpha");

        await beta.handler("", themed.ctx);
        expect(themed.all().at(-1)).toEqual(["pstack-skill", "beta"]);

        const plain = statusRecorder();
        await commandOf(f, "plain").handler("", plain.ctx);
        expect(plain.all().at(-1)).toEqual(["pstack-skill", "plain"]);

        await alpha.handler("topic", {});
        expect(themed.all().at(-1)).toEqual(["pstack-skill", "beta"]);

        rmSync(join(skillsDir, "alpha", "SKILL.md"));
        await alpha.handler("topic", themed.ctx);
        expect(themed.all().at(-1)).toEqual(["pstack-skill", undefined]);
      },
      { extensionPaths: [], extensionFactories: [(pi) => registerSkillCommands(pi, { skillsDir })] },
    );
  } finally {
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test("pstack_benny_wake appends, drains, and reports its wake file", async () => {
  const home = mkdtempSync(join(tmpdir(), "pstack-benny-home-"));
  const wakeFile = join(home, ".pi", "agent", "pstack-benny-wakes.jsonl");
  try {
    await withEnv({ HOME: home }, () =>
      withSession(
        async (f) => {
          const exec = toolExecutor(f, "pstack_benny_wake");
          const reported = await exec({ action: "path" });
          expect(reported.content[0].text).toBe(wakeFile);
          expect(reported.details).toEqual({ path: wakeFile });

          const appended = await exec({ action: "append", payload: '{"issue":7}', intent: "repro" });
          expect(appended.details).toEqual({ ok: true, path: wakeFile });
          const raw = await exec({ action: "append", payload: "not json" });
          expect(raw.details.ok).toBe(true);

          await expect(() => exec({ action: "append", payload: "   " })).rejects.toThrow(
            "pstack_benny_wake append requires a non-empty payload JSON string",
          );
          await expect(() => exec({ action: "append" })).rejects.toThrow(
            "pstack_benny_wake append requires a non-empty payload JSON string",
          );

          const drained = await exec({ action: "drain" });
          expect(drained.details).toEqual({ count: 2, path: wakeFile });
          expect(drained.content[0].text).toMatch(
            /^Drained 2 wake\(s\):\n\{"ts":".+","intent":"repro","payload":\{"issue":7\}\}\n\{"ts":".+","intent":"triage","payload":"not json"\}$/,
          );

          const empty = await exec({ action: "drain" });
          expect(empty.content[0].text).toBe("No pending Benny wakes.");
          expect(empty.details).toEqual({ count: 0, path: wakeFile });

          await exec({ action: "append", payload: JSON.stringify("x".repeat(60000)) });
          const capped = await exec({ action: "drain" });
          expect(capped.details.count).toBe(1);
          expect(capped.details.fullOutputPath).toMatch(/pstack-benny-wakes-.+\.txt$/);
          expect(capped.content[0].text).toMatch(/\[Output truncated:/);
        },
        { extensionPaths: [], extensionFactories: [(pi) => registerBenny(pi)] },
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("benny commands forward their skill path and optional context", async () => {
  const home = mkdtempSync(join(tmpdir(), "pstack-benny-home-"));
  try {
    await withEnv({ HOME: home }, () =>
      withSession(
        async (f) => {
          seedResponses(f, 8);
          await f.prompt("/setup-benny");
          expect(forwardedTexts(f).at(-1)).toMatch(
            /^Read and follow .*setup-benny\/SKILL\.md\. Retarget paths to \.pi\/automations\/benny and \.pi\/benny\. Do not use Cursor Automations host APIs\.$/,
          );

          await f.prompt("/benny-triage slack payload");
          expect(forwardedTexts(f).at(-1)).toMatch(
            /^Read and follow .*triage-issue-reports\/SKILL\.md\. Context: slack payload$/,
          );
          await f.prompt("/benny-triage");
          expect(forwardedTexts(f).at(-1)).toMatch(
            /^Read and follow .*triage-issue-reports\/SKILL\.md\. Await the next Slack\/tracker issue payload from pstack_benny_wake or chat\.$/,
          );

          await f.prompt("/benny-repro issue 42");
          expect(forwardedTexts(f).at(-1)).toMatch(
            /^Read and follow .*reproduce-and-fix-issues\/SKILL\.md\. Use pstack_control_cli \/ pstack_control_ui for the control adapter\. Issue: issue 42$/,
          );
          await f.prompt("/benny-repro");
          expect(forwardedTexts(f).at(-1)).toMatch(/control adapter\. $/);
        },
        { extensionPaths: [], extensionFactories: [(pi) => registerBenny(pi)] },
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

async function driveLoopTool(exec) {
  const empty = await exec({ action: "status" });
  expect(empty.content[0].text).toBe("(no active loops)");
  expect(empty.details).toEqual({ loops: [], action: "status" });
  expect((await exec({ action: "list" })).details).toEqual({ loops: [], action: "list" });

  const interval = await exec({ action: "arm", prompt: "check the build" });
  expect(interval.details).toEqual({ id: "loop-1", mode: "interval", coalesceMs: 2500 });
  expect(interval.content[0].text).toBe("Armed loop-1 mode=interval intervalSeconds=1800 maxFires=50 coalesceMs=2500");
  expect((await exec({ action: "status" })).content[0].text).toBe(
    "loop-1 mode=interval fires=0/50 armed=true lastReason=-",
  );

  const watcher = await exec({
    action: "arm",
    id: "watch",
    prompt: "watch the queue",
    mode: "watcher",
    intervalSeconds: 5,
    maxFires: 1,
    watchArgv: ["git", "status", "--short"],
  });
  expect(watcher.content[0].text).toBe(
    "Armed watch mode=watcher intervalSeconds=5 maxFires=1 watcher=on coalesceMs=2500",
  );
}

async function driveLoopModes(exec) {
  const settle = await exec({ action: "arm", id: "settle", prompt: "s", mode: "settle", intervalSeconds: 5 });
  expect(settle.details.mode).toBe("settle");
  const dynamic = await exec({
    action: "arm",
    id: "dyn",
    prompt: "d",
    mode: "dynamic",
    intervalSeconds: 5,
    maxFires: 1,
    watchArgv: ["git", "status"],
  });
  expect(dynamic.details.mode).toBe("dynamic");

  expect((await exec({ action: "stop", id: "watch" })).content[0].text).toBe("stopped");
  expect((await exec({ action: "stop", id: "ghost" })).content[0].text).toBe("stopped");
  await expect(() => exec({ action: "explode" })).rejects.toThrow("action must be arm|stop|status|list");
  expect((await exec({ action: "stop" })).content[0].text).toBe("stopped");
  expect((await exec({ action: "status" })).content[0].text).toBe("(no active loops)");
}

async function driveLoopCommand(f, exec) {
  const command = commandOf(f, "pstack-loop");
  const ctx = f.session._extensionRunner.createContext();
  await command.handler("status", ctx);
  expect(f.ui.notifications.at(-1)).toEqual(["info", "(no active loops)"]);
  await command.handler("stop", ctx);
  expect(f.ui.notifications.at(-1)).toEqual(["info", "All pstack loops stopped."]);
  await command.handler("off", ctx);
  await command.handler("5 probe every five", ctx);
  expect((await exec({ action: "status" })).details.loops.at(-1)).toBe("loop-2");
  await command.handler("list", ctx);
  expect(f.ui.notifications.at(-1)).toEqual(["info", "loop-2 mode=interval fires=0/100 armed=true lastReason=-"]);
  await command.handler("stop loop-2", ctx);
  expect(f.ui.notifications.at(-1)).toEqual(["info", "Stopped loop-2"]);
  expect(f.ui.statuses.at(-1)).toEqual(["pstack-loop", undefined]);
  await command.handler("stop loop-99", ctx);
  expect(f.ui.notifications.at(-1)).toEqual(["info", "No loop loop-99"]);
  await command.handler("nonsense", ctx);
  expect(f.ui.notifications.at(-1)).toEqual([
    "error",
    "Usage: /pstack-loop <seconds> <prompt>  |  /pstack-loop status|list  |  /pstack-loop stop [id]  |  /pstack-loop off",
  ]);
  await command.handler("", ctx);
}

test("pstack_loop arms, reports, stops, and answers its slash command through the loaded extension", async () => {
  await withSession(
    async (f) => {
      const exec = toolExecutor(f, "pstack_loop");
      await driveLoopTool(exec);
      await driveLoopModes(exec);
      await driveLoopCommand(f, exec);
      expect(armProgrammaticLoop({ id: "prog", prompt: "p", intervalSeconds: 5 })).toBe("prog");
      expect(stopProgrammaticLoop("prog")).toBe(true);
      expect(stopProgrammaticLoop("ghost")).toBe(false);
    },
    { extensionPaths: [], extensionFactories: [(pi) => registerHeartbeat(pi)] },
  );
});

function writeIntegrationBin(binDir) {
  symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), join(binDir, "git"));
  writeFileSync(
    join(binDir, "emit-big"),
    [
      "#!/bin/sh",
      "i=0",
      'while [ "$i" -lt 3000 ]; do',
      '  printf \'padded output line %s for the integrations adapter cap\\n\' "$i"',
      "  i=$((i + 1))",
      "done",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
}

function writeIntegrationConfig(configPath) {
  writeFileSync(
    configPath,
    JSON.stringify({
      analytics: {
        adapter: "command",
        command: ["git", "status", "--porcelain", "--untracked-files=no"],
        description: "clean status",
      },
      observability: { adapter: "command", command: ["emit-big"], description: "big output" },
    }),
  );
}

const INTEGRATION_IDS = [
  "source-control",
  "issue-tracker",
  "long-form-docs",
  "team-chat",
  "observability",
  "error-tracking",
  "analytics",
  "browser-ui",
  "cli-tui",
];

async function probeInventory(exec, configPath) {
  const listed = await exec({ action: "list" });
  expect(listed.details.available, JSON.stringify(listed.details.categories)).toBe(5);
  expect(listed.details.total).toBe(9);
  expect(listed.details.config).toBe(configPath);
  expect(listed.details.categories.map((category) => category.id)).toEqual(INTEGRATION_IDS);
  expect(listed.details.categories.find((category) => category.id === "source-control").availability).toBe(
    "available-git-only",
  );
  expect(listed.details.categories.find((category) => category.id === "browser-ui").tool).toBe("pstack_control_ui");
  expect((await exec({ action: "status" })).details.action).toBe("status");
  expect((await exec({ action: "probe" })).details.action).toBe("probe");
  await expect(() => exec({ action: "explode" })).rejects.toThrow("action must be one of list, status, probe, query");
  await expect(() => exec({ action: "query" })).rejects.toThrow(/^capability must be one of /);
  await expect(() => exec({ action: "query", capability: "nope" })).rejects.toThrow(/^capability must be one of /);
}

async function probeGaps(exec, configPath) {
  const gap = await exec({ action: "query", capability: "team-chat" });
  expect(gap.details).toEqual({
    capability: "team-chat",
    availability: "unavailable",
    coverageGap: true,
    substituted: false,
    missing: `add a 'command' adapter for capability 'team-chat' to ${configPath}`,
  });
  expect(gap.content[0].text).toMatch(/^pstack_integrations coverage gap: capability 'team-chat' is unavailable\./);

  const pointer = await exec({ action: "query", capability: "browser-ui" });
  expect(pointer.details).toEqual({
    capability: "browser-ui",
    delegatedTo: "pstack_control_ui",
    executed: false,
    coverageGap: false,
  });
}

async function probeQueries(exec) {
  const log = await exec({ action: "query", capability: "source-control" });
  expect(log.details).toEqual({ capability: "source-control", plan: "log (git)", code: 0, coverageGap: false });
  expect(log.content[0].text).toMatch(/^source-control log \(git\): exit 0\n\n/);

  const prGap = await exec({ action: "query", capability: "source-control", query: "prs:anything" });
  expect(prGap.details.coverageGap).toBe(true);
  expect(prGap.details.missing).toMatch(/^gh is not on PATH/);

  const adapted = await exec({ action: "query", capability: "analytics" });
  expect(adapted.details).toEqual({ capability: "analytics", plan: "clean status", code: 0, coverageGap: false });
  expect(adapted.content[0].text).toBe("analytics clean status: exit 0\n\n(no output)");

  const capped = await exec({ action: "query", capability: "observability" });
  expect(capped.details.plan).toBe("big output");
  expect(capped.details.code).toBe(0);
  expect(capped.details.fullOutputPath).toMatch(/integrations-observability-.+\.txt$/);
  expect(capped.content[0].text).toMatch(/\[Output truncated:/);
}

test("pstack_integrations lists, probes, queries, and reports coverage gaps through the loaded extension", async () => {
  const binDir = mkdtempSync(join(tmpdir(), "pstack-integrations-bin-"));
  const configDir = mkdtempSync(join(tmpdir(), "pstack-integrations-config-"));
  const configPath = join(configDir, "integrations.json");
  try {
    mkdirSync(binDir, { recursive: true });
    writeIntegrationBin(binDir);
    writeIntegrationConfig(configPath);
    await withEnv({ PATH: binDir, PSTACK_INTEGRATIONS_DIR: configDir }, () =>
      withSession(
        async (f) => {
          initRepo(f.tmp.cwd);
          const exec = toolExecutor(f, "pstack_integrations");
          await probeInventory(exec, configPath);
          await probeGaps(exec, configPath);
          await probeQueries(exec);
        },
        { extensionPaths: [], extensionFactories: [(pi) => { registerCompanions(pi); registerIntegrations(pi); }] },
      ),
    );
  } finally {
    rmSync(binDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});
