import { expect, test } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallGhPrs, recallGitLog } from "../../../extensions/sessions/recall-corpus.ts";
import { hitsFromGitLog } from "../../../extensions/sessions/recall-rank.ts";
import { registerSessions } from "../../../extensions/sessions/index.ts";
import { registerModels } from "../../../extensions/models/index.ts";
import { withBudget } from "../../../extensions/models/budget.ts";
import { registerDecisionLog } from "../../../extensions/decision-log/index.ts";
import { withSession } from "../../support/session.mjs";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";
const SESSIONS_FACTORY = { extensionPaths: [], extensionFactories: [(pi) => registerSessions(pi)] };
const MODELS_FACTORY = { extensionPaths: [], extensionFactories: [(pi) => registerModels(pi)] };

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withPath(path, run) {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    return await run();
  } finally {
    process.env.PATH = previous;
  }
}

function withEnv(vars, run) {
  const saved = Object.entries(vars).map(([key, value]) => [key, process.env[key]]);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    });
}

function writeGh(dir, body) {
  const path = join(dir, "gh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function decisionHost(cwd) {
  const tools = new Map();
  let entries = [];
  const pi = {
    registerTool: (definition) => tools.set(definition.name, definition),
    appendEntry: (type, data) => {
      entries = [...entries, { type, data }];
    },
  };
  registerDecisionLog(pi);
  return { tool: tools.get("pstack_decision_log"), ctx: { cwd }, entries: () => entries };
}

function sessionTool(f, name, ctx = f.session._extensionRunner.createContext()) {
  const tool = f.tool(name);
  expect(tool, `${name} is registered`).toBeTruthy();
  return {
    tool,
    call: (params, override) => tool.definition.execute(name, params, undefined, undefined, override ?? ctx),
  };
}

function seedSessionCorpus(cwd) {
  const root = join(cwd, ".pi", "sessions");
  const nested = join(root, "nested");
  const deep = join(root, "deep", "one", "two", "three");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(deep, "four"), { recursive: true });
  const files = {
    alpha: join(root, "alpha.jsonl"),
    beta: join(root, "beta.json"),
    gamma: join(nested, "gamma.jsonl"),
    atFour: join(deep, "atfour.jsonl"),
    buried: join(deep, "four", "buried.jsonl"),
  };
  writeFileSync(files.alpha, '{"text":"needle alpha"}\n');
  writeFileSync(files.beta, '{"text":"plain beta"}\n');
  writeFileSync(files.gamma, '{"text":"gamma needle"}\n');
  writeFileSync(files.atFour, '{"text":"at depth four"}\n');
  writeFileSync(files.buried, '{"text":"buried needle"}\n');
  writeFileSync(join(root, "notes.txt"), "not a session\n");
  return { root, ...files };
}

function stampTimes(paths) {
  const base = Date.now() - 60_000;
  paths.forEach((path, index) => {
    const time = new Date(base + index * 1000);
    utimesSync(path, time, time);
  });
}

function modelsCommand(f) {
  for (const ext of f.session.resourceLoader.getExtensions().extensions) {
    if (ext.commands?.has("setup-pstack")) return ext.commands.get("setup-pstack");
  }
  throw new Error("setup-pstack command not registered");
}

function beforeAgentHandlers(f) {
  return f.session.resourceLoader.getExtensions().extensions.flatMap((ext) => {
    const registered = ext.handlers?.get?.("before_agent_start");
    return registered ? [...registered] : [];
  });
}

function setupContext(cwd, options) {
  const calls = { selects: [], confirms: [], notices: [] };
  return {
    cwd,
    hasUI: options.hasUI,
    isProjectTrusted: () => options.trusted,
    ui: {
      select: async (title) => {
        calls.selects = [...calls.selects, title];
        return options.budget;
      },
      confirm: async (title, message) => {
        calls.confirms = [...calls.confirms, { title, message }];
        return options.accept;
      },
      notify: (message, level) => {
        calls.notices = [...calls.notices, [level ?? "info", message]];
      },
    },
    calls,
  };
}

function writeProjectRoles(cwd, roles) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pstack-models.json"), `${JSON.stringify({ version: 1, roles }, null, 2)}\n`);
}

