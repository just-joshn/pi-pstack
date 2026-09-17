import { expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTEGRATION_CATEGORIES,
  INTEGRATION_CAPABILITIES,
  integrationToolsFor,
  type IntegrationCategory,
} from "../../../extensions/agents/policy.ts";
import {
  AVAILABILITY,
  capabilityToolName,
  configPath,
  decideStatus,
  formatStatusLine,
  gapForStatus,
  integrationEntries,
  integrationEntry,
  integrationsDir,
  isIntegrationCategory,
  loadIntegrationsConfig,
  type IntegrationsConfig,
} from "../../../extensions/integrations/registry.ts";
import {
  assertArgv,
  assertSafePath,
  executeCommandAdapter,
  ghPrSearch,
  gitBlame,
  gitLog,
  planSourceControlQuery,
  type ExecLike,
  type ExecRequest,
} from "../../../extensions/integrations/adapters.ts";

const IMPLEMENTED: readonly IntegrationCategory[] = ["source-control", "browser-ui", "cli-tui"];
const PROBE_KINDS = ["source-control", "builtin-tool", "command-adapter"];
const FORMAT_ARG = `--format=%H%x09%an%x09%aI%x09%s`;

const MALFORMED_CASES = [
  {
    label: "command not an array",
    raw: '{"team-chat":{"adapter":"command","command":"node","description":"chat"}}',
    pattern: /command must be a non-empty array of strings/,
  },
  {
    label: "empty command array",
    raw: '{"team-chat":{"adapter":"command","command":[],"description":"chat"}}',
    pattern: /command must be a non-empty array of strings/,
  },
  {
    label: "option as argv[0]",
    raw: '{"team-chat":{"adapter":"command","command":["-x"],"description":"chat"}}',
    pattern: /command\[0\] must be a command name, not an option/,
  },
  {
    label: "adapter not command",
    raw: '{"team-chat":{"adapter":"mcp","command":["node","-e","1"],"description":"chat"}}',
    pattern: /adapter must be "command"/,
  },
  {
    label: "unknown capability key",
    raw: '{"not-a-capability":{"adapter":"command","command":["node","-e","1"],"description":"chat"}}',
    pattern: /unknown capability 'not-a-capability'/,
  },
  { label: "invalid json", raw: "{ not json", pattern: /invalid JSON/ },
];

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeConfig(dir: string, raw: unknown): string {
  const file = join(dir, "integrations.json");
  writeFileSync(file, typeof raw === "string" ? raw : JSON.stringify(raw), "utf8");
  return file;
}

function loadConfigFixture(raw: string): IntegrationsConfig {
  const dir = tempDir("registry-bad-");
  writeConfig(dir, raw);
  return loadIntegrationsConfig(dir);
}

function withEnvDir(run: (dir: string) => void): void {
  const previous = process.env.PSTACK_INTEGRATIONS_DIR;
  const dir = tempDir("registry-env-");
  process.env.PSTACK_INTEGRATIONS_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_INTEGRATIONS_DIR");
    else process.env.PSTACK_INTEGRATIONS_DIR = previous;
  }
}

function captureExec(): { exec: ExecLike; calls: () => ExecRequest[] } {
  let requests: ExecRequest[] = [];
  const exec: ExecLike = (request) => {
    requests = [...requests, request];
    return Promise.resolve({ stdout: "captured", stderr: "", code: 0 });
  };
  return { exec, calls: () => requests };
}

test("integrations-registry-01 inventories the nine capability categories from the policy table", () => {
  const entries = integrationEntries();

  expect(entries.length).toBe(9);
  expect(entries.map((entry) => entry.id)).toEqual(INTEGRATION_CATEGORIES);
  for (const entry of entries) {
    expect(entry.title.trim().length > 0, `${entry.id} has a title`).toBe(true);
    expect(entry.toolName.length > 0, `${entry.id} names a tool`).toBe(true);
    expect(entry.toolName).toBe(INTEGRATION_CAPABILITIES[entry.id][0]);
  }
});

