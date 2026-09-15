/**
 * Thin Pi-native twins for cursor-team-kit deslop / control-cli / control-ui.
 * Skills remain the philosophy; these tools give callable verification surfaces.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
      const diff = await pi.exec(
        "bash",
        [
          "-lc",
          params.paths?.length
            ? `git diff ${JSON.stringify(base)} -- ${params.paths.map((p) => JSON.stringify(p)).join(" ")}`
            : `git diff ${JSON.stringify(base)}...HEAD; git diff`,
        ],
        { signal },
      );
      const text = diff.stdout || "";
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
      "Closest Pi twin to cursor-team-kit control-cli: run a CLI/TUI verification command, capture stdout/stderr/exit, truncate for the model.",
    promptSnippet: "Drive a CLI/TUI and capture proof output",
    promptGuidelines: [
      "Use pstack_control_cli to prove CLI behavior instead of cursor-team-kit control-cli.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
      cwd: Type.Optional(Type.String()),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    }),
    async execute(_id, params, signal) {
      const result = await pi.exec("bash", ["-lc", params.command], {
        signal,
        timeout: (params.timeoutSeconds ?? 120) * 1000,
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
