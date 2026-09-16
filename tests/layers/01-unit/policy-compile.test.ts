import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRATION_CAPABILITIES,
  INTEGRATION_CATEGORIES,
  ROLE_POLICY_DEFAULTS,
  capabilityForTool,
  compileTaskPolicy,
  defaultsForRole,
  describePolicy,
  resolvePolicyTools,
  resolveThinkingLevel,
} from "../../../extensions/agents/policy.ts";

const BASE = {
  filesystem: "workspace-write",
  shell: "full",
  git: "branch-write",
  network: "allowed",
  integrations: "inherit",
  environment: "local",
  background: false,
  isolation: "session",
} as const;

test("role defaults keep a read-only filesystem with inherited integrations", () => {
  assert.deepEqual(compileTaskPolicy(undefined, "investigator"), {
    ...BASE,
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "inherit",
  });
  assert.deepEqual(compileTaskPolicy(undefined, "comment-sicko"), {
    ...BASE,
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "none",
  });
  assert.deepEqual(compileTaskPolicy(undefined, "poteto-agent"), BASE);
  assert.deepEqual(compileTaskPolicy(undefined, "general"), BASE);
  assert.deepEqual(ROLE_POLICY_DEFAULTS["poteto-agent"], ROLE_POLICY_DEFAULTS.general);
  assert.deepEqual(defaultsForRole("auditor-role"), ROLE_POLICY_DEFAULTS.general);
  assert.equal(Object.isFrozen(compileTaskPolicy(undefined, "investigator")), true);
});

test("explicit overrides replace one axis without disturbing the others", () => {
  const policy = compileTaskPolicy({ shell: "restricted", network: "none" }, "general");
  assert.equal(policy.shell, "restricted");
  assert.equal(policy.network, "none");
  assert.equal(policy.filesystem, "workspace-write");
  assert.equal(policy.git, "branch-write");
  assert.equal(policy.integrations, "inherit");
});

test("readonly forces filesystem, shell, and git while integrations survive", () => {
  const investigator = compileTaskPolicy({ readonly: true }, "investigator");
  assert.equal(investigator.filesystem, "read-only");
  assert.equal(investigator.shell, "none");
  assert.equal(investigator.git, "read");
  assert.equal(investigator.integrations, "inherit", "read-only files do not imply integrations none");

  const general = compileTaskPolicy(
    { readonly: true, integrations: ["browser-ui", "team-chat"] },
    "general",
  );
  assert.equal(general.filesystem, "read-only");
  assert.deepEqual(general.integrations, ["browser-ui", "team-chat"]);
  assert.equal(Object.isFrozen(general.integrations), true);
});

test("invalid policy enums throw naming the field and its allowed values", () => {
  assert.throws(
    () => compileTaskPolicy({ filesystem: "readwrite" }, "general"),
    /invalid filesystem 'readwrite'; allowed: read-only, workspace-write/,
  );
  assert.throws(() => compileTaskPolicy({ shell: "some" }, "general"), /invalid shell 'some'; allowed: none, restricted, full/);
  assert.throws(() => compileTaskPolicy({ git: "write" }, "general"), /invalid git 'write'; allowed: read, branch-write, push, merge/);
  assert.throws(() => compileTaskPolicy({ network: "open" }, "general"), /invalid network 'open'; allowed: none, allowed/);
  assert.throws(() => compileTaskPolicy({ isolation: "pod" }, "general"), /invalid isolation 'pod'/);
  assert.throws(() => compileTaskPolicy({ environment: "cloud" }, "general"), /invalid environment 'cloud'/);
  assert.throws(() => compileTaskPolicy({ integrations: 7 }, "general"), /invalid integrations '7'/);
  assert.throws(() => compileTaskPolicy({ integrations: [""] }, "general"), /invalid integrations/);
  assert.throws(() => compileTaskPolicy({ readonly: "yes" }, "general"), /invalid readonly 'yes'; allowed: true, false/);
  assert.throws(() => resolveThinkingLevel({ thinkingLevel: "turbo" }, undefined), /invalid thinkingLevel 'turbo'/);
});