test("integrations-registry-02 reports a missing config entry as unavailable with the prerequisite named", () => {
  const dir = tempDir("registry-missing-");
  const config = loadIntegrationsConfig(dir);
  expect(config.adapters).toEqual({});

  const status = decideStatus(integrationEntry("issue-tracker"), {
    gitWorkTree: true,
    ghOnPath: true,
    config,
  });
  expect(status.availability).toBe("unavailable");
  expect(status.satisfiedBy).toBe(null);
  expect(status.missing?.includes(configPath(dir))).toBe(true);
  expect(status.missing?.includes("issue-tracker")).toBe(true);

  const line = formatStatusLine(status);
  expect(line.includes("unavailable")).toBe(true);
  expect(line.includes("missing")).toBe(true);

  const gap = gapForStatus(status);
  expect(gap.capability).toBe("issue-tracker");
  expect(gap.missing).toBe(status.missing);
});

test("integrations-registry-03 rejects malformed adapter config with a clear error", () => {
  for (const scenario of MALFORMED_CASES) {
    expect(() => loadConfigFixture(scenario.raw), scenario.label).toThrow(scenario.pattern);
  }

  const dir = tempDir("registry-good-");
  const file = writeConfig(dir, {
    "team-chat": { adapter: "command", command: ["node", "-e", "1"], description: "chat" },
  });
  const config = loadIntegrationsConfig(dir);
  expect(config.source).toBe(file);
  expect(config.adapters["team-chat"]?.command).toEqual(["node", "-e", "1"]);
});

test("integrations-registry-04 decides source-control availability from git and gh", () => {
  const config = loadIntegrationsConfig(tempDir("registry-probe-"));
  const entry = integrationEntry("source-control");

  const noTree = decideStatus(entry, { gitWorkTree: false, ghOnPath: true, config });
  expect(noTree.availability).toBe("unavailable");
  expect(noTree.missing?.includes("git rev-parse --is-inside-work-tree")).toBe(true);

  const gitOnly = decideStatus(entry, { gitWorkTree: true, ghOnPath: false, config });
  expect(gitOnly.availability).toBe("available-git-only");
  expect(gitOnly.satisfiedBy?.includes("gh")).toBe(true);

  const full = decideStatus(entry, { gitWorkTree: true, ghOnPath: true, config });
  expect(full.availability).toBe("available");
  expect(AVAILABILITY.includes(full.availability)).toBe(true);

  const cli = integrationEntry("cli-tui");
  const missingTool = decideStatus(cli, {
    gitWorkTree: true,
    ghOnPath: true,
    config,
    registeredTools: ["pstack_control_ui"],
  });
  expect(missingTool.availability).toBe("unavailable");
  expect(missingTool.missing?.includes("pstack_control_cli")).toBe(true);

  const withTool = decideStatus(cli, {
    gitWorkTree: true,
    ghOnPath: true,
    config,
    registeredTools: ["pstack_control_cli"],
  });
  expect(withTool.availability).toBe("available");
});

test("integrations-registry-05 honors PSTACK_INTEGRATIONS_DIR for the config path", () => {
  withEnvDir((dir) => {
    expect(integrationsDir()).toBe(dir);
    expect(configPath()).toBe(join(dir, "integrations.json"));

    const empty = loadIntegrationsConfig();
    expect(empty.source).toBe(join(dir, "integrations.json"));
    expect(empty.adapters).toEqual({});

    writeConfig(dir, {
      "long-form-docs": { adapter: "command", command: ["node", "-e", "1"], description: "docs" },
    });
    const loaded = loadIntegrationsConfig();
    expect(loaded.source).toBe(join(dir, "integrations.json"));
    expect(loaded.adapters["long-form-docs"]?.command).toEqual(["node", "-e", "1"]);
  });
});

test("integrations-registry-06 derives tool names and kinds from the policy capability table", () => {
  for (const id of INTEGRATION_CATEGORIES) {
    expect(capabilityToolName(id)).toBe(INTEGRATION_CAPABILITIES[id][0]);
  }
  expect(isIntegrationCategory("team-chat")).toBe(true);
  expect(isIntegrationCategory("not-a-capability")).toBe(false);

  for (const entry of integrationEntries()) {
    const implemented = IMPLEMENTED.includes(entry.id);
    expect(entry.kind, `${entry.id} kind`).toBe(implemented ? "implemented" : "prerequisite");
    expect(PROBE_KINDS.includes(entry.probeSpec.kind), `${entry.id} probe kind`).toBe(true);
    if (entry.id === "source-control") expect(entry.probeSpec.kind).toBe("source-control");
    if (entry.id === "cli-tui" || entry.id === "browser-ui") expect(entry.probeSpec.kind).toBe("builtin-tool");
    if (!implemented) expect(entry.probeSpec.kind).toBe("command-adapter");
  }
  expect(integrationEntries().filter((entry) => entry.kind === "prerequisite").length).toBe(6);
});