test("recall git corpus fails soft outside a repository", async () => {
  const dir = tempDir("pstack-recall-git-");
  try {
    const text = await recallGitLog(dir, "anything");
    expect(text.startsWith("git log unavailable:"), `expected the git failure line, saw: ${text}`).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall gh corpus renders the parsed pr rows", async () => {
  const dir = tempDir("pstack-recall-gh-");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeGh(
    bin,
    [
      'if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; exit 0; fi',
      'echo \'[{"number":12,"state":"MERGED","title":"fix the thing","updatedAt":"2026-01-02T03:04:05Z","url":"https://example.test/pr/12","headRefName":"fix/thing"}]\'',
    ].join("\n"),
  );
  try {
    const text = await withPath(bin, () => recallGhPrs(dir, "topic"));
    expect(text).toBe("#12 [MERGED] fix the thing (fix/thing) 2026-01-02T03:04:05Z https://example.test/pr/12");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall gh corpus fails soft when the pr query fails", async () => {
  const dir = tempDir("pstack-recall-ghfail-");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeGh(
    bin,
    ['if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; exit 0; fi', 'echo "not logged in" >&2', "exit 1"].join("\n"),
  );
  try {
    const text = await withPath(bin, () => recallGhPrs(dir, "topic"));
    expect(text.startsWith("gh pr list failed:"), `expected the gh failure line, saw: ${text}`).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall ranking treats unavailable corpora as empty", () => {
  expect(hitsFromGitLog("git log unavailable: boom", "anything")).toEqual([]);
  expect(hitsFromGitLog("(no git log hits)", "anything")).toEqual([]);
});

test("an explicit colon effort wins over the budget and an empty selector stays empty", () => {
  expect(withBudget("anthropic/claude-opus-4-5:high", "small — medium reasoning")).toBe("anthropic/claude-opus-4-5:high");
  expect(withBudget("", "small — medium reasoning")).toBe("");
});

test("decision log rejects the .pi directory itself", async () => {
  const dir = tempDir("pstack-log-dir-");
  try {
    const host = decisionHost(dir);
    await expect(() =>
        host.tool.execute(
          "d",
          { phase: "coverage", decision: "reject", why: "the allowlist must exclude the directory", path: ".pi" },
          undefined,
          undefined,
          host.ctx,
        )).rejects.toThrow(/must stay under/);
    expect(host.entries().length, "a rejected call must not append a session entry").toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision log prepends the header when the file lacks one", async () => {
  const dir = tempDir("pstack-log-header-");
  try {
    const path = join(dir, ".pi", "decisions.tsv");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(path, "garbage from an older tool\n");
    const host = decisionHost(dir);
    await host.tool.execute(
      "d",
      { phase: "coverage", decision: "prepend", why: "an existing headerless file must gain the schema" },
      undefined,
      undefined,
      host.ctx,
    );
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(HEADER + "garbage from an older tool\n"), "the old content must survive under a fresh header").toBeTruthy();
    expect(text.endsWith("\n"), "the appended row must end with a newline").toBeTruthy();
    expect(host.entries().length).toBe(1);
    expect(host.entries()[0].data.phase).toBe("coverage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pstack_sessions lists, greps, and recalls a nested corpus through a session", async () => {
  await withSession(async (f) => {
    await withEnv({ HOME: f.tmp.home, PI_SESSION_DIR: undefined, PI_SESSION_FILE: undefined }, async () => {
      const corpus = seedSessionCorpus(f.tmp.cwd);
      stampTimes([corpus.alpha, corpus.beta, corpus.gamma, corpus.atFour]);
      const { call } = sessionTool(f, "pstack_sessions");

      const listed = await call({ action: "list", limit: 10 });
      const paths = listed.details.files.map((file) => file.path);
      expect(paths.includes(corpus.alpha)).toBe(true);
      expect(paths.includes(corpus.beta)).toBe(true);
      expect(paths.includes(corpus.gamma)).toBe(true);
      expect(paths.includes(corpus.atFour)).toBe(true);
      expect(paths.includes(corpus.buried)).toBe(false);
      expect(paths.includes(join(corpus.root, "notes.txt"))).toBe(false);
      expect(listed.content[0].text.includes(corpus.alpha)).toBe(true);

      const limited = await call({ action: "list", limit: 1 });
      expect(limited.details.files.length).toBe(1);

      const hits = await call({ action: "grep", query: "needle" });
      expect(hits.details.hitCount).toBe(2);
      expect(hits.content[0].text.includes("gamma needle")).toBe(true);

      const misses = await call({ action: "grep", query: "zzz-absent" });
      expect(misses.details.hitCount).toBe(0);
      expect(misses.content[0].text).toBe("(no hits for zzz-absent)");

      await expect(() => call({ action: "grep", query: "" })).rejects.toThrow("query required for grep");
      await expect(() => call({ action: "grep" })).rejects.toThrow("query required for grep");

      const recall = await call({ action: "recall", query: "needle", days: 30, limit: 5 });
      expect(recall.details.sessionHits).toBe(2);
      expect(recall.details.corpus).toEqual(["sessions", "git-log", "gh-prs", "ranked-merge"]);
      expect(recall.content[0].text.startsWith("## Recall corpus (local, ranked)")).toBe(true);

      const recallAll = await call({ action: "recall" });
      expect(recallAll.details.sessionHits).toBe(4);
    });
  }, SESSIONS_FACTORY);
});

test("pstack_sessions reports an empty corpus and resolves each current-session fallback", async () => {
  await withSession(async (f) => {
    await withEnv({ HOME: f.tmp.home, PI_SESSION_DIR: undefined, PI_SESSION_FILE: undefined }, async () => {
      const { call } = sessionTool(f, "pstack_sessions");

      const empty = await call({ action: "list" });
      expect(empty.details.files).toEqual([]);
      expect(empty.content[0].text).toBe("(no sessions found in known Pi dirs)");

      const known = await call(
        { action: "current" },
        { cwd: f.tmp.cwd, sessionManager: { getSessionFile: () => "/tmp/probe-known.jsonl" } },
      );
      expect(known.details.file).toBe("/tmp/probe-known.jsonl");

      await withEnv({ PI_SESSION_FILE: "/tmp/probe-env.jsonl" }, async () => {
        const fromEnv = await call({ action: "current" }, { cwd: f.tmp.cwd, sessionManager: {} });
        expect(fromEnv.details.file).toBe("/tmp/probe-env.jsonl");
      });

      const unknown = await call({ action: "current" }, { cwd: f.tmp.cwd, sessionManager: {} });
      expect(unknown.details.file).toBe("(unknown)");
    });
  }, SESSIONS_FACTORY);
});

test("pstack_sessions reads global dirs when untrusted and refuses an unknown action", async () => {
  await withSession(async (f) => {
    const agentSessions = join(f.tmp.home, ".pi", "agent", "sessions");
    const extraSessions = join(f.tmp.root, "extra-sessions");
    mkdirSync(agentSessions, { recursive: true });
    mkdirSync(extraSessions, { recursive: true });
    writeFileSync(join(agentSessions, "home.jsonl"), "home needle\n");
    writeFileSync(join(extraSessions, "extra.jsonl"), "extra needle\n");

    await withEnv({ HOME: f.tmp.home, PI_SESSION_DIR: extraSessions, PI_SESSION_FILE: undefined }, async () => {
      const { call } = sessionTool(f, "pstack_sessions", {
        cwd: f.tmp.cwd,
        isProjectTrusted: () => false,
        sessionManager: {},
      });
      const listed = await call({ action: "list" });
      const paths = listed.details.files.map((file) => file.path);
      expect(paths.includes(join(agentSessions, "home.jsonl"))).toBe(true);
      expect(paths.includes(join(extraSessions, "extra.jsonl"))).toBe(true);
      await expect(() => call({ action: "explode" })).rejects.toThrow("action must be list|grep|current|recall");
    });
  }, SESSIONS_FACTORY);
});

test("setup-pstack writes sanitized defaults and the prompt falls back without a config", async () => {
  await withSession(async (f) => {
    await withEnv({ HOME: f.tmp.home, PI_MODEL: undefined, PSTACK_DEFAULT_MODEL: undefined }, async () => {
      const path = join(f.tmp.home, ".pi", "agent", "pstack-models.json");
      expect(existsSync(path)).toBe(false);

      const ctx = setupContext(f.tmp.cwd, { hasUI: false, trusted: true, accept: true });
      await modelsCommand(f).handler("", ctx);

      const written = JSON.parse(readFileSync(path, "utf8"));
      expect(written.version).toBe(1);
      expect(written.roles["feature, refactoring"]).toBe("inherit-parent");
      expect(written.roles["judgment and prose"]).toBe("anthropic/claude-opus-4-5");
      expect(ctx.calls.selects).toEqual([]);
      expect(ctx.calls.confirms).toEqual([]);
      expect(ctx.calls.notices.at(-1)[1]).toMatch(/edit to set real provider\/id/);

      const handlers = beforeAgentHandlers(f);
      expect(handlers.length).toBe(1);
      const result = await handlers[0]({ systemPrompt: "BASE" }, f.session._extensionRunner.createContext());
      expect(result.systemPrompt.startsWith("BASE\n\n## pstack model roles")).toBe(true);
      expect(result.systemPrompt.includes("feature, refactoring: inherit-parent")).toBe(true);
    });
  }, MODELS_FACTORY);
});

test("setup-pstack upgrades inherit aliases and refuses bare marketing slugs", async () => {
  await withSession(async (f) => {
    writeProjectRoles(f.tmp.cwd, {
      "feature, refactoring": "inherit-parent",
      "bug-fix": "grok-4.6-fast-xhigh",
      "perf-issue": "openai/gpt-5",
      hillclimb: ["auto", "inherit-parent"],
      "judgment and prose": ["anthropic/claude-opus-4-5", "openai/gpt-5"],
      "hardest tasks": "gpt-4o",
    });
    await withEnv({ HOME: f.tmp.home, PI_MODEL: "anthropic/claude-opus-4-5", PSTACK_DEFAULT_MODEL: undefined }, async () => {
      const ctx = setupContext(f.tmp.cwd, { hasUI: true, trusted: true, accept: true, budget: "test-budget" });
      await modelsCommand(f).handler("", ctx);

      const written = JSON.parse(readFileSync(join(f.tmp.home, ".pi", "agent", "pstack-models.json"), "utf8"));
      expect(written.roles["feature, refactoring"]).toBe("anthropic/claude-opus-4-5");
      expect(written.roles["bug-fix"]).toBe("anthropic/claude-opus-4-5");
      expect(written.roles["perf-issue"]).toBe("openai/gpt-5");
      expect(written.roles.hillclimb).toEqual(["anthropic/claude-opus-4-5", "anthropic/claude-opus-4-5"]);
      expect(written.roles["judgment and prose"]).toEqual(["anthropic/claude-opus-4-5", "openai/gpt-5"]);
      expect(written.roles["hardest tasks"]).toBe("anthropic/claude-opus-4-5");
      expect(written.budget).toBe("test-budget");
      expect(ctx.calls.confirms.at(-1).message).toMatch(/detected anthropic\/claude-opus-4-5/);
      expect(ctx.calls.notices.at(-1)[1]).toMatch(/provider\/id anthropic\/claude-opus-4-5/);
    });
  }, MODELS_FACTORY);
});

test("setup-pstack cancels without writing when the operator declines", async () => {
  await withSession(async (f) => {
    await withEnv({ HOME: f.tmp.home, PI_MODEL: undefined, PSTACK_DEFAULT_MODEL: undefined }, async () => {
      const ctx = setupContext(f.tmp.cwd, { hasUI: true, trusted: false, accept: false, budget: undefined });
      await modelsCommand(f).handler("", ctx);
      expect(ctx.calls.selects.length).toBe(1);
      expect(ctx.calls.notices.at(-1)).toEqual(["info", "setup-pstack cancelled"]);
      expect(existsSync(join(f.tmp.home, ".pi", "agent", "pstack-models.json"))).toBe(false);

      const handlers = beforeAgentHandlers(f);
      const result = await handlers[0]({ systemPrompt: "BASE" }, ctx);
      expect(result.systemPrompt.includes("feature, refactoring: inherit-parent")).toBe(true);
    });
  }, MODELS_FACTORY);
});

test("setup-pstack shows the unlimited fallback when the config omits a budget", async () => {
  await withSession(async (f) => {
    writeProjectRoles(f.tmp.cwd, { code: "openai/gpt-5" });
    await withEnv({ HOME: f.tmp.home, PI_MODEL: undefined, PSTACK_DEFAULT_MODEL: undefined }, async () => {
      const ctx = setupContext(f.tmp.cwd, { hasUI: true, trusted: true, accept: false, budget: undefined });
      await modelsCommand(f).handler("", ctx);
      const shown = ctx.calls.confirms.at(-1).message;
      expect(shown.includes("budget: unlimited")).toBe(true);
      expect(shown.includes("inherit-parent / mapped provider ids")).toBe(true);
    });
  }, MODELS_FACTORY);
});

test("the model roles prompt section maps known slugs and flags unknown ones", async () => {
  await withSession(async (f) => {
    writeProjectRoles(f.tmp.cwd, {
      code: "grok-4.6-fast-xhigh",
      bad: "gpt-4o",
      panel: ["auto", "openai/gpt-5"],
    });
    await withEnv({ HOME: f.tmp.home, PI_MODEL: undefined, PSTACK_DEFAULT_MODEL: undefined }, async () => {
      const handlers = beforeAgentHandlers(f);
      const result = await handlers[0]({ systemPrompt: "BASE" }, f.session._extensionRunner.createContext());
      expect(result.systemPrompt.includes("- code: xai/grok-4 (mapped from grok-4.6-fast-xhigh)")).toBe(true);
      expect(result.systemPrompt.includes("- bad: gpt-4o [INVALID bare slug")).toBe(true);
      expect(result.systemPrompt.includes("- panel: auto, openai/gpt-5")).toBe(true);
    });
  }, MODELS_FACTORY);
});
