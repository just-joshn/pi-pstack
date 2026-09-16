import { expect, test } from "vitest";
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
  expect(compileTaskPolicy(undefined, "investigator")).toEqual({
    ...BASE,
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "inherit",
  });
  expect(compileTaskPolicy(undefined, "comment-sicko")).toEqual({
    ...BASE,
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "none",
  });
  expect(compileTaskPolicy(undefined, "poteto-agent")).toEqual(BASE);
  expect(compileTaskPolicy(undefined, "general")).toEqual(BASE);
  expect(ROLE_POLICY_DEFAULTS["poteto-agent"]).toEqual(ROLE_POLICY_DEFAULTS.general);
  expect(defaultsForRole("auditor-role")).toEqual(ROLE_POLICY_DEFAULTS.general);
  expect(Object.isFrozen(compileTaskPolicy(undefined, "investigator"))).toBe(true);
});

test("explicit overrides replace one axis without disturbing the others", () => {
  const policy = compileTaskPolicy({ shell: "restricted", network: "none" }, "general");
  expect(policy.shell).toBe("restricted");
  expect(policy.network).toBe("none");
  expect(policy.filesystem).toBe("workspace-write");
  expect(policy.git).toBe("branch-write");
  expect(policy.integrations).toBe("inherit");
});

test("readonly forces filesystem, shell, and git while integrations survive", () => {
  const investigator = compileTaskPolicy({ readonly: true }, "investigator");
  expect(investigator.filesystem).toBe("read-only");
  expect(investigator.shell).toBe("none");
  expect(investigator.git).toBe("read");
  expect(investigator.integrations, "read-only files do not imply integrations none").toBe("inherit");

  const general = compileTaskPolicy(
    { readonly: true, integrations: ["browser-ui", "team-chat"] },
    "general",
  );
  expect(general.filesystem).toBe("read-only");
  expect(general.integrations).toEqual(["browser-ui", "team-chat"]);
  expect(Object.isFrozen(general.integrations)).toBe(true);
});

test("invalid policy enums throw naming the field and its allowed values", () => {
  expect(() => compileTaskPolicy({ filesystem: "readwrite" }, "general")).toThrow(/invalid filesystem 'readwrite'; allowed: read-only, workspace-write/);
  expect(() => compileTaskPolicy({ shell: "some" }, "general")).toThrow(/invalid shell 'some'; allowed: none, restricted, full/);
  expect(() => compileTaskPolicy({ git: "write" }, "general")).toThrow(/invalid git 'write'; allowed: read, branch-write, push, merge/);
  expect(() => compileTaskPolicy({ network: "open" }, "general")).toThrow(/invalid network 'open'; allowed: none, allowed/);
  expect(() => compileTaskPolicy({ isolation: "pod" }, "general")).toThrow(/invalid isolation 'pod'/);
  expect(() => compileTaskPolicy({ environment: "cloud" }, "general")).toThrow(/invalid environment 'cloud'/);
  expect(() => compileTaskPolicy({ integrations: 7 }, "general")).toThrow(/invalid integrations '7'/);
  expect(() => compileTaskPolicy({ integrations: [""] }, "general")).toThrow(/invalid integrations/);
  expect(() => compileTaskPolicy({ integrations: ["typo-capability"] }, "general"), "an unknown capability name is rejected at compile time, not when the tool list is resolved").toThrow(/invalid integrations/);
  expect(() => compileTaskPolicy({ readonly: "yes" }, "general")).toThrow(/invalid readonly 'yes'; allowed: true, false/);
  expect(() => resolveThinkingLevel({ thinkingLevel: "turbo" }, undefined)).toThrow(/invalid thinkingLevel 'turbo'/);
});

