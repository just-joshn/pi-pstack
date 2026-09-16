/**
 * pstack_integrations - the Pi-side integration capability bridge (mandate
 * section 13). Pi has no MCP client, so the surface that /why discovers is this
 * registry: nine semantic categories, each either implemented by this package or
 * explicitly gated on a provisioned command adapter.
 *
 * An unavailable category returns a coverage gap that names the missing
 * prerequisite. It never falls back to another capability, so /why reports a
 * null finding instead of a silent skip.
 */
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { capToolOutput } from "../lib/tool-output.ts";
import { stripAtPrefixes } from "../lib/paths.ts";
import {
  INTEGRATION_CATEGORIES,
  type IntegrationCategory,
} from "../agents/policy.ts";
import {
  decideStatus,
  formatCoverageGap,
  formatStatusLine,
  gapForStatus,
  integrationEntries,
  integrationEntry,
  isIntegrationCategory,
  loadIntegrationsConfig,
  type CoverageGap,
  type IntegrationStatus,
  type IntegrationsConfig,
} from "./registry.ts";
import {
  DEFAULT_ADAPTER_TIMEOUT_MS,
  executeCommandAdapter,
  piExec,
  planSourceControlQuery,
  probeContext,
  probeForEntry,
  runArgv,
  type ExecLike,
  type ExecOutcome,
} from "./adapters.ts";

const ACTIONS = ["list", "status", "probe", "query"] as const;

interface IntegrationsParams {
  action: string;
  capability?: string;
  query?: string;
  paths?: string[];
  limit?: number;
}

interface ProbeResult {
  readonly config: IntegrationsConfig;
  readonly statuses: readonly IntegrationStatus[];
}

function registeredToolNames(pi: ExtensionAPI): readonly string[] | undefined {
  const all = pi.getAllTools?.();
  return all?.map((tool) => tool.name);
}

async function probeAll(pi: ExtensionAPI, exec: ExecLike, cwd: string): Promise<ProbeResult> {
  const config = loadIntegrationsConfig();
  const context = await probeContext(exec, config, { cwd, registeredTools: registeredToolNames(pi) });
  const statuses = integrationEntries().map((entry) => decideStatus(entry, context));
  return Object.freeze({ config, statuses: Object.freeze(statuses) });
}

function requireCapability(value: string | undefined): IntegrationCategory {
  const id = (value ?? "").trim();
  if (!isIntegrationCategory(id)) {
    throw new Error(`capability must be one of ${INTEGRATION_CATEGORIES.join(", ")}`);
  }
  return id;
}

function categoryDetails(status: IntegrationStatus): Record<string, unknown> {
  return {
    id: status.entry.id,
    title: status.entry.title,
    availability: status.availability,
    tool: status.entry.toolName,
    kind: status.entry.kind,
    prerequisite: status.entry.prerequisite,
    satisfiedBy: status.satisfiedBy,
    missing: status.missing,
  };
}

function renderInventory(result: ProbeResult, action: string): AgentToolResult<unknown> {
  const lines = result.statuses.map(formatStatusLine);
  const available = result.statuses.filter((status) => status.availability !== "unavailable").length;
  const header = `pstack_integrations ${action}: ${available}/${result.statuses.length} categories available`;
  return {
    content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
    details: {
      action,
      config: result.config.source,
      available,
      total: result.statuses.length,
      categories: result.statuses.map(categoryDetails),
    },
  };
}

function gapResult(gap: CoverageGap): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: formatCoverageGap(gap) }],
    details: {
      capability: gap.capability,
      availability: "unavailable",
      coverageGap: true,
      substituted: false,
      missing: gap.missing,
    },
  };
}

function execResult(status: IntegrationStatus, outcome: ExecOutcome, plan: string): AgentToolResult<unknown> {
  const capped = capToolOutput(`${outcome.stdout}\n${outcome.stderr}`.trim() || "(no output)", {
    keep: "tail",
    label: `integrations-${status.entry.id}`,
  });
  return {
    content: [
      { type: "text", text: `${status.entry.id} ${plan}: exit ${outcome.code}\n\n${capped.text}` },
    ],
    details: {
      capability: status.entry.id,
      plan,
      code: outcome.code,
      coverageGap: false,
      ...(capped.outputPath ? { fullOutputPath: capped.outputPath } : {}),
    },
  };
}

