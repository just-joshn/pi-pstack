import { expect, test } from "vitest";
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
    expect(loadModelsConfig(env.project), "unparseable JSON is skipped").toBe(null);

    writeProjectConfig(env.project, { version: 2, roles: { "swarm workers": "xai/grok-4" } });
    expect(loadModelsConfig(env.project), "version 2 is not the supported shape").toBe(null);

    writeProjectConfig(env.project, { roles: { "swarm workers": "xai/grok-4" } });
    expect(loadModelsConfig(env.project), "a missing version is skipped").toBe(null);

    writeProjectConfig(env.project, { version: 1, roles: "nope" });
    expect(loadModelsConfig(env.project), "a non-object roles map is skipped").toBe(null);

    const home = { version: 1, roles: { "swarm workers": "xai/grok-4" } };
    writeHomeConfig(env.home, home);
    writeProjectConfig(env.project, "{ still not json");
    expect(loadModelsConfig(env.project), "a malformed project file falls through").toEqual(home);

    const project = { version: 1, roles: { "feature, refactoring": "anthropic/claude-sonnet-4-5" } };
    writeProjectConfig(env.project, project);
    expect(loadModelsConfig(env.project)?.version).toBe(1);
    expect(loadModelsConfig(env.project)?.roles).toEqual(project.roles);
    expect(loadModelsConfig(undefined)?.version, "without a cwd only the home config is read").toBe(1);
    expect(loadModelsConfig(undefined)?.roles).toEqual(home.roles);
  } finally {
    env.restore();
  }
});

test("models-05 defaultModelsConfig fills code, judgment, and panel roles without bare slugs", () => {
  const detected = defaultModelsConfig("openai/gpt-5");
  expect(detected.version).toBe(1);
  for (const role of CODE_ROLES) expect(detected.roles[role], role).toBe("openai/gpt-5");
  for (const role of JUDGMENT_ROLES) expect(detected.roles[role], role).toBe("openai/gpt-5");
  expect(detected.roles["arena runners"]).toEqual([
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
  ]);
  expect(detected.roles["arena cross-judge pool"]).toEqual(["openai/gpt-5"]);
  expect(detected.roles["architect runners"]).toEqual([
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
    "openai/gpt-5",
  ]);

  const fallback = defaultModelsConfig();
  expect(fallback.roles["feature, refactoring"]).toBe("inherit-parent");
  expect(fallback.roles["swarm workers"]).toBe("inherit-parent");
  expect(fallback.roles["judgment and prose"]).toBe("anthropic/claude-opus-4-5");
  expect(fallback.roles["how explainer"]).toBe("anthropic/claude-opus-4-5");
  expect(fallback.roles["arena runners"]).toEqual([
    "anthropic/claude-opus-4-5",
    "openai/gpt-5",
    "xai/grok-4",
    "anthropic/claude-sonnet-4-5",
  ]);
  expect(fallback.roles["arena cross-judge pool"]).toEqual(["anthropic/claude-opus-4-5"]);

  const values = Object.values(fallback.roles).flat();
  for (const value of values) {
    expect(isBareMarketingSlug(value), `${value} must not be a bare marketing slug`).toBe(false);
    expect(isProviderId(value) || value === "inherit-parent", `${value} must be usable`).toBe(true);
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
    expect(resolveRoleModel("swarm workers", parent, 0, env.project)).toBe("xai/grok-4");
    expect(resolveRoleModel("swarm workers", parent, 1, env.project)).toBe("openai/gpt-5");
    expect(resolveRoleModel("swarm workers", parent, 2, env.project), "one past the end clamps to the last entry").toBe("openai/gpt-5");
    expect(resolveRoleModel("swarm workers", parent, 99, env.project)).toBe("openai/gpt-5");
    expect(resolveRoleModel("arena runners", parent, 1, env.project)).toBe("xai/grok-4");
    expect(resolveRoleModel("arena runners", parent, 3, env.project), "the array length sets the highest usable index").toBe("openai/gpt-5");
    expect(resolveRoleModel("feature, refactoring", parent, 7, env.project), "a string role ignores the index").toBe("anthropic/claude-opus-4-5");
    expect(resolveRoleModel("general", parent, 5, env.project), "the general alias resolves the code role").toBe("anthropic/claude-opus-4-5");
    expect(resolveRoleModel("runner not in config", parent, 0, env.project)).toBe(undefined);
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
    expect(first?.systemPrompt, "the section is appended on every call").toBe(second?.systemPrompt);
    for (const result of [first, second]) {
      const prompt = result?.systemPrompt ?? "";
      expect(prompt.startsWith("BASE PROMPT\n\n## pstack model roles (validated always-applied twin)"), "the base prompt is kept and the section appended").toBe(true);
      expect(prompt.includes("- feature, refactoring: stub/code-model")).toBe(true);
      expect(prompt.includes("- judgment and prose: anthropic/claude-sonnet-4-5")).toBe(true);
      expect(prompt.includes("Every child resolves via resolveRoleModel.")).toBe(true);
    }

    const bareDir = mkdtempSync(join(tmpdir(), "pstack-models-bare-"));
    try {
      const defaulted = models.beforeAgentStart("BASE", bareDir)?.systemPrompt ?? "";
      expect(defaulted.includes("## pstack model roles (validated always-applied twin)")).toBe(true);
      expect(defaulted.includes("- swarm workers: inherit-parent"), "defaults fill in").toBe(true);
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
    expect(detectPreferredModel(), "nothing configured yields nothing").toBe(undefined);

    process.env.PI_MODEL = "openai/gpt-5";
    expect(detectPreferredModel()).toBe("openai/gpt-5");
    process.env.PSTACK_DEFAULT_MODEL = "anthropic/claude-opus-4-5";
    expect(detectPreferredModel(), "PI_MODEL wins over PSTACK_DEFAULT_MODEL").toBe("openai/gpt-5");
    Reflect.deleteProperty(process.env, "PI_MODEL");
    expect(detectPreferredModel(), "PSTACK_DEFAULT_MODEL is the second source").toBe("anthropic/claude-opus-4-5");

    process.env.PI_MODEL = "grok-4.6-fast-xhigh";
    expect(detectPreferredModel(), "a known marketing slug maps").toBe("xai/grok-4");
    process.env.PI_MODEL = "totally-unknown-model";
    expect(detectPreferredModel(), "an unmapped env slug is not a model").toBe(undefined);
    Reflect.deleteProperty(process.env, "PI_MODEL");
    Reflect.deleteProperty(process.env, "PSTACK_DEFAULT_MODEL");

    writeSettings(env.home, { defaultModel: "openai/gpt-5" });
    expect(detectPreferredModel(), "the agent settings file is the next source").toBe("openai/gpt-5");
    writeSettings(env.home, { defaultModel: "claude-fable-5-1-thinking-max" });
    expect(detectPreferredModel(), "a settings slug maps").toBe("anthropic/claude-opus-4-5");
    writeSettings(env.home, { defaultModel: "unknown-slug", model: "xai/grok-4" });
    expect(detectPreferredModel(), "later model keys are tried").toBe("xai/grok-4");
    writeSettings(env.home, "{ not json");
    expect(detectPreferredModel(), "a malformed settings file is skipped").toBe(undefined);
  } finally {
    env.restore();
  }
});
