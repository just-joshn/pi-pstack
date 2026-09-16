import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultModelsConfig,
  isBareMarketingSlug,
  isInheritAlias,
  isProviderId,
  loadModelsConfig,
  marketingTierRank,
  modelsConfigPath,
  normalizeModelSelector,
  projectConfigCwd,
  projectModelsConfigPath,
  sanitizeRoleValueForWrite,
  SKILL_DEFAULT_JUDGMENT,
  type RoleValue,
} from "../../../extensions/models/config.ts";
import { effortForBudget, withBudget } from "../../../extensions/models/budget.ts";
import { registerModels } from "../../../extensions/models/index.ts";

const REFUSED_UNKNOWN_SLUG =
  "Refused bare model slug 'unknown-slug'. Pass provider/id (e.g. anthropic/claude-sonnet-4-5), inherit-parent, or auto. Known maps: grok-4.6-fast-xhigh, grok-4.6, claude-fable-5-1-thinking-max, claude-opus-5-thinking-xhigh, gpt-5.6-sol-max, cursor-grok-4.6-medium-fast";

const BUDGET_OPTIONS =
  "unlimited — keep max/large — xhigh reasoning/medium — high reasoning/small — medium reasoning";

interface ModelsEnv {
  home: string;
  project: string;
  restore: () => void;
}

interface CommandSpec {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

type PromptHandler = (
  event: { systemPrompt: string },
  ctx: { cwd: string; isProjectTrusted: () => boolean },
) => { systemPrompt?: string } | undefined;

function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = saved;
}