test("worktree and hosted force the isolation axis", () => {
  expect(compileTaskPolicy({ worktree: true }, "general").isolation).toBe("worktree");
  expect(compileTaskPolicy({ environment: "hosted" }, "general").isolation).toBe("remote");
  expect(compileTaskPolicy({ environment: "hosted", isolation: "container" }, "general").isolation, "a stronger explicit sandbox survives hosted placement").toBe("container");
  expect(compileTaskPolicy({ environment: "hosted", worktree: true }, "general").isolation).toBe("remote");
  expect(compileTaskPolicy({ isolation: "process" }, "general").isolation).toBe("process");
});

test("resolvePolicyTools prefers explicit tools, then read-only plus granted integrations", () => {
  const investigator = compileTaskPolicy(undefined, "investigator");
  expect(resolvePolicyTools(investigator, undefined, ["read", "write", "bash"])).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    "pstack_integrations",
    "pstack_control_ui",
    "pstack_control_cli",
  ]);
  const commentSicko = compileTaskPolicy(undefined, "comment-sicko");
  expect(resolvePolicyTools(commentSicko, undefined, ["read", "write"])).toEqual([
    "read",
    "grep",
    "find",
    "ls",
  ]);
  const cliOnly = compileTaskPolicy({ integrations: ["cli-tui"] }, "investigator");
  expect(resolvePolicyTools(cliOnly, undefined, ["read"])).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    "pstack_control_cli",
  ]);
  expect(resolvePolicyTools(investigator, ["bash", "read"], ["read"])).toEqual(["bash", "read"]);
  const shellNone = compileTaskPolicy({ shell: "none" }, "general");
  expect(resolvePolicyTools(shellNone, undefined, ["read", "bash", "edit"])).toEqual(["read", "edit"]);
  const shellNoneWithoutParentList = resolvePolicyTools(shellNone, undefined, undefined);
  expect(shellNoneWithoutParentList, "no parent list means no allowlist; the guard is the backstop").toBe(undefined);
  const full = compileTaskPolicy(undefined, "general");
  expect(resolvePolicyTools(full, undefined, ["read", "bash"])).toEqual(["read", "bash"]);
  expect(resolvePolicyTools(full, undefined, undefined)).toBe(undefined);
});

test("resolveThinkingLevel honors an explicit level, a selector suffix, and rejects garbage", () => {
  expect(resolveThinkingLevel({ thinkingLevel: "xhigh" }, "xai/grok-4:max")).toBe("xhigh");
  expect(resolveThinkingLevel(undefined, "xai/grok-4:max")).toBe("max");
  expect(resolveThinkingLevel({}, "anthropic/claude-sonnet-4-5")).toBe(undefined);
  expect(resolveThinkingLevel(undefined, undefined)).toBe(undefined);
  expect(resolveThinkingLevel(undefined, "xai/grok-4"), "no suffix means no level").toBe(undefined);
});

test("integration capabilities cover the nine mandated categories with one pattern table", () => {
  expect(INTEGRATION_CATEGORIES).toEqual([
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
  expect(Object.isFrozen(INTEGRATION_CATEGORIES)).toBe(true);
  for (const category of INTEGRATION_CATEGORIES) {
    expect(Array.isArray(INTEGRATION_CAPABILITIES[category]), `${category} needs patterns`).toBe(true);
  }
  expect(capabilityForTool("pstack_control_ui")).toBe("browser-ui");
  expect(capabilityForTool("pstack_control_cli")).toBe("cli-tui");
  expect(capabilityForTool("pstack_integrations"), "a tool serving many categories is attributed to none of them").toBe(undefined);
  expect(capabilityForTool("read")).toBe(undefined);
});

test("describePolicy renders one line with every axis", () => {
  expect(describePolicy(compileTaskPolicy(undefined, "investigator"))).toBe("filesystem=read-only shell=none git=read network=none integrations=inherit environment=local background=false isolation=session");
  expect(describePolicy(compileTaskPolicy({ integrations: ["browser-ui", "cli-tui"] }, "general"))).toBe("filesystem=workspace-write shell=full git=branch-write network=allowed integrations=browser-ui|cli-tui environment=local background=false isolation=session");
});
