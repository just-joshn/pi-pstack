import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultModelsConfig,
  detectPreferredModel,
  isBareMarketingSlug,
  isProviderId,
  loadModelsConfig,
  resolveRoleModel,
} from "../../../extensions/models/config.ts";
import { registerModels } from "../../../extensions/models/index.ts";

const CODE_ROLES = [
  "feature, refactoring",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "how explorer",
  "why investigators",
  "reflect tooling",
  "swarm workers",
];

const JUDGMENT_ROLES = [
  "judgment and prose",
  "hardest tasks",
  "how explainer",
  "why synthesizer",
  "reflect judgment, divergent, synthesizer",
];

interface ModelsEnv {
  home: string;
  project: string;
  restore: () => void;
}

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = saved;
}

function tempModelsEnv(): ModelsEnv {
  const home = mkdtempSync(join(tmpdir(), "pstack-models-home-"));
  const project = mkdtempSync(join(tmpdir(), "pstack-models-project-"));
  const saved = {
    HOME: process.env.HOME,
    PI_MODEL: process.env.PI_MODEL,
    PSTACK_DEFAULT_MODEL: process.env.PSTACK_DEFAULT_MODEL,
  };
  process.env.HOME = home;
  restoreEnv("PI_MODEL", undefined);
  restoreEnv("PSTACK_DEFAULT_MODEL", undefined);
  return {
    home,
    project,
    restore: () => {
      restoreEnv("HOME", saved.HOME);
      restoreEnv("PI_MODEL", saved.PI_MODEL);
      restoreEnv("PSTACK_DEFAULT_MODEL", saved.PSTACK_DEFAULT_MODEL);
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeProjectConfig(project: string, value: unknown): void {
  writeJson(join(project, ".pi", "pstack-models.json"), value);
}

function writeHomeConfig(home: string, value: unknown): void {
  writeJson(join(home, ".pi", "agent", "pstack-models.json"), value);
}

function writeSettings(home: string, value: unknown): void {
  writeJson(join(home, ".pi", "agent", "settings.json"), value);
}

function captureModels() {
  let handler:
    | ((event: { systemPrompt: string }, ctx: { cwd: string }) => { systemPrompt?: string } | undefined)
    | undefined;
  const pi = {
    registerCommand() {},
    on(name: string, fn: unknown) {
      if (name === "before_agent_start") handler = fn as typeof handler;
    },
  };
  registerModels(pi as never);
  return {
    beforeAgentStart: (baseSystemPrompt: string, cwd: string) =>
      handler?.({ systemPrompt: baseSystemPrompt }, { cwd, isProjectTrusted: () => true }),
  };
}

test("models-04 requires version 1 with an object roles map and skips malformed files", () => {
  const env = tempModelsEnv();
  try {
    writeProjectConfig(env.project, "{ not json");
    assert.equal(loadModelsConfig(env.project), null, "unparseable JSON is skipped");

    writeProjectConfig(env.project, { version: 2, roles: { "swarm workers": "xai/grok-4" } });
    assert.equal(loadModelsConfig(env.project), null, "version 2 is not the supported shape");

    writeProjectConfig(env.project, { roles: { "swarm workers": "xai/grok-4" } });
    assert.equal(loadModelsConfig(env.project), null, "a missing version is skipped");

    writeProjectConfig(env.project, { version: 1, roles: "nope" });
    assert.equal(loadModelsConfig(env.project), null, "a non-object roles map is skipped");

    const home = { version: 1, roles: { "swarm workers": "xai/grok-4" } };
    writeHomeConfig(env.home, home);
    writeProjectConfig(env.project, "{ still not json");
    assert.deepEqual(loadModelsConfig(env.project), home, "a malformed project file falls through");

    const project = { version: 1, roles: { "feature, refactoring": "anthropic/claude-sonnet-4-5" } };
    writeProjectConfig(env.project, project);
    assert.equal(loadModelsConfig(env.project)?.version, 1);
    assert.deepEqual(loadModelsConfig(env.project)?.roles, project.roles);
    assert.equal(loadModelsConfig(undefined)?.version, 1, "without a cwd only the home config is read");
    assert.deepEqual(loadModelsConfig(undefined)?.roles, home.roles);
  } finally {
    env.restore();
  }
});

test("models-05 defaultModelsConfig fills code, judgment, and panel roles without bare slugs", () => {
  const detected = defaultModelsConfig("openai/gpt-5");
  assert.equal(detected.version, 1);
  for (const role of CODE_ROLES) assert.equal(detected.roles[role], "openai/gpt-5", role);
  for (const role of JUDGMENT_ROLES) assert.equal(detected.roles[role], "openai/gpt-5", role);
  assert.deepEqual(detected.roles["arena runners"], [
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
  ]);
  assert.deepEqual(detected.roles["arena cross-judge pool"], ["openai/gpt-5"]);
  assert.deepEqual(detected.roles["architect runners"], [
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
  ]);

  const fallback = defaultModelsConfig();
  assert.equal(fallback.roles["feature, refactoring"], "inherit-parent");
  assert.equal(fallback.roles["swarm workers"], "inherit-parent");
  assert.equal(fallback.roles["judgment and prose"], "anthropic/claude-sonnet-4-5");
  assert.equal(fallback.roles["how explainer"], "anthropic/claude-sonnet-4-5");
  assert.deepEqual(fallback.roles["arena runners"], [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5",
    "xai/grok-4",
    "anthropic/claude-opus-4-5",
  ]);
  assert.deepEqual(fallback.roles["arena cross-judge pool"], ["anthropic/claude-sonnet-4-5"]);

  const values = Object.values(fallback.roles).flat();
  for (const value of values) {
    assert.equal(isBareMarketingSlug(value), false, `${value} must not be a bare marketing slug`);
    assert.equal(isProviderId(value) || value === "inherit-parent", true, `${value} must be usable`);
  }
});

test("models-06 picks the indexed role entry and clamps past the end of the array", () => {
  const env = tempModelsEnv();
  try {
    writeProjectConfig(env.project, {
      version: 1,
      roles: {
        "swarm workers": ["xai/grok-4", "openai/gpt-5"],
        "arena runners": ["anthropic/claude-sonnet-4-5", "xai/grok-4", "openai/gpt-5"],
        "feature, refactoring": "anthropic/claude-opus-4-5",
      },
    });
    const parent = "parent/model";
    assert.equal(resolveRoleModel("swarm workers", parent, 0, env.project), "xai/grok-4");
    assert.equal(resolveRoleModel("swarm workers", parent, 1, env.project), "openai/gpt-5");
    assert.equal(
      resolveRoleModel("swarm workers", parent, 2, env.project),
      "openai/gpt-5",
      "one past the end clamps to the last entry",
    );
    assert.equal(resolveRoleModel("swarm workers", parent, 99, env.project), "openai/gpt-5");
    assert.equal(resolveRoleModel("arena runners", parent, 1, env.project), "xai/grok-4");
    assert.equal(
      resolveRoleModel("arena runners", parent, 3, env.project),
      "openai/gpt-5",
      "the array length sets the highest usable index",
    );
    assert.equal(
      resolveRoleModel("feature, refactoring", parent, 7, env.project),
      "anthropic/claude-opus-4-5",
      "a string role ignores the index",
    );
    assert.equal(
      resolveRoleModel("general", parent, 5, env.project),
      "anthropic/claude-opus-4-5",
      "the general alias resolves the code role",
    );
    assert.equal(resolveRoleModel("runner not in config", parent, 0, env.project), undefined);
  } finally {
    env.restore();
  }
});

test("models-07 appends the pstack model roles section on every before_agent_start", () => {
  const env = tempModelsEnv();
  try {
    writeProjectConfig(env.project, {
      version: 1,
      roles: {
        "feature, refactoring": "stub/code-model",
        "judgment and prose": "anthropic/claude-sonnet-4-5",
      },
    });
    const models = captureModels();
    const first = models.beforeAgentStart("BASE PROMPT", env.project);
    const second = models.beforeAgentStart("BASE PROMPT", env.project);
    assert.equal(first?.systemPrompt, second?.systemPrompt, "the section is appended on every call");
    for (const result of [first, second]) {
      const prompt = result?.systemPrompt ?? "";
      assert.equal(
        prompt.startsWith("BASE PROMPT\n\n## pstack model roles (validated always-applied twin)"),
        true,
        "the base prompt is kept and the section appended",
      );
      assert.equal(prompt.includes("- feature, refactoring: stub/code-model"), true);
      assert.equal(prompt.includes("- judgment and prose: anthropic/claude-sonnet-4-5"), true);
      assert.equal(prompt.includes("Every child resolves via resolveRoleModel."), true);
    }

    const bareDir = mkdtempSync(join(tmpdir(), "pstack-models-bare-"));
    try {
      const defaulted = models.beforeAgentStart("BASE", bareDir)?.systemPrompt ?? "";
      assert.equal(defaulted.includes("## pstack model roles (validated always-applied twin)"), true);
      assert.equal(defaulted.includes("- swarm workers: inherit-parent"), true, "defaults fill in");
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  } finally {
    env.restore();
  }
});

test("models-08 detectPreferredModel reads env then settings files and maps bare slugs", () => {
  const env = tempModelsEnv();
  try {
    assert.equal(detectPreferredModel(), undefined, "nothing configured yields nothing");

    process.env.PI_MODEL = "openai/gpt-5";
    assert.equal(detectPreferredModel(), "openai/gpt-5");
    process.env.PSTACK_DEFAULT_MODEL = "anthropic/claude-opus-4-5";
    assert.equal(detectPreferredModel(), "openai/gpt-5", "PI_MODEL wins over PSTACK_DEFAULT_MODEL");
    Reflect.deleteProperty(process.env, "PI_MODEL");
    assert.equal(detectPreferredModel(), "anthropic/claude-opus-4-5", "PSTACK_DEFAULT_MODEL is the second source");

    process.env.PI_MODEL = "grok-4.6-fast-xhigh";
    assert.equal(detectPreferredModel(), "xai/grok-4", "a known marketing slug maps");
    process.env.PI_MODEL = "totally-unknown-model";
    assert.equal(detectPreferredModel(), undefined, "an unmapped env slug is not a model");
    Reflect.deleteProperty(process.env, "PI_MODEL");
    Reflect.deleteProperty(process.env, "PSTACK_DEFAULT_MODEL");

    writeSettings(env.home, { defaultModel: "openai/gpt-5" });
    assert.equal(detectPreferredModel(), "openai/gpt-5", "the agent settings file is the next source");
    writeSettings(env.home, { defaultModel: "claude-fable-5-1-thinking-max" });
    assert.equal(detectPreferredModel(), "anthropic/claude-sonnet-4-5", "a settings slug maps");
    writeSettings(env.home, { defaultModel: "unknown-slug", model: "xai/grok-4" });
    assert.equal(detectPreferredModel(), "xai/grok-4", "later model keys are tried");
    writeSettings(env.home, "{ not json");
    assert.equal(detectPreferredModel(), undefined, "a malformed settings file is skipped");
  } finally {
    env.restore();
  }
});