function tempModelsEnv(): ModelsEnv {
  const home = mkdtempSync(join(tmpdir(), "pstack-fn-models-home-"));
  const project = mkdtempSync(join(tmpdir(), "pstack-fn-models-project-"));
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function liveList<T>() {
  let items: T[] = [];
  return {
    add: (item: T) => {
      items = [...items, item];
    },
    all: () => items,
  };
}

function captureModels() {
  const commands = new Map<string, CommandSpec>();
  let promptHandler: PromptHandler | undefined;
  const pi = {
    registerCommand(name: string, spec: CommandSpec) {
      commands.set(name, spec);
    },
    on(name: string, fn: unknown) {
      if (name === "before_agent_start") promptHandler = fn as PromptHandler;
    },
  };
  registerModels(pi as never);
  return {
    setupHandler: () => commands.get("setup-pstack")?.handler,
    beforeAgentStart: (systemPrompt: string, cwd: string) =>
      promptHandler?.({ systemPrompt }, { cwd, isProjectTrusted: () => true }),
  };
}

test("selector predicates classify inherit aliases, provider ids, and bare slugs", () => {
  assert.equal(isInheritAlias("inherit-parent"), true);
  assert.equal(isInheritAlias("auto"), true);
  assert.equal(isInheritAlias("AUTO"), false);
  assert.equal(isProviderId("anthropic/claude-sonnet-4-5"), true);
  assert.equal(isProviderId("inherit-parent"), false);
  assert.equal(isProviderId("/leading-slash"), false);
  assert.equal(isProviderId("two words/here"), false);
  assert.equal(isBareMarketingSlug("grok-4.6-fast-xhigh"), true);
  assert.equal(isBareMarketingSlug("inherit-parent"), false);
  assert.equal(isBareMarketingSlug("anthropic/claude-sonnet-4-5"), false);
  assert.equal(isBareMarketingSlug(""), false);
});

test("normalizeModelSelector trims, inherits, and maps a known slug", () => {
  assert.deepEqual(normalizeModelSelector(""), { ok: false, error: "empty model selector" });
  assert.deepEqual(normalizeModelSelector("   ", "xai/grok-4"), { ok: true, model: "xai/grok-4" });
  assert.deepEqual(normalizeModelSelector("  anthropic/claude-sonnet-4-5  "), {
    ok: true,
    model: "anthropic/claude-sonnet-4-5",
  });
  assert.deepEqual(normalizeModelSelector("inherit-parent"), { ok: true, model: "inherit-parent" });
  assert.deepEqual(normalizeModelSelector("auto", "xai/grok-4"), { ok: true, model: "xai/grok-4" });
  assert.deepEqual(normalizeModelSelector("grok-4.6"), { ok: true, model: "xai/grok-4", mappedFrom: "grok-4.6" });
});

test("normalizeModelSelector falls back to a provider-id parent and refuses without one", () => {
  assert.deepEqual(normalizeModelSelector("unknown-slug", "anthropic/claude-opus-4-5"), {
    ok: true,
    model: "anthropic/claude-opus-4-5",
    mappedFrom: "unknown-slug",
  });
  assert.deepEqual(
    normalizeModelSelector("unknown-slug", "anthropic/claude-opus-4-5", { allowFallbackToParent: false }),
    { ok: false, error: REFUSED_UNKNOWN_SLUG },
  );
  assert.deepEqual(normalizeModelSelector("unknown-slug", "not a model"), {
    ok: false,
    error: REFUSED_UNKNOWN_SLUG,
  });
  assert.deepEqual(normalizeModelSelector("unknown-slug"), { ok: false, error: REFUSED_UNKNOWN_SLUG });
});

test("sanitizeRoleValueForWrite keeps ids and aliases, maps known slugs, and falls back", () => {
  assert.equal(sanitizeRoleValueForWrite("inherit-parent"), "inherit-parent");
  assert.equal(sanitizeRoleValueForWrite("auto"), "auto");
  assert.equal(sanitizeRoleValueForWrite("anthropic/claude-opus-4-5"), "anthropic/claude-opus-4-5");
  assert.equal(sanitizeRoleValueForWrite("claude-fable-5-1-thinking-max"), "anthropic/claude-opus-4-5");
  assert.equal(sanitizeRoleValueForWrite("totally-unknown"), "inherit-parent");
  assert.equal(sanitizeRoleValueForWrite("totally-unknown", "openai/gpt-5"), "openai/gpt-5");
  assert.equal(sanitizeRoleValueForWrite("totally-unknown", "not a model"), "inherit-parent");
  assert.deepEqual(sanitizeRoleValueForWrite(["inherit-parent", "grok-4.6", "totally-unknown"], "openai/gpt-5"), [
    "inherit-parent",
    "xai/grok-4",
    "openai/gpt-5",
  ]);
});

test("defaultModelsConfig maps a bare-slug preference through the slug table", () => {
  const cfg = defaultModelsConfig("grok-4.6-fast-xhigh");
  assert.equal(cfg.version, 1);
  assert.equal(cfg.budget, "unlimited (max)");
  assert.equal(cfg.roles["feature, refactoring"], "xai/grok-4");
  assert.equal(cfg.roles["swarm workers"], "xai/grok-4");
  assert.equal(cfg.roles["judgment and prose"], "anthropic/claude-opus-4-5");
  assert.deepEqual(cfg.roles["arena runners"], [
    "anthropic/claude-opus-4-5",
    "openai/gpt-5",
    "xai/grok-4",
    "anthropic/claude-sonnet-4-5",
  ]);
  assert.deepEqual(cfg.roles["arena cross-judge pool"], ["anthropic/claude-opus-4-5"]);
  assert.equal(SKILL_DEFAULT_JUDGMENT, "claude-fable-5-1-thinking-max");
});

test("modelsConfigPath and projectModelsConfigPath join the documented locations", () => {
  const env = tempModelsEnv();
  try {
    assert.equal(modelsConfigPath(), join(env.home, ".pi", "agent", "pstack-models.json"));
    assert.equal(projectModelsConfigPath("/repo"), "/repo/.pi/pstack-models.json");
  } finally {
    env.restore();
  }
});

test("loadModelsConfig returns null without a candidate file and projectConfigCwd gates on trust", () => {
  const env = tempModelsEnv();
  try {
    assert.equal(loadModelsConfig(env.project), null);
    assert.equal(loadModelsConfig(), null);
    assert.equal(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => true }), "/repo");
    assert.equal(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => false }), undefined);
    assert.equal(projectConfigCwd({ cwd: "/repo" }), undefined);
    assert.equal(marketingTierRank("fast"), 0);
    assert.equal(marketingTierRank("max"), 3);
  } finally {
    env.restore();
  }
});

