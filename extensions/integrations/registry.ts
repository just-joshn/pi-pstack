/**
 * Integration capability registry (mandate section 13).
 *
 * Pi ships no MCP client, so this package supplies the bridge. The nine
 * semantic capability categories come from extensions/agents/policy.ts, the
 * same table the child policy guard reads, so the guard and the registry never
 * drift. Each category is either implemented by this package or gated on a
 * provisioned command adapter in ~/.pi/agent/pstack/integrations.json.
 *
 * Pure logic only: nothing here spawns a process. adapters.ts gathers the probe
 * facts and decideStatus turns them into a status.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  INTEGRATION_CATEGORIES,
  INTEGRATION_CAPABILITIES,
  type IntegrationCategory,
} from "../agents/policy.ts";

export type IntegrationKind = "implemented" | "prerequisite";

/**
 * How availability is decided. source-control needs a git work tree plus gh;
 * builtin-tool needs the capability tool registered in this session;
 * command-adapter needs a config entry for the category.
 */
export type ProbeSpec =
  | { readonly kind: "source-control" }
  | { readonly kind: "builtin-tool" }
  | { readonly kind: "command-adapter" };

export interface IntegrationEntry {
  readonly id: IntegrationCategory;
  readonly title: string;
  readonly toolName: string;
  readonly kind: IntegrationKind;
  readonly prerequisite: string;
  readonly probeSpec: ProbeSpec;
}

export interface CommandAdapterConfig {
  readonly adapter: "command";
  readonly command: readonly string[];
  readonly description: string;
}

export type AdapterMap = Readonly<Partial<Record<IntegrationCategory, CommandAdapterConfig>>>;

export interface IntegrationsConfig {
  readonly source: string;
  readonly adapters: AdapterMap;
}

interface CategoryMeta {
  readonly title: string;
  readonly kind: IntegrationKind;
  readonly probeSpec: ProbeSpec;
  /** null when the capability tool itself is the prerequisite. */
  readonly prerequisite: string | null;
}

const SOURCE_CONTROL_PREREQUISITE =
  "git work tree (git rev-parse --is-inside-work-tree) and gh on PATH for PR queries";
const CONFIGURED_COMMAND_PREREQUISITE =
  "a command adapter entry in ~/.pi/agent/pstack/integrations.json (PSTACK_INTEGRATIONS_DIR overrides the directory)";

const SOURCE_CONTROL_PROBE: ProbeSpec = Object.freeze({ kind: "source-control" });
const BUILTIN_TOOL_PROBE: ProbeSpec = Object.freeze({ kind: "builtin-tool" });
const COMMAND_ADAPTER_PROBE: ProbeSpec = Object.freeze({ kind: "command-adapter" });

function configuredCategory(title: string): CategoryMeta {
  return Object.freeze({
    title,
    kind: "prerequisite",
    probeSpec: COMMAND_ADAPTER_PROBE,
    prerequisite: CONFIGURED_COMMAND_PREREQUISITE,
  });
}

const CATEGORY_META: Readonly<Record<IntegrationCategory, CategoryMeta>> = Object.freeze({
  "source-control": Object.freeze({
    title: "Source control history",
    kind: "implemented",
    probeSpec: SOURCE_CONTROL_PROBE,
    prerequisite: SOURCE_CONTROL_PREREQUISITE,
  }),
  "issue-tracker": configuredCategory("Issue / ticket tracker"),
  "long-form-docs": configuredCategory("Long-form documents"),
  "team-chat": configuredCategory("Real-time team chat"),
  observability: configuredCategory("Infrastructure observability"),
  "error-tracking": configuredCategory("Error / exception tracking"),
  analytics: configuredCategory("Product analytics warehouse"),
  "browser-ui": Object.freeze({
    title: "Browser UI driving",
    kind: "implemented",
    probeSpec: BUILTIN_TOOL_PROBE,
    prerequisite: null,
  }),
  "cli-tui": Object.freeze({
    title: "CLI / TUI driving",
    kind: "implemented",
    probeSpec: BUILTIN_TOOL_PROBE,
    prerequisite: null,
  }),
});