function pointerResult(status: IntegrationStatus): AgentToolResult<unknown> {
  const tool = status.entry.toolName;
  return {
    content: [
      {
        type: "text",
        text: `${status.entry.id} is available through the built-in ${tool} tool; call that tool directly (pstack_integrations does not drive a CLI or browser).`,
      },
    ],
    details: {
      capability: status.entry.id,
      delegatedTo: tool,
      executed: false,
      coverageGap: false,
    },
  };
}

async function runSourceControl(
  status: IntegrationStatus,
  params: IntegrationsParams,
  exec: ExecLike,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const plan = planSourceControlQuery(params.query ?? "", stripAtPrefixes(params.paths), params.limit);
  if (plan.requiresGh && status.availability === "available-git-only") {
    return gapResult({
      capability: "source-control",
      missing: `gh is not on PATH, so the '${plan.mode}' query is unavailable; git history alone is available`,
    });
  }
  const outcome = await runArgv(exec, plan.argv, { cwd: ctx.cwd, timeoutMs: DEFAULT_ADAPTER_TIMEOUT_MS });
  return execResult(status, outcome, `${plan.mode} (${plan.argv[0]})`);
}

async function runConfiguredAdapter(
  status: IntegrationStatus,
  config: IntegrationsConfig,
  params: IntegrationsParams,
  exec: ExecLike,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const adapter = config.adapters[status.entry.id];
  if (adapter === undefined) return gapResult(gapForStatus(status));
  const outcome = await executeCommandAdapter(exec, adapter.command, (params.query ?? "").trim(), {
    cwd: ctx.cwd,
  });
  return execResult(status, outcome, adapter.description);
}

async function handleQuery(
  params: IntegrationsParams,
  pi: ExtensionAPI,
  exec: ExecLike,
  ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
  const capability = requireCapability(params.capability);
  const config = loadIntegrationsConfig();
  const entry = integrationEntry(capability);
  const context = await probeForEntry(entry, exec, config, {
    cwd: ctx.cwd,
    registeredTools: registeredToolNames(pi),
  });
  const status = decideStatus(entry, context);
  if (status.availability === "unavailable") return gapResult(gapForStatus(status));
  if (entry.probeSpec.kind === "builtin-tool") return pointerResult(status);
  if (entry.probeSpec.kind === "source-control") {
    return await runSourceControl(status, params, exec, ctx);
  }
  return await runConfiguredAdapter(status, config, params, exec, ctx);
}

export function registerIntegrations(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_integrations",
    label: "Pstack Integrations",
    description:
      "Pi-local integration capability bridge (no MCP client). list/status/probe report the nine capability categories and their prerequisites; query runs the source-control adapters (git, gh) or a command adapter configured in ~/.pi/agent/pstack/integrations.json for the named capability. An unavailable capability returns an explicit coverage gap. Adapter output caps at 50KB / 2000 lines; a truncated result's trailer names the temp file with the full text.",
    promptSnippet: "Report integration capability availability and query a configured adapter",
    promptGuidelines: [
      "pstack_integrations must report an unavailable category as a null finding, never skip it",
      "pstack_integrations capability availability comes from the tool, not from guessing tool names",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS, { description: "list | status | probe | query" }),
      capability: Type.Optional(
        Type.String({
          description: `query target, one of: ${INTEGRATION_CATEGORIES.join(", ")}`,
        }),
      ),
      query: Type.Optional(
        Type.String({
          description:
            "source-control grammar: '', 'log text' (commit message search), 'blame:<file>:<line>', 'prs:<terms>'; command adapters receive it as a trailing argument",
        }),
      ),
      paths: Type.Optional(Type.Array(Type.String(), { description: "git log pathspecs" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const exec = piExec(pi);
      if (params.action === "query") return await handleQuery(params, pi, exec, ctx);
      if (!(ACTIONS as readonly string[]).includes(params.action)) {
        throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
      }
      const result = await probeAll(pi, exec, ctx.cwd);
      return renderInventory(result, params.action);
    },
  });
}
