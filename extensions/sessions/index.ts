/**
 * pstack_sessions — list/search Pi session files for /skill:recall.
 * Official SessionManager.list when available; falls back to ~/.pi session dirs.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function candidateSessionDirs(cwd: string): string[] {
  const home = homedir();
  return [
    join(cwd, ".pi", "sessions"),
    join(home, ".pi", "agent", "sessions"),
    join(home, ".pi", "sessions"),
    process.env.PI_SESSION_DIR || "",
  ].filter(Boolean);
}

function listSessionFiles(cwd: string, limit: number): Array<{ path: string; mtimeMs: number; bytes: number }> {
  const out: Array<{ path: string; mtimeMs: number; bytes: number }> = [];
  for (const dir of candidateSessionDirs(cwd)) {
    if (!existsSync(dir)) continue;
    const walk = (d: string, depth: number) => {
      if (depth > 4) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const name of entries) {
        const p = join(d, name);
        try {
          const st = statSync(p);
          if (st.isDirectory()) walk(p, depth + 1);
          else if (name.endsWith(".jsonl") || name.endsWith(".json")) {
            out.push({ path: p, mtimeMs: st.mtimeMs, bytes: st.size });
          }
        } catch {
          /* skip */
        }
      }
    };
    walk(dir, 0);
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

export function registerSessions(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_sessions",
    label: "Pstack Sessions",
    description:
      "List or grep recent Pi session transcripts for recall. Prefer PI_SESSION_FILE / SessionManager; never read unrelated private sessions outside scope.",
    promptSnippet: "Find recent Pi sessions for recall",
    promptGuidelines: [
      "Use pstack_sessions for recall fan-out instead of Cursor ~/.cursor/projects/*/agent-transcripts.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | grep | current" }),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.action === "current") {
        const file = ctx.sessionManager.getSessionFile?.() ?? process.env.PI_SESSION_FILE ?? "(unknown)";
        return {
          content: [{ type: "text", text: `current session: ${file}` }],
          details: { file },
        };
      }
      const limit = params.limit ?? 20;
      const days = params.days ?? 7;
      const cutoff = Date.now() - days * 86400000;
      let files = listSessionFiles(ctx.cwd, 200).filter((f) => f.mtimeMs >= cutoff);
      if (params.action === "list") {
        files = files.slice(0, limit);
        const lines = files.map(
          (f) => `${new Date(f.mtimeMs).toISOString()}  ${f.bytes}B  ${f.path}`,
        );
        return {
          content: [{ type: "text", text: lines.join("\n") || "(no sessions found in known Pi dirs)" }],
          details: { files },
        };
      }
      if (params.action !== "grep") throw new Error("action must be list|grep|current");
      const q = (params.query ?? "").toLowerCase();
      if (!q) throw new Error("query required for grep");
      const hits: string[] = [];
      for (const f of files.slice(0, 80)) {
        try {
          const text = readFileSync(f.path, "utf8");
          if (!text.toLowerCase().includes(q)) continue;
          const snip = text
            .split(/\r?\n/)
            .filter((l) => l.toLowerCase().includes(q))
            .slice(0, 3)
            .join(" | ")
            .slice(0, 400);
          hits.push(`${f.path}\n  ${snip}`);
          if (hits.length >= limit) break;
        } catch {
          /* skip */
        }
      }
      return {
        content: [{ type: "text", text: hits.join("\n\n") || `(no hits for ${q})` }],
        details: { hitCount: hits.length },
      };
    },
  });
}
