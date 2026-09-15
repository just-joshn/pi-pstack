/**
 * Thin Pi-native twins for cursor-team-kit deslop / control-cli / control-ui.
 * Skills remain the philosophy; these tools give callable verification surfaces.
 * No bash -lc of raw model strings — argv arrays only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

type Severity = "high" | "medium" | "low";

interface SlopPattern {
  re: RegExp;
  label: string;
  severity: Severity;
  /** If true, match against "+"-prefixed unified-diff line form. */
  lineAnchored?: boolean;
}

const SLOP_PATTERNS: SlopPattern[] = [
  { re: /\b(?:Just|Simply|Easily|Basically|Clearly|Obviously)\b/g, label: "hedge/filler adverb", severity: "medium" },
  { re: /—/g, label: "long-dash character (unslop)", severity: "medium" },
  { re: /\/\/\s*(?:Phase|Step|NOTE|TODO|IMPORTANT|FIXME|do not remove)/gi, label: "narration / alibi comment", severity: "high" },
  { re: /\b(?:in order to|due to the fact|it should be noted|it is worth noting)\b/gi, label: "inflated prose", severity: "medium" },
  { re: /\b(?:leverage|utilize|facilitate|robust|seamless|comprehensive|delve|tapestry)\b/gi, label: "AI filler lexicon", severity: "high" },
  { re: /\b(?:Note that|This ensures that|This allows us to|In this section)\b/g, label: "throat-clearing prose", severity: "medium" },
  { re: /console\.(?:log|debug|info)\(/g, label: "debug console in diff", severity: "high" },
  { re: /^\+\s*\/\/\s*[=-]{3,}/gm, label: "banner/separator comment", severity: "high", lineAnchored: true },
  { re: /^\+\s*\/\*\s*=+/gm, label: "banner block comment", severity: "high", lineAnchored: true },
  { re: /^\+\s*#\s*(?:TODO|FIXME|XXX|HACK)\b/gim, label: "hash alibi comment", severity: "medium", lineAnchored: true },
  { re: /\b(?:as an AI|I hope this helps|Let me know if)\b/gi, label: "assistant leftovers", severity: "high" },
  { re: /(?:✅|❌|🚀|✨|💡|🎉)/g, label: "emoji noise in code/prose", severity: "low" },
  { re: /^\+\s*\/\/\s*$/gm, label: "empty comment line", severity: "low", lineAnchored: true },
  { re: /\/\*\s*eslint-disable\s*\*\//g, label: "blanket eslint-disable", severity: "medium" },
  { re: /:\s*any\b/g, label: "TypeScript any in added lines", severity: "medium" },
];

export function registerCompanions(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_deslop",
    label: "Pstack Deslop",
    description:
      "Closest Pi twin to cursor-team-kit /deslop: scan added diff lines for slop patterns, sample offenders by file, return a severity-ranked deletion checklist. Does not edit; parent applies via edit/unslop skill.",
    promptSnippet: "Scan diff for prose/code slop before commit",
    promptGuidelines: [
      "Use pstack_deslop before commit instead of cursor-team-kit /deslop; then apply fixes with edit and /skill:unslop.",
    ],
    parameters: Type.Object({
      base: Type.Optional(Type.String({ description: "git diff base (default main)" })),
      paths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const base = params.base ?? "main";
      if (base.startsWith("-") || base.includes("..") || /\s/.test(base)) {
        throw new Error("invalid git diff base");
      }
      const args = ["diff", "-U3", `${base}...HEAD`];
      if (params.paths?.length) {
        for (const p of params.paths) {
          if (p.startsWith("-") || p.includes("\0")) throw new Error(`invalid path: ${p}`);
        }
        args.push("--", ...params.paths);
      }
      const diff = await pi.exec("git", args, { signal });
      const unstaged = await pi.exec("git", ["diff", "-U3"], { signal });
      const text = `${diff.stdout || ""}\n${unstaged.stdout || ""}`;

      const addedLines: Array<{ file: string; text: string }> = [];
      let currentFile = "";
      for (const line of text.split("\n")) {
        if (line.startsWith("+++ ")) {
          currentFile = line.slice(4).replace(/^[ab]\//, "").trim();
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
          addedLines.push({ file: currentFile || "(unknown)", text: line.slice(1) });
        }
      }

      type Hit = { label: string; severity: Severity; count: number; samples: string[] };
      const buckets = new Map<string, Hit>();

      for (const row of addedLines) {
        const plusLine = `+${row.text}`;
        for (const pat of SLOP_PATTERNS) {
          pat.re.lastIndex = 0;
          const target = pat.lineAnchored ? plusLine : row.text;
          if (!pat.re.test(target)) continue;
          let hit = buckets.get(pat.label);
          if (!hit) {
            hit = { label: pat.label, severity: pat.severity, count: 0, samples: [] };
            buckets.set(pat.label, hit);
          }
          hit.count++;
          if (hit.samples.length < 5) {
            const sample = `${row.file}: ${row.text.trim().slice(0, 140)}`;
            if (!hit.samples.includes(sample)) hit.samples.push(sample);
          }
        }
      }

      const ranked = [...buckets.values()].sort((a, b) => {
        const order = { high: 0, medium: 1, low: 2 } as const;
        return order[a.severity] - order[b.severity] || b.count - a.count;
      });

      if (ranked.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "pstack_deslop: no common slop patterns in added lines (still run /skill:unslop on prose surfaces).",
            },
          ],
          details: { findings: [], cwd: ctx.cwd },
        };
      }

      const summary = ranked.map((h) => `- [${h.severity}] ${h.label}: ${h.count} hit(s)`).join("\n");
      const samples = ranked
        .map((h) => `  ${h.label}:\n${h.samples.map((s) => `    - ${s}`).join("\n")}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `pstack_deslop findings:\n${summary}\n\nSamples:\n${samples}\n\nApply via edit + /skill:unslop. Added lines scanned: ${addedLines.length}.`,
          },
        ],
        details: { findings: ranked, cwd: ctx.cwd },
      };
    },
  });

  pi.registerTool({
    name: "pstack_control_cli",
    label: "Pstack Control CLI",
    description:
      "Closest Pi twin to cursor-team-kit control-cli: run a CLI/TUI verification via argv array (no shell), capture stdout/stderr/exit, truncate for the model.",
    promptSnippet: "Drive a CLI/TUI and capture proof output",
    promptGuidelines: [
      "Use pstack_control_cli with argv=[cmd,...args] — never a raw shell string.",
    ],
    parameters: Type.Object({
      argv: Type.Array(Type.String(), {
        minItems: 1,
        description: "Argv array: [command, ...args]. No shell metacharacters.",
      }),
      cwd: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    }),
    async execute(_id, params, signal) {
      const [command, ...args] = params.argv;
      if (!command || command.startsWith("-")) {
        throw new Error("argv[0] must be a command name/path");
      }
      const base = command.split("/").pop() ?? command;
      if (!ALLOWED_CONTROL_COMMANDS.has(base)) {
        throw new Error(
          `command '${base}' not in control_cli allowlist (${[...ALLOWED_CONTROL_COMMANDS].join(", ")})`,
        );
      }
      const result = await pi.exec(command, args, {
        signal,
        timeout: (params.timeoutSeconds ?? 120) * 1000,
        cwd: params.cwd,
      });
      const out = `${result.stdout || ""}\n${result.stderr || ""}`.slice(0, 50_000);
      return {
        content: [
          {
            type: "text",
            text: `exit ${result.code}\n\n${out || "(no output)"}`,
          },
        ],
        details: { code: result.code },
      };
    },
  });

  pi.registerTool({
    name: "pstack_control_ui",
    label: "Pstack Control UI",
    description:
      "Closest Pi twin to cursor-team-kit control-ui: probe a URL (HTTP) or run a browser MCP hint. Returns status + body snippet. Full browser automation depends on available MCP/browser tools — HTTP-only unless a browser MCP is present.",
    promptSnippet: "HTTP-probe a UI surface for proof",
    parameters: Type.Object({
      url: Type.String(),
      method: Type.Optional(Type.String()),
      expectStatus: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params, signal) {
      const method = params.method ?? "GET";
      try {
        const res = await fetch(params.url, { method, signal: signal ?? null });
        const body = (await res.text()).slice(0, 20_000);
        const expect = params.expectStatus;
        const ok = expect == null ? res.ok : res.status === expect;
        return {
          content: [
            {
              type: "text",
              text: `HTTP ${res.status} ok=${ok}\n\n${body}`,
            },
          ],
          details: { status: res.status, ok },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `pstack_control_ui failed: ${(err as Error).message}\nHTTP-only twin. If you need real browser interaction, use an available browser MCP alongside this probe.`,
            },
          ],
          details: { ok: false },
        };
      }
    },
  });

  pi.registerCommand("deslop", {
    description: "Run pstack_deslop twin then remind /skill:unslop",
    handler: async (_args, ctx) => {
      pi.sendUserMessage(
        "Run pstack_deslop on the current diff against main, then apply /skill:unslop to any prose surfaces and fix findings with edit.",
        { expandPromptTemplates: true },
      );
      ctx.ui.notify("Queued deslop twin", "info");
    },
  });
}