export function isIntegrationCategory(value: string): value is IntegrationCategory {
  return (INTEGRATION_CATEGORIES as readonly string[]).includes(value);
}

/** The capability tool name from the policy table, the single source of truth. */
export function capabilityToolName(id: IntegrationCategory): string {
  const patterns = INTEGRATION_CAPABILITIES[id] ?? [];
  const first = patterns.length > 0 ? patterns[0] : "";
  if (!first) throw new Error(`integration capability table names no tool for ${id}`);
  return first;
}

export function integrationEntry(id: IntegrationCategory): IntegrationEntry {
  if (!Object.hasOwn(CATEGORY_META, id)) {
    throw new Error(`integration registry has no metadata for capability ${String(id)}`);
  }
  const meta = CATEGORY_META[id];
  const toolName = capabilityToolName(id);
  return Object.freeze({
    id,
    title: meta.title,
    toolName,
    kind: meta.kind,
    prerequisite: meta.prerequisite ?? `the built-in ${toolName} tool`,
    probeSpec: meta.probeSpec,
  });
}

/** One entry per category, in the order the policy table declares. */
export function integrationEntries(): readonly IntegrationEntry[] {
  return Object.freeze(INTEGRATION_CATEGORIES.map((id) => integrationEntry(id)));
}

export function integrationsDir(): string {
  return process.env.PSTACK_INTEGRATIONS_DIR ?? join(homedir(), ".pi", "agent", "pstack");
}

export function configPath(dir: string = integrationsDir()): string {
  return join(dir, "integrations.json");
}

function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function parseArgv(value: unknown, id: string, source: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source}: capability '${id}' adapter.command must be a non-empty array of strings`);
  }
  const allStrings = value.every((entry) => typeof entry === "string" && entry.length > 0);
  if (!allStrings) {
    throw new Error(`${source}: capability '${id}' adapter.command must be a non-empty array of strings`);
  }
  const argv = Object.freeze([...(value as string[])]);
  const head = argv[0];
  if (head.startsWith("-")) {
    throw new Error(
      `${source}: capability '${id}' adapter.command[0] must be a command name, not an option ('${head}')`,
    );
  }
  return argv;
}

/** Validate one capability's adapter entry at the config boundary. */
export function parseCommandAdapter(id: string, raw: unknown, source: string): CommandAdapterConfig {
  const record = requireRecord(raw, `${source}: capability '${id}'`);
  if (record.adapter !== "command") {
    throw new Error(
      `${source}: capability '${id}' adapter must be "command"; got ${JSON.stringify(record.adapter ?? null)}`,
    );
  }
  const command = parseArgv(record.command, id, source);
  const description = record.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error(`${source}: capability '${id}' adapter.description must be a non-empty string`);
  }
  return Object.freeze({ adapter: "command" as const, command, description: description.trim() });
}

export function parseIntegrationsConfig(raw: unknown, source: string): IntegrationsConfig {
  const record = requireRecord(raw, source);
  const unknownKeys = Object.keys(record).filter((key) => !isIntegrationCategory(key));
  if (unknownKeys.length > 0) {
    const named = unknownKeys.map((key) => `'${key}'`).join(", ");
    throw new Error(`${source}: unknown capability ${named}; known: ${INTEGRATION_CATEGORIES.join(", ")}`);
  }
  const adapters = INTEGRATION_CATEGORIES.reduce<Partial<Record<IntegrationCategory, CommandAdapterConfig>>>(
    (acc, id) => {
      if (!Object.hasOwn(record, id)) return acc;
      return { ...acc, [id]: parseCommandAdapter(id, record[id], source) };
    },
    {},
  );
  return Object.freeze({ source, adapters: Object.freeze(adapters) });
}

/** A missing config file is an empty config, not an error; a malformed one throws. */
export function loadIntegrationsConfig(dir: string = integrationsDir()): IntegrationsConfig {
  const file = configPath(dir);
  if (!existsSync(file)) return Object.freeze({ source: file, adapters: Object.freeze({}) });
  const text = readFileSync(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: invalid JSON (${detail})`);
  }
  return parseIntegrationsConfig(raw, file);
}

