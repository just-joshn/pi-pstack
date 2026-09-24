import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, loadProjectContextFiles, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseRunId, type RunId } from "./contracts.ts";

export type AgentName = string & { readonly __brand: "AgentName" };
export type AgentSource = "user" | "project";
export type SystemPromptMode = "append" | "replace";

export type AgentDefinition = {
  name: AgentName;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  systemPromptMode: SystemPromptMode;
  inheritProjectContext: boolean;
  inheritGlobalContext: boolean;
  inheritSkills: boolean;
  allowNestedSubagents: boolean;
};

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  systemPromptMode?: unknown;
  inheritProjectContext?: unknown;
  inheritGlobalContext?: unknown;
  inheritSkills?: unknown;
  allowNestedSubagents?: unknown;
};

export type ModelScopePolicy = { enforce: boolean; allow: string[] };

export type AgentLaunchRequest = {
  kind: "agent";
  description: string;
  agent: AgentDefinition;
  prompt: string;
  model: string;
  thinkingLevel?: string;
  readonly: boolean;
  cwd: string;
  attachments: string[];
  tools: string[];
  extensionPaths: string[];
  output?: string;
  depth: number;
  projectContext: Array<{ path: string; content: string }>;
};

export type TaskToolInput =
  | { resume: string; interrupt: true }
  | {
      description: string;
      prompt: string;
      subagent_type: string;
      model?: string;
      resume?: string;
      readonly?: boolean;
      run_in_background?: boolean;
      attachments?: string[];
      environment?: "local" | "cloud";
      cloud_base_branch?: string;
      machine?: string;
      interrupt?: false;
      output?: string;
    };

export type TaskCommand =
  | { action: "interrupt"; id: RunId }
  | { action: "start"; request: AgentLaunchRequest; runInBackground: boolean; environment: "local" | "cloud"; cloudBaseBranch?: string }
  | { action: "resume"; id: RunId; request: AgentLaunchRequest; runInBackground: boolean; environment?: "local" | "cloud"; cloudBaseBranch?: string };

export type ParentTaskContext = {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  parentModel?: string;
  thinkingLevel?: string;
  depth: number;
  nestingAllowed: boolean;
  activeTools: string[];
  allTools: Array<{ name: string; sourcePath: string }>;
  modelScope: ModelScopePolicy | undefined;
  onAgentParseWarning?: (filePath: string, reason: string) => void;
};

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const AGENT_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]| (?=[A-Za-z0-9]))*$/;
const MODEL_GLOB_META = /[.+^${}()|[\]\\]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`Agent frontmatter ${field} must be a boolean`);
  return value;
}

function parseToolNames(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!raw) throw new Error("Agent frontmatter tools must be a comma-separated string or a string array");
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new Error("Agent frontmatter tools must contain only strings");
    const name = item.trim();
    if (name) names.push(name);
  }
  return names;
}

export function parseAgentDefinition(content: string, filePath: string, source: AgentSource): AgentDefinition | undefined {
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
  const rawName = frontmatter.name;
  if (typeof rawName !== "string" || !AGENT_NAME_PATTERN.test(rawName)) return undefined;
  if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") return undefined;
  const systemPromptMode = frontmatter.systemPromptMode ?? "append";
  if (systemPromptMode !== "append" && systemPromptMode !== "replace") {
    throw new Error(`Agent ${rawName} has invalid systemPromptMode`);
  }
  if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
    throw new Error(`Agent ${rawName} has an invalid model`);
  }
  const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : undefined;
  if (model === "") throw new Error(`Agent ${rawName} has an empty model`);

  return {
    name: rawName as AgentName,
    description: frontmatter.description.trim(),
    tools: parseToolNames(frontmatter.tools),
    model,
    systemPrompt: body,
    source,
    filePath,
    systemPromptMode,
    inheritProjectContext: parseBoolean(frontmatter.inheritProjectContext, true, "inheritProjectContext"),
    inheritGlobalContext: parseBoolean(frontmatter.inheritGlobalContext, false, "inheritGlobalContext"),
    inheritSkills: parseBoolean(frontmatter.inheritSkills, true, "inheritSkills"),
    allowNestedSubagents: parseBoolean(frontmatter.allowNestedSubagents, false, "allowNestedSubagents"),
  };
}

