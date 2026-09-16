import { expect, test } from "vitest";
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
  expect(isInheritAlias("inherit-parent")).toBe(true);
  expect(isInheritAlias("auto")).toBe(true);
  expect(isInheritAlias("AUTO")).toBe(false);
  expect(isProviderId("anthropic/claude-sonnet-4-5")).toBe(true);
  expect(isProviderId("inherit-parent")).toBe(false);
  expect(isProviderId("/leading-slash")).toBe(false);
  expect(isProviderId("two words/here")).toBe(false);
  expect(isBareMarketingSlug("grok-4.6-fast-xhigh")).toBe(true);
  expect(isBareMarketingSlug("inherit-parent")).toBe(false);
  expect(isBareMarketingSlug("anthropic/claude-sonnet-4-5")).toBe(false);
  expect(isBareMarketingSlug("")).toBe(false);
});

test("normalizeModelSelector trims, inherits, and maps a known slug", () => {
  expect(normalizeModelSelector("")).toEqual({ ok: false, error: "empty model selector" });
  expect(normalizeModelSelector("   ", "xai/grok-4")).toEqual({ ok: true, model: "xai/grok-4" });
  expect(normalizeModelSelector("  anthropic/claude-sonnet-4-5  ")).toEqual({
    ok: true,
    model: "anthropic/claude-sonnet-4-5",
  });
  expect(normalizeModelSelector("inherit-parent")).toEqual({ ok: true, model: "inherit-parent" });
  expect(normalizeModelSelector("auto", "xai/grok-4")).toEqual({ ok: true, model: "xai/grok-4" });
  expect(normalizeModelSelector("grok-4.6")).toEqual({ ok: true, model: "xai/grok-4", mappedFrom: "grok-4.6" });
});

test("normalizeModelSelector falls back to a provider-id parent and refuses without one", () => {
  expect(normalizeModelSelector("unknown-slug", "anthropic/claude-opus-4-5")).toEqual({
    ok: true,
    model: "anthropic/claude-opus-4-5",
    mappedFrom: "unknown-slug",
  });
  expect(normalizeModelSelector("unknown-slug", "anthropic/claude-opus-4-5", { allowFallbackToParent: false })).toEqual({ ok: false, error: REFUSED_UNKNOWN_SLUG });
  expect(normalizeModelSelector("unknown-slug", "not a model")).toEqual({
    ok: false,
    error: REFUSED_UNKNOWN_SLUG,
  });
  expect(normalizeModelSelector("unknown-slug")).toEqual({ ok: false, error: REFUSED_UNKNOWN_SLUG });
});

test("sanitizeRoleValueForWrite keeps ids and aliases, maps known slugs, and falls back", () => {
  expect(sanitizeRoleValueForWrite("inherit-parent")).toBe("inherit-parent");
  expect(sanitizeRoleValueForWrite("auto")).toBe("auto");
  expect(sanitizeRoleValueForWrite("anthropic/claude-opus-4-5")).toBe("anthropic/claude-opus-4-5");
  expect(sanitizeRoleValueForWrite("claude-fable-5-1-thinking-max")).toBe("anthropic/claude-opus-4-5");
  expect(sanitizeRoleValueForWrite("totally-unknown")).toBe("inherit-parent");
  expect(sanitizeRoleValueForWrite("totally-unknown", "openai/gpt-5")).toBe("openai/gpt-5");
  expect(sanitizeRoleValueForWrite("totally-unknown", "not a model")).toBe("inherit-parent");
  expect(sanitizeRoleValueForWrite(["inherit-parent", "grok-4.6", "totally-unknown"], "openai/gpt-5")).toEqual([
    "inherit-parent",
    "xai/grok-4",
    "openai/gpt-5",
  ]);
});

test("defaultModelsConfig maps a bare-slug preference through the slug table", () => {
  const cfg = defaultModelsConfig("grok-4.6-fast-xhigh");
  expect(cfg.version).toBe(1);
  expect(cfg.budget).toBe("unlimited (max)");
  expect(cfg.roles["feature, refactoring"]).toBe("xai/grok-4");
  expect(cfg.roles["swarm workers"]).toBe("xai/grok-4");
  expect(cfg.roles["judgment and prose"]).toBe("anthropic/claude-opus-4-5");
  expect(cfg.roles["arena runners"]).toEqual([
    "anthropic/claude-opus-4-5",
    "openai/gpt-5",
    "xai/grok-4",
    "anthropic/claude-sonnet-4-5",
  ]);
  expect(cfg.roles["arena cross-judge pool"]).toEqual(["anthropic/claude-opus-4-5"]);
  expect(SKILL_DEFAULT_JUDGMENT).toBe("claude-fable-5-1-thinking-max");
});