export const AVAILABILITY = ["available", "available-git-only", "unavailable"] as const;
export type Availability = (typeof AVAILABILITY)[number];

export interface ProbeContext {
  readonly gitWorkTree: boolean;
  readonly ghOnPath: boolean;
  readonly config: IntegrationsConfig;
  readonly registeredTools?: readonly string[];
}

export interface IntegrationStatus {
  readonly entry: IntegrationEntry;
  readonly availability: Availability;
  readonly satisfiedBy: string | null;
  readonly missing: string | null;
}

export interface CoverageGap {
  readonly capability: IntegrationCategory;
  readonly missing: string;
}

function makeStatus(
  entry: IntegrationEntry,
  availability: Availability,
  satisfiedBy: string | null,
  missing: string | null,
): IntegrationStatus {
  return Object.freeze({ entry, availability, satisfiedBy, missing });
}

function decideSourceControl(entry: IntegrationEntry, ctx: ProbeContext): IntegrationStatus {
  if (!ctx.gitWorkTree) {
    return makeStatus(entry, "unavailable", null, "cwd is not inside a git work tree (git rev-parse --is-inside-work-tree)");
  }
  if (!ctx.ghOnPath) {
    return makeStatus(
      entry,
      "available-git-only",
      "git work tree; gh is not on PATH, so PR queries are unavailable",
      null,
    );
  }
  return makeStatus(entry, "available", "git work tree and gh on PATH", null);
}

function decideBuiltinTool(entry: IntegrationEntry, ctx: ProbeContext): IntegrationStatus {
  const tools = ctx.registeredTools;
  if (tools !== undefined && !tools.includes(entry.toolName)) {
    return makeStatus(entry, "unavailable", null, `${entry.toolName} is not registered in this session`);
  }
  return makeStatus(entry, "available", `the built-in ${entry.toolName} tool`, null);
}

/** Names the command, never the argv, so a token in a configured argv never reaches output. */
function adapterSatisfiedBy(command: readonly string[], source: string): string {
  const extra = command.length - 1;
  return `command adapter '${command[0]}' (${extra} arg${extra === 1 ? "" : "s"}) from ${source}`;
}

function decideCommandAdapter(entry: IntegrationEntry, ctx: ProbeContext): IntegrationStatus {
  const adapter = ctx.config.adapters[entry.id];
  if (adapter === undefined) {
    const hint = `add a 'command' adapter for capability '${entry.id}' to ${ctx.config.source}`;
    return makeStatus(entry, "unavailable", null, hint);
  }
  return makeStatus(entry, "available", adapterSatisfiedBy(adapter.command, ctx.config.source), null);
}

export function decideStatus(entry: IntegrationEntry, ctx: ProbeContext): IntegrationStatus {
  if (entry.probeSpec.kind === "source-control") return decideSourceControl(entry, ctx);
  if (entry.probeSpec.kind === "builtin-tool") return decideBuiltinTool(entry, ctx);
  return decideCommandAdapter(entry, ctx);
}

export function formatStatusLine(status: IntegrationStatus): string {
  const detail = status.satisfiedBy !== null ? `satisfied-by ${status.satisfiedBy}` : `missing ${status.missing}`;
  return `${status.entry.id}: ${status.availability} tool=${status.entry.toolName} (${detail})`;
}

export function gapForStatus(status: IntegrationStatus): CoverageGap {
  return Object.freeze({
    capability: status.entry.id,
    missing: status.missing ?? status.entry.prerequisite,
  });
}

/**
 * The mandated wording for an unavailable category: a named prerequisite and an
 * explicit refusal to substitute another capability.
 */
export function formatCoverageGap(gap: CoverageGap): string {
  return [
    `pstack_integrations coverage gap: capability '${gap.capability}' is unavailable.`,
    `missing prerequisite: ${gap.missing}`,
    "no other capability was queried in its place; report this as a null finding in /why, not a skip.",
  ].join("\n");
}
