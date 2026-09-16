/**
 * Thin Pi-native twins for deslop / control-cli / control-ui.
 * Skills remain the philosophy; these tools give callable verification surfaces.
 * No bash -lc of raw model strings — argv arrays only.
 *
 * pstack_deslop: severity + samples + structured fix suggestions; optional
 * applySafe deletes high-confidence safe comment/slop lines in the working tree.
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capToolOutput } from "../lib/tool-output.ts";
import { execOptions } from "../lib/exec-options.ts";
import { stripAtPrefix, stripAtPrefixes } from "../lib/paths.ts";
import { resolveTrustedCommand, DEFAULT_TRUSTED_BIN_DIRS } from "../lib/exec-allowlist.ts";
import { fetchFollowingSafeRedirects, normalizedHostname, ipv4ToInt, validateProbeTarget } from "../lib/url-policy.ts";
import {
  SLOP_PATTERNS,
  applySafeDeletes,
  scanAddedLinesForSlop,
  type FixSuggestion,
  type SlopPattern,
  type Severity,
} from "./deslop-core.ts";

export { applySafeDeletes, scanAddedLinesForSlop, type FixSuggestion } from "./deslop-core.ts";

/**
 * Command names the tool may run. The interpreter names stay here for the opt-in
 * path, but they are unreachable while `allowInterpreters` is off, because the
 * interpreter check runs before the allowlist check.
 */
const ALLOWED_CONTROL_COMMANDS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "python",
  "python3",
  "go",
  "cargo",
  "make",
  "pytest",
  "git",
  "gh",
  "pi",
  "tsx",
  "npx",
]);

const DESLOP_PARAMETERS = Type.Object({
  base: Type.Optional(Type.String({ description: "git diff base (default main)" })),
  paths: Type.Optional(Type.Array(Type.String())),
  applySafe: Type.Optional(
    Type.Boolean({
      description:
        "If true, delete high-confidence safe comment/slop lines (banner/empty/narration comments) from the working tree.",
    }),
  ),
  autoApply: Type.Optional(
    Type.Boolean({
      description:
        "Stage-2 optional: if true and UI confirm is available, prompt once then applySafe. Ignored without confirm UI.",
    }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "If true, report which safeDelete lines would be removed without writing files (overrides applySafe/autoApply).",
    }),
  ),
});

const CONTROL_CLI_PARAMETERS = Type.Object({
  argv: Type.Array(Type.String(), {
    minItems: 1,
    description: "Argv array: [command, ...args]. No shell metacharacters.",
  }),
  cwd: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
});

const CONTROL_UI_PARAMETERS = Type.Object({
  url: Type.String(),
  method: Type.Optional(Type.String()),
  expectStatus: Type.Optional(Type.Integer()),
  allowHosts: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Explicit opt-in hostnames (exact match) that may bypass the private-address check for a dev server, e.g. localhost or 127.0.0.1:5173. The caller may only name a loopback host; a wider network is the operator's call through PSTACK_CONTROL_UI_ALLOW_HOSTS. Metadata hostnames and .internal/.local stay blocked.",
    }),
  ),
});

const ALLOWED_CONTROL_COMMAND_LIST = Object.freeze([...ALLOWED_CONTROL_COMMANDS]);

/**
 * PSTACK_CONTROL_CLI_INTERPRETERS=1 grants arbitrary code execution: an
 * interpreter runs whatever the caller puts in argv. It is off unless the
 * operator opts in, and argv can never set it.
 */
function interpretersAllowed(): boolean {
  return process.env.PSTACK_CONTROL_CLI_INTERPRETERS === "1";
}

/**
 * Extra binary directories the operator trusts, absolute paths only. Every command
 * the tool runs must resolve inside this list or the built-in one; argv cannot
 * reach either. A toolchain outside them (mise, nvm, ~/.cargo) needs this set.
 */
function trustedBinDirs(): readonly string[] {
  const extra = (process.env.PSTACK_CONTROL_CLI_TRUSTED_DIRS ?? "")
    .split(":")
    .map((dir) => dir.trim())
    .filter((dir) => dir.startsWith("/"));
  return extra.length === 0 ? DEFAULT_TRUSTED_BIN_DIRS : [...DEFAULT_TRUSTED_BIN_DIRS, ...extra];
}