function invalidAgentReason(content: string): string {
  const { frontmatter } = parseFrontmatter<AgentFrontmatter>(content);
  if (typeof frontmatter.name !== "string") return "Agent frontmatter name must be a string";
  if (!AGENT_NAME_PATTERN.test(frontmatter.name)) return `Agent name is invalid: ${frontmatter.name}`;
  if (typeof frontmatter.description !== "string" || frontmatter.description.trim() === "") {
    return "Agent frontmatter description must be a non-empty string";
  }
  return "Agent definition is invalid";
}

function readAgentDirectory(
  directory: string,
  source: AgentSource,
  onSkipped?: (filePath: string, reason: string) => void,
): AgentDefinition[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(directory, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      onSkipped?.(filePath, error instanceof Error ? error.message : String(error));
      continue;
    }

    let agent: AgentDefinition | undefined;
    try {
      agent = parseAgentDefinition(content, filePath, source);
    } catch (error) {
      onSkipped?.(filePath, error instanceof Error ? error.message : String(error));
      continue;
    }
    if (agent) agents.push(agent);
    else onSkipped?.(filePath, invalidAgentReason(content));
  }
  return agents;
}

function nearestProjectAgentsDirectory(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function parseAgentFiles(options: {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  onSkipped?: (filePath: string, reason: string) => void;
}): AgentDefinition[] {
  const userAgents = readAgentDirectory(path.join(options.agentDir, "agents"), "user", options.onSkipped);
  const projectDir = options.projectTrusted ? nearestProjectAgentsDirectory(options.cwd) : undefined;
  const projectAgents = projectDir ? readAgentDirectory(projectDir, "project", options.onSkipped) : [];
  const byName = new Map<string, AgentDefinition>();
  for (const agent of userAgents) byName.set(agent.name, agent);
  for (const agent of projectAgents) byName.set(agent.name, agent);
  return [...byName.values()];
}

export function resolveAgent(name: string, agents: readonly AgentDefinition[], isReadonly = false): AgentDefinition {
  const resolvedName = name === "generalPurpose" ? (isReadonly ? "pstack-reader" : "pstack-general") : name;
  const agent = agents.find((candidate) => candidate.name === resolvedName);
  if (agent) return agent;
  const available = agents.map((candidate) => candidate.name).join(", ") || "none";
  throw new Error(`Unknown agent "${name}". Available agents: ${available}.`);
}

export function createAgentParseWarningReporter() {
  const reportedBySession = new Map<string, Set<string>>();
  return (sessionId: string, filePath: string, reason: string, notify: (message: string) => void): void => {
    const reported = reportedBySession.get(sessionId) ?? new Set<string>();
    const warningKey = `${filePath}\0${reason}`;
    if (reported.has(warningKey)) return;
    reported.add(warningKey);
    reportedBySession.set(sessionId, reported);
    notify(`Skipped agent file ${filePath}: ${reason}`);
  };
}

export function resolveResumeExecution(options: {
  id: string;
  previous: { environment?: "local" | "cloud"; cloudBaseBranch?: string; worktreeBaseCommit?: string };
  requested: { environment?: "local" | "cloud"; cloudBaseBranch?: string };
}): { environment: "local" | "cloud"; cloudBaseBranch?: string } {
  const previousEnvironment = options.previous.environment ?? (options.previous.cloudBaseBranch || options.previous.worktreeBaseCommit ? "cloud" : "local");
  if (options.requested.environment !== undefined && options.requested.environment !== previousEnvironment) {
    throw new Error(`Task ${options.id} cannot change execution environment when resumed`);
  }
  if (options.requested.cloudBaseBranch !== undefined && options.requested.cloudBaseBranch !== options.previous.cloudBaseBranch) {
    throw new Error(`Task ${options.id} cannot change cloud_base_branch when resumed`);
  }
  return { environment: previousEnvironment, cloudBaseBranch: options.previous.cloudBaseBranch };
}

function escapeGlob(pattern: string): string {
  return pattern.replace(MODEL_GLOB_META, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
}

export function parseModelScope(settings: unknown): ModelScopePolicy | undefined {
  if (!isRecord(settings) || !isRecord(settings.subagents) || !isRecord(settings.subagents.modelScope)) return undefined;
  const raw = settings.subagents.modelScope;
  if (typeof raw.enforce !== "boolean" || !Array.isArray(raw.allow)) {
    throw new Error("settings.json subagents.modelScope must contain boolean enforce and string[] allow");
  }
  const allow: string[] = [];
  for (const item of raw.allow) {
    if (typeof item !== "string") throw new Error("settings.json subagents.modelScope.allow must contain only strings");
    allow.push(item);
  }
  return { enforce: raw.enforce, allow };
}

export function modelMatchesScope(model: string, policy: ModelScopePolicy | undefined, inherited: boolean): boolean {
  if (!policy?.enforce) return true;
  if (inherited && policy.allow.includes("inherit")) return true;
  const candidateBase = model.split(":", 1)[0];
  return policy.allow.some((pattern) => {
    if (pattern === "inherit") return false;
    const regex = new RegExp(`^${escapeGlob(pattern)}$`, "i");
    return regex.test(model) || (!pattern.includes(":") && regex.test(candidateBase));
  });
}

export function selectAgentTools(options: {
  agent: AgentDefinition;
  activeTools: readonly string[];
  allTools: readonly { name: string; sourcePath: string }[];
  readonly: boolean;
}): { tools: string[]; extensionPaths: string[] } {
  const availableNames = new Set([...BUILTIN_TOOLS, ...options.allTools.map((tool) => tool.name)]);
  const requested = options.agent.tools ?? [...options.activeTools];
  const unknown = requested.filter((name) => !availableNames.has(name));
  if (unknown.length > 0) throw new Error(`Agent ${options.agent.name} requests unavailable tools: ${unknown.join(", ")}.`);
  const tools = [...new Set(requested)].filter((name) => {
    if (options.readonly && !READ_ONLY_TOOLS.has(name)) return false;
    return name !== "Task" || options.agent.allowNestedSubagents;
  });
  const extensionPaths = [...new Set(
    options.allTools
      .filter((tool) => tools.includes(tool.name) && !BUILTIN_TOOLS.has(tool.name))
      .map((tool) => tool.sourcePath),
  )];
  return { tools, extensionPaths };
}

// Hook-only pstack extensions register no tools, so tool-based selection never loads them.
// Every child gets them so the guards hold at every depth.
const GUARD_EXTENSIONS = ["pstack-guards.ts"];

export function withGuardExtensions(paths: readonly string[], agentDir: string): string[] {
  const guards = GUARD_EXTENSIONS.map((name) => path.join(agentDir, "extensions", name)).filter((file) => fs.existsSync(file));
  return [...new Set([...paths, ...guards])];
}

function loadModelScope(agentDir: string): ModelScopePolicy | undefined {
  const settingsPath = path.join(agentDir, "settings.json");
  let contents: string;
  try {
    contents = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return undefined;
  }
  let settings: unknown;
  try {
    settings = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in ${settingsPath}`);
  }
  return parseModelScope(settings);
}

export function selectContextFiles(options: {
  files: readonly { path: string; content: string }[];
  agentDir: string;
  inheritProjectContext: boolean;
  inheritGlobalContext: boolean;
}): Array<{ path: string; content: string }> {
  const globalRoot = path.resolve(options.agentDir) + path.sep;
  return options.files.filter((file) => {
    const resolved = path.resolve(file.path);
    const isGlobal = resolved.startsWith(globalRoot);
    return isGlobal ? options.inheritGlobalContext : options.inheritProjectContext;
  });
}

function resolveAttachments(attachments: readonly string[] | undefined, cwd: string): string[] {
  const root = fs.realpathSync(cwd);
  return (attachments ?? []).map((attachment) => {
    if (path.isAbsolute(attachment)) throw new Error(`Attachment must be workspace-relative: ${attachment}`);
    const resolved = path.resolve(root, attachment);
    const lexicalRelative = path.relative(root, resolved);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
      throw new Error(`Attachment escapes the workspace: ${attachment}`);
    }
    const candidate = fs.realpathSync(resolved);
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Attachment escapes the workspace: ${attachment}`);
    }
    if (!fs.statSync(candidate).isFile()) throw new Error(`Attachment must be a file: ${attachment}`);
    return candidate;
  });
}

