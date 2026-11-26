import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { sendWorkflow } from "./catalog-ui.ts";
import {
  aliases,
  applyConfigPatch,
  budgets,
  defaultConfig,
  effort,
  judgeRole,
  panelRoles,
  parseModelConfig,
  type Role,
  type RoleConfig,
  roles,
  validateConfig,
} from "./lib/models.ts";
import { parseJson } from "./lib/validation.ts";
import { agentDir, atomicWrite, fail, hasErrorCode, type Notify, piBin, text } from "./support.ts";

const modelConfigPath = () => join(agentDir(), "pstack-models.json");
export async function readConfig(
  available: readonly string[],
  configPath = modelConfigPath(),
): Promise<RoleConfig> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (e) {
    if (hasErrorCode(e, "ENOENT")) return defaultConfig(available);
    throw e;
  }
  return parseModelConfig(parseJson(source, "pstack model configuration"));
}

export const workerIsolation = [
  "--no-approve",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-mcp",
];
const modelsInScope = (ctx: ExtensionContext) =>
  ctx.scopedModels.length ? ctx.scopedModels.map((m) => m.model) : ctx.modelRegistry.getAvailable();
export const modelName = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;

async function listedModels(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
  extension?: string,
) {
  const run = await pi.exec(
    piBin,
    [...workerIsolation, ...(extension ? ["-e", extension] : []), "--list-models"],
    { cwd, timeout: 30_000, ...(signal && { signal }) },
  );
  if (run.code !== 0 || run.killed) return undefined;
  // Pi pads each row to the header's columns; ids can contain spaces, so split by position.
  const [header = "", ...rows] = run.stdout.split("\n");
  const [model, context] = [header.indexOf("model"), header.indexOf("context")];
  return rows
    .map((row) => ({ provider: row.slice(0, model).trim(), id: row.slice(model, context).trim() }))
    .filter((listed) => listed.provider && listed.id)
    .map((listed) => ({ provider: listed.provider, model: modelName(listed) }));
}

/**
 * Maps each in-scope model of an extension-registered provider to the loaded extension a worker
 * needs for it. Pi does not report which extension registered a provider, so every extension that
 * registers a command is listed alone and compared with the listing without extensions.
 */
export async function workerExtensions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
) {
  const registered = new Set(ctx.modelRegistry.getRegisteredProviderIds());
  const wanted = new Set(
    modelsInScope(ctx)
      .filter((m) => registered.has(m.provider))
      .map(modelName),
  );
  const loaded = [
    ...new Set(
      pi
        .getCommands()
        .filter((command) => command.source === "extension")
        .map((command) => command.sourceInfo.path),
    ),
  ];
  if (!wanted.size || !loaded.length) return new Map<string, string>();
  const [builtIn, ...listings] = await Promise.all(
    [undefined, ...loaded].map((extension) => listedModels(pi, ctx.cwd, signal, extension)),
  );
  if (signal?.aborted) fail("Cancelled");
  if (!builtIn) fail(`Could not list worker models: ${piBin} --list-models failed`);
  const builtInProviders = new Set(builtIn.map((listed) => listed.provider));
  return new Map(
    loaded.flatMap((extension, i) =>
      (listings[i] ?? [])
        .filter((listed) => wanted.has(listed.model) && !builtInProviders.has(listed.provider))
        .map((listed) => [listed.model, extension] as const),
    ),
  );
}

export function availableWorkerModels(
  ctx: ExtensionContext,
  extensions: ReadonlyMap<string, string>,
) {
  const registered = new Set(ctx.modelRegistry.getRegisteredProviderIds());
  const ids = modelsInScope(ctx)
    .filter((m) => !registered.has(m.provider) || extensions.has(modelName(m)))
    .map(modelName);
  return [...new Set(ids)].toSorted();
}

async function chooseRole(ctx: ExtensionContext, role: Role, available: string[]) {
  const panel = panelRoles.has(role);
  const options = [
    ...(role === judgeRole ? [] : aliases),
    ...available,
    ...(panel ? ["Done"] : []),
  ];
  const chosen: string[] = [];
  while (chosen.length < (panel ? 8 : 1)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Show prior selections in the next dialog.
    const value = await ctx.ui.select(`${role}: ${chosen.join(", ") || "(none)"}`, options);
    if (!value) return undefined;
    if (value === "Done") break;
    chosen.push(value);
  }
  return chosen;
}

async function chooseConfig(ctx: ExtensionContext, config: RoleConfig, available: string[]) {
  const budget = await ctx.ui.select(
    "Reasoning budget",
    budgets.map((b) => `${b} (${effort("feature, refactoring", b)})`),
  );
  if (!budget) return undefined;
  const selections = { ...config.roles };
  for (const role of roles) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Pi shows one selection dialog at a time.
    const action = await ctx.ui.select(`${role}: ${selections[role].join(", ") || "(empty)"}`, [
      "Keep current",
      "Choose model(s)",
    ]);
    if (!action) return undefined;
    if (action === "Keep current") continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Finish choosing this role before the next.
    const chosen = await chooseRole(ctx, role, available);
    if (!chosen) return undefined;
    selections[role] = chosen;
  }
  return { ...config, budget: budget.split(" ")[0], roles: selections };
}

const verificationOffers = [
  {
    skill: "create-verification-skill",
    exists: /^verify-/,
    question:
      "Want a project-local verification skill, so agents can drive the app the way a user does and prove changes work?",
  },
  {
    skill: "create-formal-verification-skill",
    exists: /formal|tla|proof|model-check/i,
    question:
      "Want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach?",
  },
];
async function offerVerification(pi: ExtensionAPI, ctx: ExtensionContext) {
  const listed = await Promise.all(
    [".pi", ".agents"].map((dir) => readdir(join(ctx.cwd, dir, "skills")).catch(() => [])),
  );
  const skills = listed.flat();
  for (const offer of verificationOffers) {
    if (skills.some((name) => offer.exists.test(name))) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Pi shows one confirmation at a time.
    if (await ctx.ui.confirm(offer.question, `I can generate one with /${offer.skill}.`))
      sendWorkflow(pi, offer.skill, "");
  }
}

export function registerModelSetup(pi: ExtensionAPI, notify: Notify) {
  pi.registerCommand("setup-pstack", {
    description: "Configure pstack role models and reasoning budget",
    handler: async (args, ctx) => {
      const available = availableWorkerModels(ctx, await workerExtensions(pi, ctx));
      const parent = ctx.model && modelName(ctx.model);
      const warning =
        parent && !available.includes(parent)
          ? `auto and inherit-parent resolve to ${parent}, which is unavailable to workers in this session. Select an available model explicitly.`
          : undefined;
      const configPath = modelConfigPath();
      const current = await readConfig(available, configPath);
      const input = args.trim();
      if (input === "show" || (!input && !ctx.hasUI)) {
        notify(ctx, text({ config: current, available, path: configPath, warning }));
        return;
      }
      if (!ctx.hasUI) fail("Use /setup-pstack interactively to confirm model configuration.");
      if (warning) notify(ctx, warning);
      const chosen = input
        ? applyConfigPatch(current, parseJson(input, "setup arguments"))
        : await chooseConfig(ctx, current, available);
      if (!chosen) return;
      const config = validateConfig(chosen, available);
      if (!(await ctx.ui.confirm("Save pstack role configuration?", text(config)))) return;
      await atomicWrite(configPath, JSON.stringify(config, null, 2) + "\n");
      notify(ctx, `Saved ${configPath}. Parent model unchanged.`);
      await offerVerification(pi, ctx);
    },
  });
}