test("withBudget keeps an explicit colon effort and reads a budget label", () => {
  assert.equal(withBudget("anthropic/claude-opus-4-5:high", "small — medium reasoning"), "anthropic/claude-opus-4-5:high");
  assert.equal(withBudget("anthropic/claude-opus-4-5-xhigh", "small"), "anthropic/claude-opus-4-5:xhigh");
  assert.equal(withBudget("anthropic/claude-opus-4-5", "unlimited — keep max"), "anthropic/claude-opus-4-5:max");
  assert.equal(withBudget("  xai/grok-4  ", "large"), "xai/grok-4:xhigh");
  assert.equal(withBudget("", "medium"), "");
  assert.equal(effortForBudget("  LARGE — xhigh reasoning"), "xhigh");
  assert.equal(effortForBudget("unlimited"), "max");
  assert.equal(effortForBudget("small"), "medium");
  assert.equal(effortForBudget(42), null);
  assert.equal(effortForBudget("none"), null);
});

test("setup-pstack writes sanitized defaults with no bare marketing slugs", async () => {
  const env = tempModelsEnv();
  try {
    const models = captureModels();
    const notices = liveList<{ message: string; level: string }>();
    const ctx = {
      hasUI: false,
      cwd: env.project,
      isProjectTrusted: () => true,
      ui: {
        notify(message: string, level: string) {
          notices.add({ message, level });
        },
      },
    };
    const handler = models.setupHandler();
    assert.equal(typeof handler, "function");
    await handler?.("", ctx);
    const path = join(env.home, ".pi", "agent", "pstack-models.json");
    assert.equal(existsSync(path), true);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      budget: string;
      roles: Record<string, RoleValue>;
    };
    assert.equal(written.version, 1);
    assert.equal(written.budget, "unlimited (max)");
    assert.equal(written.roles["feature, refactoring"], "inherit-parent");
    assert.equal(written.roles["swarm workers"], "inherit-parent");
    assert.equal(written.roles["judgment and prose"], "anthropic/claude-opus-4-5");
    assert.deepEqual(written.roles["arena runners"], [
      "anthropic/claude-opus-4-5",
      "openai/gpt-5",
      "xai/grok-4",
      "anthropic/claude-sonnet-4-5",
    ]);
    assert.deepEqual(notices.all(), [
      {
        message: `Wrote ${path} (edit to set real provider/id). Bare Cursor marketing slugs are mapped or refused.`,
        level: "info",
      },
    ]);
  } finally {
    env.restore();
  }
});

test("setup-pstack upgrades inherit aliases and bare slugs to the detected provider id", async () => {
  const env = tempModelsEnv();
  try {
    process.env.PI_MODEL = "openai/gpt-5";
    writeJson(join(env.home, ".pi", "agent", "pstack-models.json"), {
      version: 1,
      budget: "medium — high reasoning",
      roles: {
        "swarm workers": "inherit-parent",
        "arena runners": ["auto", "grok-4.6-fast-xhigh"],
        "judgment and prose": "anthropic/claude-opus-4-5",
        "feature, refactoring": "totally-unknown-slug",
      },
    });
    const models = captureModels();
    const notices = liveList<{ message: string; level: string }>();
    const handler = models.setupHandler();
    await handler?.("", {
      hasUI: false,
      cwd: env.project,
      isProjectTrusted: () => true,
      ui: {
        notify(message: string, level: string) {
          notices.add({ message, level });
        },
      },
    });
    const path = join(env.home, ".pi", "agent", "pstack-models.json");
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      budget: string;
      roles: Record<string, RoleValue>;
    };
    assert.equal(written.budget, "medium — high reasoning");
    assert.equal(written.roles["swarm workers"], "openai/gpt-5");
    assert.deepEqual(written.roles["arena runners"], ["openai/gpt-5", "openai/gpt-5"]);
    assert.equal(written.roles["judgment and prose"], "anthropic/claude-opus-4-5");
    assert.equal(written.roles["feature, refactoring"], "openai/gpt-5");
    assert.equal(notices.all()[0]?.message, `Wrote ${path} (provider/id openai/gpt-5). Bare Cursor marketing slugs are mapped or refused.`);
  } finally {
    env.restore();
  }
});

