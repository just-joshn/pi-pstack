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

export function registerCompanions(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_deslop",
    label: "Pstack Deslop",
    description:
      "Closest Pi twin to cursor-team-kit /deslop: scan a diff or paths for slop patterns and return a deletion checklist. Does not edit; parent applies via edit/unslop skill.",
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
      const args = ["diff", `${base}...HEAD`];
      if (params.paths?.length) {
        for (const p of params.paths) {
          if (p.startsWith("-") || p.includes("\0")) throw new Error(`invalid path: ${p}`);
        }
        args.push("--", ...params.paths);
      }
      const diff = await pi.exec("git", args, { signal });
      const unstaged = await pi.exec("git", ["diff"], { signal });
      const text = `${diff.stdout || ""}\n${unstaged.stdout || ""}`;
      const findings: string[] = [];
      const patterns: Array<[RegExp, string]> = [
        [/\b(?:Just|Simply|Easily|Basically|Clearly)\b/g, "hedge/filler adverb"],
        [/—/g, "long-dash character (unslop)"],
        [/\/\/\s*(?:Phase|Step|NOTE|TODO|IMPORTANT|do not remove)/gi, "narration / alibi comment"],
        [/\b(?:in order to|due to the fact|it should be noted)\b/gi, "inflated prose"],
        [/console\.log\(/g, "debug console.log in diff"],
      ];
      for (const [re, label] of patterns) {
        const matches = text.match(re);
        if (matches?.length) findings.push(`${label}: ${matches.length} hit(s)`);
      }
      return {
        content: [
          {
            type: "text",
            text:
              findings.length === 0
                ? "pstack_deslop: no common slop patterns in diff (still run /skill:unslop on prose surfaces)."
                : `pstack_deslop findings:\n${findings.map((f) => `- ${f}`).join("\n")}\n\nApply via edit + /skill:unslop. Full diff bytes: ${Buffer.byteLength(text)}.`,
          },
        ],
        details: { findings, cwd: ctx.cwd },
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
      "Closest Pi twin to cursor-team-kit control-ui: probe a URL (HTTP) or run a browser MCP hint. Returns status + body snippet. Full browser automation depends on available MCP/browser tools.",
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
              text: `pstack_control_ui failed: ${(err as Error).message}\nIf you need real browser interaction, use an available browser MCP alongside this probe.`,
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