/** `host[:port]`, the shape a dev server is written in. */
function isLoopbackEntry(entry: string): boolean {
  let host: string;
  try {
    host = normalizedHostname(new URL(`http://${entry.trim()}`));
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1") return true;
  const value = ipv4ToInt(host);
  return value !== undefined && (value >>> 24) === 127;
}

/**
 * A caller-supplied host may only open loopback, because the caller is the model.
 * Reaching any wider network is the operator's decision, through
 * PSTACK_CONTROL_UI_ALLOW_HOSTS.
 */
function uiAllowHosts(extra?: readonly string[]): readonly string[] {
  const fromEnv = (process.env.PSTACK_CONTROL_UI_ALLOW_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
  return [...fromEnv, ...(extra ?? []).filter(isLoopbackEntry)];
}

function buildGitDiffArgs(base: string, paths?: string[]): string[] {
  const args = ["diff", "-U3", `${base}...HEAD`];
  if (paths?.length) {
    for (const p of paths) {
      if (p.startsWith("-") || p.includes("\0")) throw new Error(`invalid path: ${p}`);
    }
    return [...args, "--", ...paths];
  }
  return args;
}

function extractAddedLines(text: string): Array<{ file: string; text: string }> {
  const lines = text.split("\n");
  let currentFile = "";
  let result: Array<{ file: string; text: string }> = [];
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      currentFile = line.slice(4).replace(/^[ab]\//, "").trim();
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      result = [...result, { file: currentFile || "(unknown)", text: line.slice(1) }];
    }
  }
  return result;
}

type Hit = {
  label: string;
  severity: Severity;
  count: number;
  samples: string[];
  suggestion: SlopPattern["suggestion"];
  safeDelete: boolean;
};

function scanSlopPatterns(addedLines: Array<{ file: string; text: string }>): {
  buckets: Map<string, Hit>;
  suggestions: FixSuggestion[];
} {
  const buckets = new Map<string, Hit>();
  let allSuggestions: FixSuggestion[] = [];

  for (const row of addedLines) {
    const plusLine = `+${row.text}`;
    for (const pat of SLOP_PATTERNS) {
      pat.re.lastIndex = 0;
      const target = pat.lineAnchored ? plusLine : row.text;
      if (!pat.re.test(target)) continue;

      const existing = buckets.get(pat.label);
      const hit = existing || {
        label: pat.label,
        severity: pat.severity,
        count: 0,
        samples: [],
        suggestion: pat.suggestion,
        safeDelete: Boolean(pat.safeDelete),
      };

      const nextCount = hit.count + 1;
      const sample = `${row.file}: ${row.text.trim().slice(0, 140)}`;
      const nextSamples =
        hit.samples.length < 5 && !hit.samples.includes(sample)
          ? [...hit.samples, sample]
          : hit.samples;

      buckets.set(pat.label, { ...hit, count: nextCount, samples: nextSamples });

      if (allSuggestions.length < 80) {
        allSuggestions = [
          ...allSuggestions,
          {
            file: row.file,
            line: row.text,
            label: pat.label,
            severity: pat.severity,
            action: pat.suggestion,
            safeDelete: Boolean(pat.safeDelete),
          },
        ];
      }
    }
  }
  return { buckets, suggestions: allSuggestions };
}

async function scanDiffForSlop(
  pi: ExtensionAPI,
  base: string,
  paths: string[] | undefined,
  signal: AbortSignal | undefined,
): Promise<{ ranked: Hit[]; suggestions: FixSuggestion[]; addedLineCount: number }> {
  const args = buildGitDiffArgs(base, paths);
  const diff = await pi.exec("git", args, execOptions({ signal }));
  const unstaged = await pi.exec("git", ["diff", "-U3"], execOptions({ signal }));
  const addedLines = extractAddedLines(`${diff.stdout || ""}\n${unstaged.stdout || ""}`);
  const { buckets, suggestions } = scanSlopPatterns(addedLines);

  const ranked = [...buckets.values()].toSorted((a, b) => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    return order[a.severity] - order[b.severity] || b.count - a.count;
  });

  return { ranked, suggestions, addedLineCount: addedLines.length };
}

