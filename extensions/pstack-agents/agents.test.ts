import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { packageResources } from "../package-resources.ts";
import {
  createAgentParseWarningReporter,
  modelMatchesScope,
  loadTaskContext,
  withGuardExtensions,
  parseAgentDefinition,
  parseAgentFiles,
  parseModelScope,
  parseTaskInput,
  resolveAgent,
  resolveResumeExecution,
  selectAgentTools,
  selectContextFiles,
  type AgentDefinition,
  type ParentTaskContext,
  type TaskToolInput,
} from "./agents.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pstack-agents-test-"));
  tempRoots.push(root);
  return root;
}

function putAgent(directory: string, fileName: string, name: string, fields = "", prompt = "Do the task."): string {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${fileName}.md`);
  const content = `---\nname: ${name}\ndescription: Test agent${fields ? `\n${fields}` : ""}\n---\n${prompt}\n`;
  writeFileSync(filePath, content);
  return filePath;
}

function agent(name: string, tools?: string[]): AgentDefinition {
  const fields = [
    tools ? `tools: ${tools.join(", ")}` : "",
    "inheritProjectContext: false",
    "inheritGlobalContext: false",
    "inheritSkills: false",
  ].filter(Boolean).join("\n");
  const parsed = parseAgentDefinition(`---\nname: ${name}\ndescription: Test agent\n${fields}\n---\nDo the task.`, "/agents/test.md", "user");
  if (!parsed) throw new Error(`Agent fixture ${name} did not parse`);
  return parsed;
}

function taskContext(agentDir: string, cwd: string, overrides: Partial<ParentTaskContext> = {}): ParentTaskContext {
  mkdirSync(cwd, { recursive: true });
  return {
    agentDir,
    cwd,
    projectTrusted: false,
    parentModel: "openai-codex/gpt-6-luna",
    thinkingLevel: "low",
    depth: 0,
    nestingAllowed: false,
    activeTools: ["read", "bash", "Task"],
    allTools: [
      { name: "read", sourcePath: "builtin" },
      { name: "grep", sourcePath: "builtin" },
      { name: "find", sourcePath: "builtin" },
      { name: "ls", sourcePath: "builtin" },
      { name: "bash", sourcePath: "builtin" },
      { name: "Task", sourcePath: "/extensions/pstack-agents/index.ts" },
    ],
    modelScope: { enforce: true, allow: ["openai-codex/gpt-6-luna", "inherit"] },
    ...overrides,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent resolution", () => {
  test("resolves bundled agents from an empty user agent directory", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "empty-agent-dir");
    const cwd = path.join(root, "project");
    mkdirSync(agentDir, { recursive: true });

    const agents = parseAgentFiles({ agentDir, cwd, projectTrusted: false });
    const requestedNames = ["generalPurpose", "poteto-agent", "pstack-general", "pstack-reader", "Comment Sicko"];

    expect(requestedNames.map((name) => String(resolveAgent(name, agents).name))).toEqual([
      "pstack-general",
      "poteto-agent",
      "pstack-general",
      "pstack-reader",
      "Comment Sicko",
    ]);
    expect(requestedNames.map((name) => resolveAgent(name, agents).source)).toEqual([
      "package",
      "package",
      "package",
      "package",
      "package",
    ]);
  });

  test("loads trusted project agents and lets them override user agents by name", () => {
    const root = tempRoot();
    const userDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    putAgent(path.join(userDir, "agents"), "general", "pstack-general", "tools: read");
    putAgent(path.join(cwd, ".pi", "agents"), "general", "pstack-general", "tools: grep");
    putAgent(path.join(cwd, ".pi", "agents"), "local", "local-agent", "tools: read");

    expect(resolveAgent("pstack-general", parseAgentFiles({ agentDir: userDir, cwd, projectTrusted: false })).source).toBe("user");

    const agents = parseAgentFiles({ agentDir: userDir, cwd, projectTrusted: true });
    expect(resolveAgent("pstack-general", agents).source).toBe("project");
    expect(resolveAgent("local-agent", agents).source).toBe("project");
    expect(String(resolveAgent("generalPurpose", agents).name)).toBe("pstack-general");
  });

  test("reports why a malformed agent file was skipped", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    const directory = path.join(agentDir, "agents");
    mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, "broken.md");
    writeFileSync(filePath, "---\nname: broken\ndescription: Broken\nallowNestedSubagents: yes\n---\nPrompt.\n");
    const skipped: string[] = [];

    const agents = parseAgentFiles({
      agentDir,
      cwd,
      projectTrusted: false,
      onSkipped: (path, reason) => skipped.push(`${path}: ${reason}`),
    });
    expect(agents.some((item) => item.name === "broken")).toBe(false);
    expect(agents.some((item) => item.source === "package")).toBe(true);
    expect(skipped).toEqual([`${filePath}: Agent frontmatter allowNestedSubagents must be a boolean`]);
  });

  test("reports each skipped file and reason once per session", () => {
    const report = createAgentParseWarningReporter();
    const warnings: string[] = [];
    const notify = (message: string) => { warnings.push(message); };
    const filePath = "/agents/broken.md";

    report("session-a", filePath, "invalid model", notify);
    report("session-a", filePath, "invalid model", notify);
    report("session-a", filePath, "invalid name", notify);
    report("session-b", filePath, "invalid model", notify);
    report("session-a", filePath, "invalid model", notify);

    expect(warnings).toEqual([
      `Skipped agent file ${filePath}: invalid model`,
      `Skipped agent file ${filePath}: invalid name`,
      `Skipped agent file ${filePath}: invalid model`,
    ]);
  });

  test("does not resolve project agents from an untrusted workspace", () => {
    const root = tempRoot();
    const userDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    putAgent(path.join(cwd, ".pi", "agents"), "local", "local-agent");
    const agents = parseAgentFiles({ agentDir: userDir, cwd, projectTrusted: false });
    expect(agents.some((item) => item.name === "local-agent")).toBe(false);
    expect(agents.every((item) => item.source === "package")).toBe(true);
  });

  test("parses agent flags and ignores async frontmatter", () => {
    const parsed = parseAgentDefinition(
      "---\nname: worker\ndescription: Worker\ntools: read, bash\nasync: true\nsystemPromptMode: replace\ninheritProjectContext: false\nallowNestedSubagents: true\n---\nPrompt body",
      "/worker.md",
      "user",
    );
    expect(parsed).toMatchObject({
      name: "worker",
      tools: ["read", "bash"],
      systemPrompt: "Prompt body",
      systemPromptMode: "replace",
      inheritProjectContext: false,
      allowNestedSubagents: true,
    });
  });

  test("rejects invalid typed frontmatter rather than treating it as permission", () => {
    expect(() => parseAgentDefinition("---\nname: bad\ndescription: Bad\nallowNestedSubagents: yes\n---\n", "/bad.md", "user")).toThrow("allowNestedSubagents must be a boolean");
    expect(parseAgentDefinition("---\nname: ../bad\ndescription: Bad\n---\n", "/bad.md", "user")).toBeUndefined();
  });
});

describe("model scope", () => {
  test("checks explicit model IDs against case-insensitive glob patterns", () => {
    const policy = parseModelScope({ modelScope: { enforce: true, allow: ["OpenAI-Codex/gpt-6-*", "inherit"] } });
    expect(modelMatchesScope("openai-codex/gpt-6-luna:low", policy, false)).toBe(true);
    expect(modelMatchesScope("anthropic/claude-sonnet-5", policy, false)).toBe(false);
    expect(modelMatchesScope("anthropic/claude-sonnet-5", policy, true)).toBe(true);
  });

  test("does not bypass enforced scopes with a malformed model-scope setting", () => {
    expect(() => parseModelScope({ modelScope: { enforce: true, allow: ["model", 4] } })).toThrow("allow must contain only strings");
  });

  test("fails closed on non-ENOENT reads and names the model-scope file", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "custom-agent-dir");
    const cwd = path.join(root, "project");
    const configPath = path.join(agentDir, "extensions", "pstack-agents.json");
    mkdirSync(configPath, { recursive: true });
    const load = () => loadTaskContext({
      cwd,
      projectTrusted: false,
      depth: 0,
      nestingAllowed: false,
      activeTools: [],
      allTools: [],
    }, agentDir);

    expect(load).toThrow(configPath);
  });

  test("rejects a wrongly shaped modelScope key and names the model-scope file", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "custom-agent-dir");
    const cwd = path.join(root, "project");
    const configPath = path.join(agentDir, "extensions", "pstack-agents.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ modelScope: [] }));
    const load = () => loadTaskContext({
      cwd,
      projectTrusted: false,
      depth: 0,
      nestingAllowed: false,
      activeTools: [],
      allTools: [],
    }, agentDir);

    expect(load).toThrow(configPath);
  });

  test("names the file when model-scope JSON is invalid", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "custom-agent-dir");
    const cwd = path.join(root, "project");
    const configPath = path.join(agentDir, "extensions", "pstack-agents.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{");
    const load = () => loadTaskContext({
      cwd,
      projectTrusted: false,
      depth: 0,
      nestingAllowed: false,
      activeTools: [],
      allTools: [],
    }, agentDir);

    expect(load).toThrow(`Invalid JSON in ${configPath}`);
  });

  test("loads model scope from pstack-agents.json and ignores settings.json", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "configured-agent");
    const settingsOnlyDir = path.join(root, "settings-only-agent");
    const cwd = path.join(root, "project");
    putAgent(path.join(agentDir, "agents"), "worker", "worker", "tools: read");
    mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    writeFileSync(path.join(agentDir, "extensions", "pstack-agents.json"), JSON.stringify({
      modelScope: { enforce: true, allow: ["anthropic/allowed"] },
    }));
    mkdirSync(settingsOnlyDir, { recursive: true });
    writeFileSync(path.join(settingsOnlyDir, "settings.json"), JSON.stringify({
      subagents: { modelScope: { enforce: true, allow: ["anthropic/allowed"] } },
    }));

    const context = taskContext(agentDir, cwd);
    const loaded = loadTaskContext({
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
      parentModel: context.parentModel,
      thinkingLevel: context.thinkingLevel,
      depth: context.depth,
      nestingAllowed: context.nestingAllowed,
      activeTools: context.activeTools,
      allTools: context.allTools,
    }, agentDir);

    expect(loaded.modelScope).toEqual({ enforce: true, allow: ["anthropic/allowed"] });
    expect(() => parseTaskInput({
      description: "Use the scoped model",
      prompt: "Return a result.",
      subagent_type: "worker",
      model: "openai-codex/gpt-6-luna",
    }, loaded)).toThrow("Model openai-codex/gpt-6-luna is outside pstack-agents.json modelScope.allow");
    expect(loadTaskContext({
      cwd,
      projectTrusted: false,
      depth: 0,
      nestingAllowed: false,
      activeTools: [],
      allTools: [],
    }, settingsOnlyDir).modelScope).toBeUndefined();
  });
});

describe("context inheritance", () => {
  test("allows global context without inheriting project context", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "user");
    const files = [
      { path: path.join(agentDir, "AGENTS.md"), content: "global" },
      { path: path.join(root, "project", "AGENTS.md"), content: "project" },
    ];
    expect(selectContextFiles({ files, agentDir, inheritProjectContext: false, inheritGlobalContext: true })).toEqual([files[0]]);
    expect(selectContextFiles({ files, agentDir, inheritProjectContext: true, inheritGlobalContext: false })).toEqual([files[1]]);
  });
});

describe("readonly tool selection", () => {
  test("retains only the closed read-only tool set and its matching extensions", () => {
    const selected = selectAgentTools({
      agent: agent("reader", ["read", "grep", "Task", "bash", "write"]),
      activeTools: ["read"],
      allTools: [
        { name: "read", sourcePath: "builtin" },
        { name: "grep", sourcePath: "builtin" },
        { name: "Task", sourcePath: "/extensions/pstack-agents/index.ts" },
        { name: "bash", sourcePath: "builtin" },
        { name: "write", sourcePath: "builtin" },
      ],
      readonly: true,
    });
    expect(selected).toEqual({ tools: ["read", "grep"], extensionPaths: [] });
    expect(selectAgentTools({
      agent: agent("worker", ["read", "Task"]),
      activeTools: ["read", "Task"],
      allTools: [
        { name: "read", sourcePath: "builtin" },
        { name: "Task", sourcePath: "/extensions/pstack-agents/index.ts" },
      ],
      readonly: false,
    }).tools).toEqual(["read"]);
  });

  test("resolves configured read-only built-ins when the parent tool set is narrower", () => {
    const selected = selectAgentTools({
      agent: agent("pstack-reader", ["read", "grep", "find", "ls", "bash"]),
      activeTools: ["read", "Task"],
      allTools: [
        { name: "read", sourcePath: "builtin" },
        { name: "Task", sourcePath: "/extensions/pstack-agents/index.ts" },
      ],
      readonly: true,
    });

    expect(selected).toEqual({ tools: ["read", "grep", "find", "ls"], extensionPaths: [] });
  });

  test("rejects requested tool names that are not registered in the parent", () => {
    expect(() => selectAgentTools({
      agent: agent("worker", ["not-registered"]),
      activeTools: [],
      allTools: [],
      readonly: false,
    })).toThrow("unavailable tools: not-registered");
  });
});

describe("resume execution settings", () => {
  const previous = {
    environment: "cloud" as const,
    cloudBaseBranch: "origin/main",
    worktreeBaseCommit: "abc123",
  };

  test("inherits or accepts the same execution environment and cloud branch", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(resolveResumeExecution({ id, previous, requested: {} })).toEqual({
      environment: "cloud",
      cloudBaseBranch: "origin/main",
    });
    expect(resolveResumeExecution({
      id,
      previous,
      requested: { environment: "cloud", cloudBaseBranch: "origin/main" },
    })).toEqual({ environment: "cloud", cloudBaseBranch: "origin/main" });
  });

  test("rejects only an actual environment or cloud branch change", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(() => resolveResumeExecution({ id, previous, requested: { environment: "local" } })).toThrow("cannot change execution environment");
    expect(() => resolveResumeExecution({ id, previous, requested: { cloudBaseBranch: "origin/release" } })).toThrow("cannot change cloud_base_branch");
  });
});

describe("Task boundary parsing", () => {
  test("uses agent is_background only when run_in_background is omitted", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "empty-agent-dir");
    const cwd = path.join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    const context = taskContext(agentDir, cwd);
    const base = { description: "Route", prompt: "Read the poteto workflow.", subagent_type: "poteto-agent" };

    expect(parseTaskInput(base, context)).toMatchObject({ action: "start", runInBackground: true });
    expect(parseTaskInput({ ...base, run_in_background: false }, context)).toMatchObject({ runInBackground: false });
    expect(parseTaskInput({ ...base, run_in_background: true }, context)).toMatchObject({ runInBackground: true });
    expect(parseAgentDefinition("---\nname: default-agent\ndescription: Default\n---\n", "/default.md", "user")?.isBackground).toBe(false);
  });

  test("passes the package agent's declared skill through Task without a path token", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "empty-agent-dir");
    const cwd = path.join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    const agents = parseAgentFiles({ agentDir, cwd, projectTrusted: false });
    const poteto = resolveAgent("poteto-agent", agents);
    const regular = parseTaskInput({
      description: "Inspect",
      prompt: "Read the package agent.",
      subagent_type: "pstack-general",
    }, taskContext(agentDir, cwd));
    const potetoCommand = parseTaskInput({
      description: "Inspect",
      prompt: "Read the poteto workflow.",
      subagent_type: "poteto-agent",
    }, taskContext(agentDir, cwd));

    if (regular.action !== "start" || potetoCommand.action !== "start") throw new Error("Expected Task launch commands");
    expect(poteto.systemPrompt).toContain("Read the `poteto-mode` skill's `SKILL.md` in full before doing any work, including its inline Principles index.");
    expect(poteto.systemPrompt).not.toContain("<pstack>");
    expect(poteto.skill).toBe("poteto-mode");
    expect(regular.request.agent.skill).toBeUndefined();
    expect(potetoCommand.request.agent.skill).toBe("poteto-mode");
    expect(potetoCommand.request.declaredSkill).toEqual({ name: "poteto-mode", file: path.join(packageResources.skillsDirectory, "poteto-mode", "SKILL.md") });
    expect(regular.request.declaredSkill).toBeUndefined();
  });

  test("defaults to foreground and inherits the parent model and thinking level", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    putAgent(path.join(agentDir, "agents"), "pstack-general", "pstack-general", "tools: read, bash, Task\nasync: true\nallowNestedSubagents: true\ninheritProjectContext: false");
    const parsed = parseTaskInput({ description: "Inspect", prompt: "Return one word.", subagent_type: "generalPurpose" }, taskContext(agentDir, cwd));
    expect(parsed).toMatchObject({
      action: "start",
      runInBackground: false,
      environment: "local",
      request: { model: "openai-codex/gpt-6-luna", thinkingLevel: "low", depth: 1, tools: ["read", "bash", "Task"] },
    });
  });

  test("maps readonly generalPurpose calls to pstack-reader", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    putAgent(path.join(agentDir, "agents"), "general", "pstack-general", "tools: read, bash\ninheritGlobalContext: true");
    putAgent(path.join(agentDir, "agents"), "reader", "pstack-reader", "tools: read, grep, find, ls, bash\ninheritProjectContext: false\ninheritGlobalContext: false");

    const parsed = parseTaskInput({
      description: "Explain",
      prompt: "Read only.",
      subagent_type: "generalPurpose",
      readonly: true,
    }, taskContext(agentDir, cwd));

    expect(parsed).toMatchObject({
      request: {
        agent: { name: "pstack-reader", inheritGlobalContext: false },
        tools: ["read", "grep", "find", "ls"],
        projectContext: [],
      },
    });
  });

  test("validates readonly, model scope, machine, cloud, resume, and interrupt inputs", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    putAgent(path.join(agentDir, "agents"), "worker", "worker", "tools: read, bash\ninheritProjectContext: false");
    const context = taskContext(agentDir, cwd);
    const base = { description: "Read", prompt: "Read only.", subagent_type: "worker" };

    expect(parseTaskInput({ ...base, readonly: true }, context)).toMatchObject({ action: "start", request: { tools: ["read"] } });
    expect(() => parseTaskInput({ ...base, model: "anthropic/claude-sonnet-5" }, context)).toThrow("outside pstack-agents.json modelScope.allow");
    expect(() => parseTaskInput({ ...base, machine: { same_machine: {} } }, context)).toThrow("Task.machine is not supported on Pi.");
    expect(() => parseTaskInput({ ...base, cloud_requested_environment_build_id: "build-123" }, context)).toThrow("Task.cloud_requested_environment_build_id is not supported on Pi.");
    expect(() => parseTaskInput({ ...base, environment: "cloud" }, context)).toThrow("requires cloud_base_branch");
    expect(() => parseTaskInput({ ...base, resume: "bad-id" }, context)).toThrow("valid agent_id");
    expect(parseTaskInput({ resume: "11111111-1111-4111-8111-111111111111", interrupt: true }, context)).toMatchObject({ action: "interrupt" });
  });

  test("preserves unspecified execution settings when parsing a resume", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    putAgent(path.join(agentDir, "agents"), "worker", "worker", "tools: read");

    const parsed = parseTaskInput({
      description: "Resume",
      prompt: "Continue the existing run.",
      subagent_type: "worker",
      resume: "11111111-1111-4111-8111-111111111111",
    }, taskContext(agentDir, cwd));

    expect(parsed).toMatchObject({ action: "resume", environment: undefined, cloudBaseBranch: undefined });
    expect(parseTaskInput({
      description: "Resume",
      prompt: "Continue the existing run.",
      subagent_type: "worker",
      resume: "11111111-1111-4111-8111-111111111111",
      environment: "cloud",
      cloud_base_branch: "origin/main",
    }, taskContext(agentDir, cwd))).toMatchObject({ action: "resume", environment: "cloud", cloudBaseBranch: "origin/main" });
  });

  test("rejects depth-four launches and attachment paths that escape the workspace", () => {
    const root = tempRoot();
    const agentDir = path.join(root, "user");
    const cwd = path.join(root, "project");
    putAgent(path.join(agentDir, "agents"), "worker", "worker", "tools: read\ninheritProjectContext: false");
    const base: TaskToolInput = { description: "Read", prompt: "Read.", subagent_type: "worker" };
    expect(() => parseTaskInput(base, taskContext(agentDir, cwd, { depth: 3 }))).toThrow("Maximum Task nesting depth is 3");
    expect(() => parseTaskInput({ ...base, attachments: ["../outside.txt"] }, taskContext(agentDir, cwd))).toThrow("Attachment escapes the workspace");
  });
});

test("Comment Sicko names the same how and why skills as the upstream agent, as Pi skill commands", () => {
  const localPath = new URL("../../agents/comment-sicko.md", import.meta.url);
  const upstreamPath = new URL("../../parity/upstream/0.15.5/pstack/agents/comment-sicko.md", import.meta.url);
  const local = readFileSync(localPath, "utf8").match(/Before judging,[\s\S]*?on the named symbol or call\./);
  const upstream = readFileSync(upstreamPath, "utf8").match(/Before judging,[\s\S]*?on the named symbol or call\./);
  if (!local || !upstream) throw new Error("Comment Sicko is missing its skill-instruction sentence");
  expect(local[0]).toBe(upstream[0].replace("`/how`", "`/skill:how`").replace("`/why`", "`/skill:why`"));
});

test("agent names may contain single spaces, like Cursor's Comment Sicko", () => {
  const agent = parseAgentDefinition("---\nname: Comment Sicko\ndescription: deletes comments\n---\nbody", "/x/comment-sicko.md", "user");
  expect(String(agent?.name)).toBe("Comment Sicko");
  expect(parseAgentDefinition("---\nname: bad  name\ndescription: d\n---\n", "/x/b.md", "user")).toBeUndefined();
  expect(parseAgentDefinition("---\nname: trailing \ndescription: d\n---\n", "/x/c.md", "user")?.name).not.toBe("trailing ");
});

test("children load the package guard exactly once without an agent-dir copy", () => {
  const root = tempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  putAgent(path.join(agentDir, "agents"), "worker", "worker", "tools: read");

  const command = parseTaskInput({
    description: "Inspect",
    prompt: "Read a file.",
    subagent_type: "worker",
  }, taskContext(agentDir, cwd));
  if (command.action !== "start") throw new Error("Expected a Task launch");

  expect(command.request.extensionPaths).toEqual([packageResources.guardExtension]);
  expect(withGuardExtensions([...command.request.extensionPaths, packageResources.guardExtension])).toEqual([packageResources.guardExtension]);
});