test("integrations-registry-07 never prints configured argv in the status line", () => {
  const dir = tempDir("registry-secret-");
  const argv = ["node", "-e", "process.stdout.write('SECRET-TOKEN-xyz')"];
  writeConfig(dir, {
    "team-chat": { adapter: "command", command: argv, description: "team chat adapter" },
  });
  const config = loadIntegrationsConfig(dir);
  const status = decideStatus(integrationEntry("team-chat"), {
    gitWorkTree: true,
    ghOnPath: true,
    config,
  });

  expect(status.availability).toBe("available");
  const line = formatStatusLine(status);
  const withoutConfigPath = line.split(config.source).join("<config>");

  expect(withoutConfigPath.includes("command adapter 'node' (2 args)")).toBe(true);
  expect(withoutConfigPath.includes("<config>"), "status line names the config source").toBe(true);
  for (const arg of argv.slice(1)) {
    expect(withoutConfigPath.includes(arg), `status line leaks argv element ${arg}`).toBe(false);
  }
  expect(line.includes("SECRET-TOKEN")).toBe(false);
});

test("integrations-registry-08 builds source-control argv and plans the query grammar", async () => {
  expect(gitLog([], 5)).toEqual(["git", "log", "-n5", FORMAT_ARG]);
  expect(gitLog(["src"], 5, "why")).toEqual(["git", "log", "-n5", FORMAT_ARG, "--grep=why", "--", "src"]);
  expect(gitBlame("a.ts", 3)).toEqual(["git", "blame", "-L", "3,3", "--porcelain", "--", "a.ts"]);
  expect(ghPrSearch("term")).toEqual([
    "gh",
    "search",
    "prs",
    "term",
    "--json",
    "number,title,state,url,author",
    "--limit",
    "20",
  ]);

  expect(planSourceControlQuery("", undefined, 5).mode).toBe("log");
  expect(planSourceControlQuery("why", undefined, 5).mode).toBe("log");

  const blame = planSourceControlQuery("blame:src/a.ts:12", undefined, 5);
  expect(blame.mode).toBe("blame");
  expect(blame.requiresGh).toBe(false);
  expect(blame.argv).toEqual(["git", "blame", "-L", "12,12", "--porcelain", "--", "src/a.ts"]);

  const prs = planSourceControlQuery("prs:topic", undefined, 5);
  expect(prs.mode).toBe("prs");
  expect(prs.requiresGh).toBe(true);
  expect(prs.argv).toEqual(ghPrSearch("topic"));

  const capture = captureExec();
  const outcome = await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "topic");
  expect(outcome.stdout).toBe("captured");
  expect(capture.calls()[0]?.command).toBe("node");
  expect(capture.calls()[0]?.args).toEqual(["-e", "1", "topic"]);
  expect(capture.calls()[0]?.timeoutMs).toBe(120_000);

  await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "");
  expect(capture.calls()[1]?.args).toEqual(["-e", "1"]);

  expect(() => assertSafePath("-x", "git log pathspec")).toThrow(/unsafe path/);
  expect(() => assertArgv(["-rf"], "command adapter")).toThrow(/argv\[0\] must be a command name, not an option/);
});

test("integrations-registry-09 advertises only real surfaces and dedupes the shared bridge", () => {
  expect(integrationToolsFor("inherit")).toEqual([
    "pstack_integrations",
    "pstack_control_ui",
    "pstack_control_cli",
  ]);
  expect(integrationToolsFor(["issue-tracker"])).toEqual(["pstack_integrations"]);
  expect(integrationToolsFor(["team-chat", "analytics"])).toEqual(["pstack_integrations"]);
  expect(integrationToolsFor(["cli-tui"])).toEqual(["pstack_control_cli"]);
  expect(integrationToolsFor("none")).toEqual([]);

  for (const entry of integrationEntries()) {
    expect(entry.toolName === "pstack_integrations" || entry.toolName.startsWith("pstack_control_"), `${entry.id} must name a registered surface, got ${entry.toolName}`).toBe(true);
  }
});