async function determineApplyAction(
  params: { dryRun?: boolean; applySafe?: boolean; autoApply?: boolean },
  suggestions: FixSuggestion[],
  ctx: { ui?: { confirm?: (title: string, msg: string) => Promise<boolean | undefined> } },
): Promise<{
  applyReport: string;
  applyDetails: { applied: number; files: string[]; dryRun?: boolean } | undefined;
  doApply: boolean;
}> {
  if (params.dryRun === true) {
    const would = suggestions.filter((s) => s.safeDelete && s.action === "delete-line");
    return {
      applyReport: `\n\ndryRun: would remove ${would.length} safeDelete line(s) across ${new Set(would.map((s) => s.file)).size} file(s) (no writes)`,
      applyDetails: { applied: 0, files: [...new Set(would.map((s) => s.file))], dryRun: true },
      doApply: false,
    };
  }

  let doApply = params.applySafe === true;
  let applyReport = "";

  if (!doApply && params.autoApply === true && suggestions.some((s) => s.safeDelete)) {
    const confirm = ctx.ui?.confirm;
    if (typeof confirm === "function") {
      const ok = await confirm(
        "pstack_deslop autoApply",
        `Delete ${suggestions.filter((s) => s.safeDelete).length} safe slop line(s)?`,
      );
      doApply = ok === true;
      if (!doApply) applyReport = "\n\nautoApply: declined by operator";
    } else {
      applyReport =
        "\n\nautoApply: skipped (no UI confirm available; pass applySafe:true to apply)";
    }
  }

  return { applyReport, applyDetails: undefined, doApply };
}

function formatResult(
  cwd: string,
  ranked: Hit[],
  suggestions: FixSuggestion[],
  addedLineCount: number,
  applyDetails?: { applied: number; files: string[]; dryRun?: boolean },
  applyReport = "",
): AgentToolResult<unknown> {
  if (ranked.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "pstack_deslop: no common slop patterns in added lines (still run /skill:unslop on prose surfaces).",
        },
      ],
      details: { findings: [], suggestions: [], cwd },
    };
  }

  const finalReport =
    applyDetails && !applyReport
      ? `\n\napplySafe: removed ${applyDetails.applied} line(s) in ${applyDetails.files.length} file(s): ${applyDetails.files.join(", ") || "(none)"}`
      : applyReport;

  const summary = ranked
    .map(
      (h) =>
        `- [${h.severity}] ${h.label}: ${h.count} hit(s) → ${h.suggestion}${h.safeDelete ? " (safeDelete)" : ""}`,
    )
    .join("\n");
  const samples = ranked
    .map((h) => `  ${h.label}:\n${h.samples.map((s) => `    - ${s}`).join("\n")}`)
    .join("\n");
  const fixBlock = suggestions
    .slice(0, 25)
    .map(
      (s) =>
        `- ${s.action}${s.safeDelete ? "/safe" : ""} [${s.severity}] ${s.file}: ${s.line.trim().slice(0, 100)} (${s.label})`,
    )
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: `pstack_deslop findings:\n${summary}\n\nSamples:\n${samples}\n\nStructured fixes (apply via edit, or re-run with applySafe:true for safeDelete lines):\n${fixBlock}\n\nThen /skill:unslop on prose. Added lines scanned: ${addedLineCount}.${finalReport}`,
      },
    ],
    details: { findings: ranked, suggestions, apply: applyDetails, cwd },
  };
}

function registerDeslopTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_deslop",
    label: "Pstack Deslop",
    description:
      "Pi-local deslop twin: scan added diff lines for slop patterns, sample offenders, return severity-ranked checklist plus structured fix suggestions. Optional applySafe deletes high-confidence safe comment/slop lines. Pair with /skill:unslop for prose. Does not require cursor-team-kit.",
    promptSnippet: "Scan diff for prose/code slop before commit",
    promptGuidelines: [
      "Use pstack_deslop before commit; then applySafe for safe comment deletes and /skill:unslop for prose.",
      "Never require cursor-team-kit — pstack_deslop + unslop are the Pi path.",
    ],
    parameters: DESLOP_PARAMETERS,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const base = params.base ?? "main";
      if (base.startsWith("-") || base.startsWith(".") || base.includes("..") || /\s/.test(base)) {
        throw new Error("invalid git diff base");
      }
      const { ranked, suggestions, addedLineCount } = await scanDiffForSlop(
        pi,
        base,
        stripAtPrefixes(params.paths),
        signal,
      );
      const { applyReport, applyDetails, doApply } = await determineApplyAction(
        params,
        suggestions,
        ctx,
      );

      if (doApply && suggestions.some((s) => s.safeDelete)) {
        const result = await applySafeDeletes(ctx.cwd, suggestions);
        return formatResult(ctx.cwd, ranked, suggestions, addedLineCount, {
          applied: result.applied,
          files: result.files,
        });
      }

      return formatResult(ctx.cwd, ranked, suggestions, addedLineCount, applyDetails, applyReport);
    },
  });
}

function registerControlCliTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_control_cli",
    label: "Pstack Control CLI",
    description:
      "Pi-local control-cli twin: run a CLI/TUI verification via argv array (no shell), capture stdout/stderr/exit, truncate for the model. Output caps at 50KB / 2000 lines; the trailer names the temp file with the full text.",
    promptSnippet: "Drive a CLI/TUI and capture proof output",
    promptGuidelines: [
      "Use pstack_control_cli with argv=[cmd,...args] — never a raw shell string.",
    ],
    parameters: CONTROL_CLI_PARAMETERS,
    async execute(_id, params, signal) {
      const [command, ...args] = params.argv;
      const resolution = resolveTrustedCommand(command, {
        commandAllowlist: ALLOWED_CONTROL_COMMAND_LIST,
        allowInterpreters: interpretersAllowed(),
        trustedDirs: trustedBinDirs(),
      });
      if (!resolution.ok) throw new Error(resolution.reason);
      const result = await pi.exec(resolution.command, args, execOptions({
        signal,
        timeout: (params.timeoutSeconds ?? 120) * 1000,
        cwd: stripAtPrefix(params.cwd),
      }));
      const raw = `${result.stdout || ""}\n${result.stderr || ""}`;
      const out = capToolOutput(raw || "(no output)", { keep: "tail", label: "control-cli" });
      return {
        content: [
          {
            type: "text",
            text: `exit ${result.code}\n\n${out.text}`,
          },
        ],
        details: {
          code: result.code,
          ...(out.outputPath ? { fullOutputPath: out.outputPath } : {}),
        },
      };
    },
  });
}

function registerControlUiTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_control_ui",
    label: "Pstack Control UI",
    description:
      "Pi-local control-ui twin: probe a URL (HTTP) or run a browser MCP hint. Returns status + body snippet. Body caps at 50KB / 2000 lines; the trailer names the temp file with the full body. Full browser automation depends on available MCP/browser tools — HTTP-only unless a browser MCP is present.",
    promptSnippet: "HTTP-probe a UI surface for proof",
    parameters: CONTROL_UI_PARAMETERS,
    async execute(_id, params, signal) {
      const allowHosts = uiAllowHosts(params.allowHosts);
      const validated = await validateProbeTarget(params.url, { allowHosts });
      if (!validated.ok) {
        throw new Error(`pstack_control_ui refused ${params.url}: ${validated.reason}`);
      }
      const method = params.method ?? "GET";
      try {
        const res = await fetchFollowingSafeRedirects(fetch, validated.target, {
          method,
          signal: signal ?? null,
          allowHosts,
        });
        const capped = capToolOutput(await res.text(), { keep: "head", label: "control-ui" });
        const expect = params.expectStatus;
        const ok = expect == null ? res.ok : res.status === expect;
        return {
          content: [
            {
              type: "text",
              text: `HTTP ${res.status} ok=${ok}\n\n${capped.text}`,
            },
          ],
          details: {
            status: res.status,
            ok,
            ...(capped.outputPath ? { fullOutputPath: capped.outputPath } : {}),
          },
        };
      } catch (err) {
        throw new Error(
          `pstack_control_ui failed: ${(err as Error).message}. HTTP-only twin. If you need real browser interaction, use an available browser MCP alongside this probe.`,
        );
      }
    },
  });
}

function registerDeslopCommand(pi: ExtensionAPI): void {
  pi.registerCommand("deslop", {
    description: "Run pstack_deslop twin then remind /skill:unslop",
    handler: async (_args, ctx) => {
      pi.sendUserMessage("Run pstack_deslop on the current diff against main (consider applySafe:true for safe comment deletes), then apply /skill:unslop to any prose surfaces and fix remaining findings with edit.", { expandPromptTemplates: true, deliverAs: "followUp" });
      ctx.ui.notify("Queued deslop twin", "info");
    },
  });
}

export function registerCompanions(pi: ExtensionAPI): void {
  registerDeslopTool(pi);
  registerControlCliTool(pi);
  registerControlUiTool(pi);
  registerDeslopCommand(pi);
}
