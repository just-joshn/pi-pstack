import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTEGRATION_CATEGORIES,
  INTEGRATION_CAPABILITIES,
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

  assert.equal(entries.length, 9);
  assert.deepEqual(
    entries.map((entry) => entry.id),
    INTEGRATION_CATEGORIES,
  );
  for (const entry of entries) {
    assert.equal(entry.title.trim().length > 0, true, `${entry.id} has a title`);
    assert.equal(entry.toolName.length > 0, true, `${entry.id} names a tool`);
    assert.equal(entry.toolName, INTEGRATION_CAPABILITIES[entry.id][0]);
  }
});

test("integrations-registry-02 reports a missing config entry as unavailable with the prerequisite named", () => {
  const dir = tempDir("registry-missing-");
  const config = loadIntegrationsConfig(dir);
  assert.deepEqual(config.adapters, {});

  const status = decideStatus(integrationEntry("issue-tracker"), {
    gitWorkTree: true,
    ghOnPath: true,
    config,
  });
  assert.equal(status.availability, "unavailable");
  assert.equal(status.satisfiedBy, null);
  assert.equal(status.missing?.includes(configPath(dir)), true);
  assert.equal(status.missing?.includes("issue-tracker"), true);

  const line = formatStatusLine(status);
  assert.equal(line.includes("unavailable"), true);
  assert.equal(line.includes("missing"), true);

  const gap = gapForStatus(status);
  assert.equal(gap.capability, "issue-tracker");
  assert.equal(gap.missing, status.missing);
});

test("integrations-registry-03 rejects malformed adapter config with a clear error", () => {
  for (const scenario of MALFORMED_CASES) {
    assert.throws(() => loadConfigFixture(scenario.raw), scenario.pattern, scenario.label);
  }

  const dir = tempDir("registry-good-");
  const file = writeConfig(dir, {
    "team-chat": { adapter: "command", command: ["node", "-e", "1"], description: "chat" },
  });
  const config = loadIntegrationsConfig(dir);
  assert.equal(config.source, file);
  assert.deepEqual(config.adapters["team-chat"]?.command, ["node", "-e", "1"]);
});

test("integrations-registry-04 decides source-control availability from git and gh", () => {
  const config = loadIntegrationsConfig(tempDir("registry-probe-"));
  const entry = integrationEntry("source-control");

  const noTree = decideStatus(entry, { gitWorkTree: false, ghOnPath: true, config });
  assert.equal(noTree.availability, "unavailable");
  assert.equal(noTree.missing?.includes("git rev-parse --is-inside-work-tree"), true);

  const gitOnly = decideStatus(entry, { gitWorkTree: true, ghOnPath: false, config });
  assert.equal(gitOnly.availability, "available-git-only");
  assert.equal(gitOnly.satisfiedBy?.includes("gh"), true);

  const full = decideStatus(entry, { gitWorkTree: true, ghOnPath: true, config });
  assert.equal(full.availability, "available");
  assert.equal(AVAILABILITY.includes(full.availability), true);

  const cli = integrationEntry("cli-tui");
  const missingTool = decideStatus(cli, {
    gitWorkTree: true,
    ghOnPath: true,
    config,
    registeredTools: ["pstack_control_ui"],
  });
  assert.equal(missingTool.availability, "unavailable");
  assert.equal(missingTool.missing?.includes("pstack_control_cli"), true);

  const withTool = decideStatus(cli, {
    gitWorkTree: true,
    ghOnPath: true,
    config,
    registeredTools: ["pstack_control_cli"],
  });
  assert.equal(withTool.availability, "available");
});

test("integrations-registry-05 honors PSTACK_INTEGRATIONS_DIR for the config path", () => {
  withEnvDir((dir) => {
    assert.equal(integrationsDir(), dir);
    assert.equal(configPath(), join(dir, "integrations.json"));

    const empty = loadIntegrationsConfig();
    assert.equal(empty.source, join(dir, "integrations.json"));
    assert.deepEqual(empty.adapters, {});

    writeConfig(dir, {
      "long-form-docs": { adapter: "command", command: ["node", "-e", "1"], description: "docs" },
    });
    const loaded = loadIntegrationsConfig();
    assert.equal(loaded.source, join(dir, "integrations.json"));
    assert.deepEqual(loaded.adapters["long-form-docs"]?.command, ["node", "-e", "1"]);
  });
});