test("modelsConfigPath and projectModelsConfigPath join the documented locations", () => {
  const env = tempModelsEnv();
  try {
    expect(modelsConfigPath()).toBe(join(env.home, ".pi", "agent", "pstack-models.json"));
    expect(projectModelsConfigPath("/repo")).toBe("/repo/.pi/pstack-models.json");
  } finally {
    env.restore();
  }
});

test("loadModelsConfig returns null without a candidate file and projectConfigCwd gates on trust", () => {
  const env = tempModelsEnv();
  try {
    expect(loadModelsConfig(env.project)).toBe(null);
    expect(loadModelsConfig()).toBe(null);
    expect(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => true })).toBe("/repo");
    expect(projectConfigCwd({ cwd: "/repo", isProjectTrusted: () => false })).toBe(undefined);
    expect(projectConfigCwd({ cwd: "/repo" })).toBe(undefined);
    expect(marketingTierRank("fast")).toBe(0);
    expect(marketingTierRank("max")).toBe(3);
  } finally {
    env.restore();
  }
});

test("withBudget keeps an explicit colon effort and reads a budget label", () => {
  expect(withBudget("anthropic/claude-opus-4-5:high", "small — medium reasoning")).toBe("anthropic/claude-opus-4-5:high");
  expect(withBudget("anthropic/claude-opus-4-5-xhigh", "small")).toBe("anthropic/claude-opus-4-5:xhigh");
  expect(withBudget("anthropic/claude-opus-4-5", "unlimited — keep max")).toBe("anthropic/claude-opus-4-5:max");
  expect(withBudget("  xai/grok-4  ", "large")).toBe("xai/grok-4:xhigh");
  expect(withBudget("", "medium")).toBe("");
  expect(effortForBudget("  LARGE — xhigh reasoning")).toBe("xhigh");
  expect(effortForBudget("unlimited")).toBe("max");
  expect(effortForBudget("small")).toBe("medium");
  expect(effortForBudget(42)).toBe(null);
  expect(effortForBudget("none")).toBe(null);
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
    expect(typeof handler).toBe("function");
    await handler?.("", ctx);
    const path = join(env.home, ".pi", "agent", "pstack-models.json");
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      version: number;
      budget: string;
      roles: Record<string, RoleValue>;
    };
    expect(written.version).toBe(1);
    expect(written.budget).toBe("unlimited (max)");
    expect(written.roles["feature, refactoring"]).toBe("inherit-parent");
    expect(written.roles["swarm workers"]).toBe("inherit-parent");
    expect(written.roles["judgment and prose"]).toBe("anthropic/claude-opus-4-5");
    expect(written.roles["arena runners"]).toEqual([
      "anthropic/claude-opus-4-5",
      "openai/gpt-5",
      "xai/grok-4",
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(notices.all()).toEqual([
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
    expect(written.budget).toBe("medium — high reasoning");
    expect(written.roles["swarm workers"]).toBe("openai/gpt-5");
    expect(written.roles["arena runners"]).toEqual(["openai/gpt-5", "openai/gpt-5"]);
    expect(written.roles["judgment and prose"]).toBe("anthropic/claude-opus-4-5");
    expect(written.roles["feature, refactoring"]).toBe("openai/gpt-5");
    expect(notices.all()[0]?.message).toBe(`Wrote ${path} (provider/id openai/gpt-5). Bare Cursor marketing slugs are mapped or refused.`);
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
    expect(selects.all()).toEqual([`pstack budget|${BUDGET_OPTIONS}`]);
    expect(existsSync(path)).toBe(false);
    expect(notices.all()).toEqual([{ message: "setup-pstack cancelled", level: "info" }]);
    expect(confirms.all()).toEqual([
      `Write defaults?|Write role defaults (inherit-parent / mapped provider ids — no bare marketing slugs) (budget: small — medium reasoning) to ${path}?`,
    ]);

    const accepting = { ...ui, confirm: async () => true };
    await handler?.("", { ...ctx, ui: accepting });
    const written = JSON.parse(readFileSync(path, "utf8")) as { budget: string };
    expect(written.budget).toBe("small — medium reasoning");
    expect(notices.all().at(-1)?.message).toBe(`Wrote ${path} (edit to set real provider/id). Bare Cursor marketing slugs are mapped or refused.`);
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
    expect(prompt.startsWith("BASE PROMPT\n\n## pstack model roles (validated always-applied twin)\n")).toBe(true);
    expect(prompt.includes("- feature, refactoring: xai/grok-4 (mapped from grok-4.6-fast-xhigh)")).toBe(true);
    expect(prompt.includes("- swarm workers: totally-unknown-model [INVALID bare slug — use provider/id]")).toBe(true);
    expect(prompt.includes("- arena runners: anthropic/claude-opus-4-5 (mapped from claude-fable-5-1-thinking-max)")).toBe(true);
    expect(prompt.endsWith("Every child resolves via resolveRoleModel.")).toBe(true);
  } finally {
    env.restore();
  }
});