test("setup-pstack honours the UI budget, cancels on a declined confirm, and writes on acceptance", async () => {
  const env = tempModelsEnv();
  try {
    const models = captureModels();
    const handler = models.setupHandler();
    const path = join(env.home, ".pi", "agent", "pstack-models.json");
    const notices = liveList<{ message: string; level: string }>();
    const confirms = liveList<string>();
    const selects = liveList<string>();
    const ui = {
      async select(label: string, options: string[]) {
        selects.add(`${label}|${options.join("/")}`);
        return "small — medium reasoning";
      },
      async confirm(title: string, message: string) {
        confirms.add(`${title}|${message}`);
        return false;
      },
      notify(message: string, level: string) {
        notices.add({ message, level });
      },
    };
    const ctx = { hasUI: true, cwd: env.project, isProjectTrusted: () => true, ui };
    await handler?.("", ctx);
    assert.deepEqual(selects.all(), [`pstack budget|${BUDGET_OPTIONS}`]);
    assert.equal(existsSync(path), false);
    assert.deepEqual(notices.all(), [{ message: "setup-pstack cancelled", level: "info" }]);
    assert.deepEqual(confirms.all(), [
      `Write defaults?|Write role defaults (inherit-parent / mapped provider ids — no bare marketing slugs) (budget: small — medium reasoning) to ${path}?`,
    ]);

    const accepting = { ...ui, confirm: async () => true };
    await handler?.("", { ...ctx, ui: accepting });
    const written = JSON.parse(readFileSync(path, "utf8")) as { budget: string };
    assert.equal(written.budget, "small — medium reasoning");
    assert.equal(
      notices.all().at(-1)?.message,
      `Wrote ${path} (edit to set real provider/id). Bare Cursor marketing slugs are mapped or refused.`,
    );
  } finally {
    env.restore();
  }
});

test("the before_agent_start section maps known slugs and flags an unknown bare slug", () => {
  const env = tempModelsEnv();
  try {
    writeJson(join(env.project, ".pi", "pstack-models.json"), {
      version: 1,
      roles: {
        "feature, refactoring": "grok-4.6-fast-xhigh",
        "swarm workers": "totally-unknown-model",
        "arena runners": ["claude-fable-5-1-thinking-max"],
      },
    });
    const models = captureModels();
    const result = models.beforeAgentStart("BASE PROMPT", env.project);
    const prompt = result?.systemPrompt ?? "";
    assert.equal(prompt.startsWith("BASE PROMPT\n\n## pstack model roles (validated always-applied twin)\n"), true);
    assert.equal(prompt.includes("- feature, refactoring: xai/grok-4 (mapped from grok-4.6-fast-xhigh)"), true);
    assert.equal(prompt.includes("- swarm workers: totally-unknown-model [INVALID bare slug — use provider/id]"), true);
    assert.equal(
      prompt.includes("- arena runners: anthropic/claude-opus-4-5 (mapped from claude-fable-5-1-thinking-max)"),
      true,
    );
    assert.equal(prompt.endsWith("Every child resolves via resolveRoleModel."), true);
  } finally {
    env.restore();
  }
});