test("integrations-registry-06 derives tool names and kinds from the policy capability table", () => {
  for (const id of INTEGRATION_CATEGORIES) {
    assert.equal(capabilityToolName(id), INTEGRATION_CAPABILITIES[id][0]);
  }
  assert.equal(isIntegrationCategory("team-chat"), true);
  assert.equal(isIntegrationCategory("not-a-capability"), false);

  for (const entry of integrationEntries()) {
    const implemented = IMPLEMENTED.includes(entry.id);
    assert.equal(entry.kind, implemented ? "implemented" : "prerequisite", `${entry.id} kind`);
    assert.equal(PROBE_KINDS.includes(entry.probeSpec.kind), true, `${entry.id} probe kind`);
    if (entry.id === "source-control") assert.equal(entry.probeSpec.kind, "source-control");
    if (entry.id === "cli-tui" || entry.id === "browser-ui") assert.equal(entry.probeSpec.kind, "builtin-tool");
    if (!implemented) assert.equal(entry.probeSpec.kind, "command-adapter");
  }
  assert.equal(integrationEntries().filter((entry) => entry.kind === "prerequisite").length, 6);
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

  assert.equal(status.availability, "available");
  const line = formatStatusLine(status);
  const withoutConfigPath = line.split(config.source).join("<config>");

  assert.equal(withoutConfigPath.includes("command adapter 'node' (2 args)"), true);
  assert.equal(withoutConfigPath.includes("<config>"), true, "status line names the config source");
  for (const arg of argv.slice(1)) {
    assert.equal(withoutConfigPath.includes(arg), false, `status line leaks argv element ${arg}`);
  }
  assert.equal(line.includes("SECRET-TOKEN"), false);
});

test("integrations-registry-08 builds source-control argv and plans the query grammar", async () => {
  assert.deepEqual(gitLog([], 5), ["git", "log", "-n5", FORMAT_ARG]);
  assert.deepEqual(gitLog(["src"], 5, "why"), ["git", "log", "-n5", FORMAT_ARG, "--grep=why", "--", "src"]);
  assert.deepEqual(gitBlame("a.ts", 3), ["git", "blame", "-L", "3,3", "--porcelain", "--", "a.ts"]);
  assert.deepEqual(ghPrSearch("term"), [
    "gh",
    "search",
    "prs",
    "term",
    "--json",
    "number,title,state,url,author",
    "--limit",
    "20",
  ]);

  assert.equal(planSourceControlQuery("", undefined, 5).mode, "log");
  assert.equal(planSourceControlQuery("why", undefined, 5).mode, "log");

  const blame = planSourceControlQuery("blame:src/a.ts:12", undefined, 5);
  assert.equal(blame.mode, "blame");
  assert.equal(blame.requiresGh, false);
  assert.deepEqual(blame.argv, ["git", "blame", "-L", "12,12", "--porcelain", "--", "src/a.ts"]);

  const prs = planSourceControlQuery("prs:topic", undefined, 5);
  assert.equal(prs.mode, "prs");
  assert.equal(prs.requiresGh, true);
  assert.deepEqual(prs.argv, ghPrSearch("topic"));

  const capture = captureExec();
  const outcome = await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "topic");
  assert.equal(outcome.stdout, "captured");
  assert.equal(capture.calls()[0]?.command, "node");
  assert.deepEqual(capture.calls()[0]?.args, ["-e", "1", "topic"]);
  assert.equal(capture.calls()[0]?.timeoutMs, 120_000);

  await executeCommandAdapter(capture.exec, ["node", "-e", "1"], "");
  assert.deepEqual(capture.calls()[1]?.args, ["-e", "1"]);

  assert.throws(() => assertSafePath("-x", "git log pathspec"), /unsafe path/);
  assert.throws(() => assertArgv(["-rf"], "command adapter"), /argv\[0\] must be a command name, not an option/);
});