function resolveOutput(output: string | undefined, cwd: string): string | undefined {
  return output ? path.resolve(cwd, output) : undefined;
}

export function parseTaskInput(input: TaskToolInput, context: ParentTaskContext): TaskCommand {
  if ("interrupt" in input && input.interrupt === true) {
    const id = parseRunId(input.resume);
    if (!id) throw new Error("Task interrupt requires a valid agent_id in resume");
    return { action: "interrupt", id };
  }
  if (typeof input.machine === "string") throw new Error("machine execution is unsupported by the local runtime");
  if (input.description.trim() === "") throw new Error("Task description is required");
  if (input.prompt.trim() === "") throw new Error("Task prompt is required");
  if (input.subagent_type.trim() === "") throw new Error("Task subagent_type is required");
  if (input.environment === "local" && input.cloud_base_branch) throw new Error("cloud_base_branch requires environment cloud");
  if (input.environment === "cloud" && !input.cloud_base_branch) throw new Error("environment cloud requires cloud_base_branch");
  if (context.depth >= 3) throw new Error("Maximum Task nesting depth is 3");
  if (context.depth > 0 && !context.nestingAllowed) throw new Error("This agent does not allow nested Task calls");

  const agents = parseAgentFiles({
    agentDir: context.agentDir,
    cwd: context.cwd,
    projectTrusted: context.projectTrusted,
    onSkipped: context.onAgentParseWarning,
  });
  const agent = resolveAgent(input.subagent_type, agents, input.readonly === true);
  if (input.model === "inherit" && !context.parentModel) throw new Error("Task model inherit requires a parent model");
  const inheritsParentModel = input.model === "inherit" || (!input.model && !agent.model);
  const model = input.model === "inherit" ? context.parentModel : input.model ?? agent.model ?? context.parentModel;
  if (!model) throw new Error("Task requires a model, but the parent session has none");
  if (!modelMatchesScope(model, context.modelScope, inheritsParentModel)) {
    throw new Error(`Model ${model} is outside settings.json subagents.modelScope.allow`);
  }

  const selectedTools = selectAgentTools({
    agent,
    activeTools: context.activeTools,
    allTools: context.allTools,
    readonly: input.readonly === true,
  });
  const output = resolveOutput(input.output, context.cwd);
  const projectContext = agent.inheritProjectContext || agent.inheritGlobalContext
    ? selectContextFiles({
        files: loadProjectContextFiles({ cwd: context.cwd, agentDir: context.agentDir }),
        agentDir: context.agentDir,
        inheritProjectContext: agent.inheritProjectContext,
        inheritGlobalContext: agent.inheritGlobalContext,
      })
    : [];
  const id = input.resume ? parseRunId(input.resume) : undefined;
  if (input.resume && !id) throw new Error("Task resume requires a valid agent_id");

  const request: AgentLaunchRequest = {
    kind: "agent",
    description: input.description.trim(),
    agent,
    prompt: input.prompt,
    model,
    thinkingLevel: inheritsParentModel ? context.thinkingLevel : undefined,
    readonly: input.readonly === true,
    cwd: context.cwd,
    attachments: resolveAttachments(input.attachments, context.cwd),
    tools: selectedTools.tools,
    extensionPaths: withGuardExtensions(selectedTools.extensionPaths, context.agentDir),
    output,
    depth: context.depth + 1,
    projectContext,
  };
  const common = {
    request,
    runInBackground: input.run_in_background === true,
    cloudBaseBranch: input.cloud_base_branch,
  } as const;
  return id
    ? { action: "resume", id, ...common, environment: input.environment }
    : { action: "start", ...common, environment: input.environment ?? "local" };
}

export function loadTaskContext(context: {
  cwd: string;
  projectTrusted: boolean;
  parentModel?: string;
  thinkingLevel?: string;
  depth: number;
  nestingAllowed: boolean;
  activeTools: string[];
  allTools: Array<{ name: string; sourcePath: string }>;
  onAgentParseWarning?: (filePath: string, reason: string) => void;
}, agentDir = getAgentDir()): ParentTaskContext {
  return { ...context, agentDir, modelScope: loadModelScope(agentDir) };
}

export function piToolSourcePaths(tools: readonly { name: string; sourceInfo: { path: string } }[]): Array<{ name: string; sourcePath: string }> {
  return tools.map((tool) => ({ name: tool.name, sourcePath: tool.sourceInfo.path }));
}