test("worktree and hosted force the isolation axis", () => {
  assert.equal(compileTaskPolicy({ worktree: true }, "general").isolation, "worktree");
  assert.equal(compileTaskPolicy({ environment: "hosted" }, "general").isolation, "remote");
  assert.equal(
    compileTaskPolicy({ environment: "hosted", isolation: "container" }, "general").isolation,
    "container",
    "a stronger explicit sandbox survives hosted placement",
  );
  assert.equal(compileTaskPolicy({ environment: "hosted", worktree: true }, "general").isolation, "remote");
  assert.equal(compileTaskPolicy({ isolation: "process" }, "general").isolation, "process");
});

test("resolvePolicyTools prefers explicit tools, then read-only plus granted integrations", () => {
  const investigator = compileTaskPolicy(undefined, "investigator");
  assert.deepEqual(resolvePolicyTools(investigator, undefined, ["read", "write", "bash"]), [
    "read",
    "grep",
    "find",
    "ls",
    "pstack_integrations",
    "pstack_control_ui",
    "pstack_control_cli",
  ]);
  const commentSicko = compileTaskPolicy(undefined, "comment-sicko");
  assert.deepEqual(resolvePolicyTools(commentSicko, undefined, ["read", "write"]), [
    "read",
    "grep",
    "find",
    "ls",
  ]);
  const cliOnly = compileTaskPolicy({ integrations: ["cli-tui"] }, "investigator");
  assert.deepEqual(resolvePolicyTools(cliOnly, undefined, ["read"]), [
    "read",
    "grep",
    "find",
    "ls",
    "pstack_control_cli",
  ]);
  assert.deepEqual(resolvePolicyTools(investigator, ["bash", "read"], ["read"]), ["bash", "read"]);
  const shellNone = compileTaskPolicy({ shell: "none" }, "general");
  assert.deepEqual(resolvePolicyTools(shellNone, undefined, ["read", "bash", "edit"]), ["read", "edit"]);
  const shellNoneWithoutParentList = resolvePolicyTools(shellNone, undefined, undefined);
  assert.equal(shellNoneWithoutParentList, undefined, "no parent list means no allowlist; the guard is the backstop");
  const full = compileTaskPolicy(undefined, "general");
  assert.deepEqual(resolvePolicyTools(full, undefined, ["read", "bash"]), ["read", "bash"]);
  assert.equal(resolvePolicyTools(full, undefined, undefined), undefined);
});

test("resolveThinkingLevel honors an explicit level, a selector suffix, and rejects garbage", () => {
  assert.equal(resolveThinkingLevel({ thinkingLevel: "xhigh" }, "xai/grok-4:max"), "xhigh");
  assert.equal(resolveThinkingLevel(undefined, "xai/grok-4:max"), "max");
  assert.equal(resolveThinkingLevel({}, "anthropic/claude-sonnet-4-5"), undefined);
  assert.equal(resolveThinkingLevel(undefined, undefined), undefined);
  assert.equal(resolveThinkingLevel(undefined, "xai/grok-4"), undefined, "no suffix means no level");
});

test("integration capabilities cover the nine mandated categories with one pattern table", () => {
  assert.deepEqual(INTEGRATION_CATEGORIES, [
    "source-control",
    "issue-tracker",
    "long-form-docs",
    "team-chat",
    "observability",
    "error-tracking",
    "analytics",
    "browser-ui",
    "cli-tui",
  ]);
  assert.equal(Object.isFrozen(INTEGRATION_CATEGORIES), true);
  for (const category of INTEGRATION_CATEGORIES) {
    assert.equal(Array.isArray(INTEGRATION_CAPABILITIES[category]), true, `${category} needs patterns`);
  }
  assert.equal(capabilityForTool("pstack_control_ui"), "browser-ui");
  assert.equal(capabilityForTool("pstack_control_cli"), "cli-tui");
  assert.equal(
    capabilityForTool("pstack_integrations"),
    undefined,
    "a tool serving many categories is attributed to none of them",
  );
  assert.equal(capabilityForTool("read"), undefined);
});

test("describePolicy renders one line with every axis", () => {
  assert.equal(
    describePolicy(compileTaskPolicy(undefined, "investigator")),
    "filesystem=read-only shell=none git=read network=none integrations=inherit environment=local background=false isolation=session",
  );
  assert.equal(
    describePolicy(compileTaskPolicy({ integrations: ["browser-ui", "cli-tui"] }, "general")),
    "filesystem=workspace-write shell=full git=branch-write network=allowed integrations=browser-ui|cli-tui environment=local background=false isolation=session",
  );
});
