/**
 * pstack_sessions — list/search Pi sessions + ranked local recall corpus
 * (sessions + git log + gh PRs) for /skill:recall topic rebuild.
 */
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { projectConfigCwd } from "../models/config.ts";
import { recallGitLog, recallGhPrs } from "./recall-corpus.ts";
import { buildRankedRecallCorpus, formatRankedRecallBody } from "./recall-rank.ts";

export { recallGitLog, recallGhPrs } from "./recall-corpus.ts";
export {
  buildRankedRecallCorpus,
  formatRankedRecallBody,
  rankRecallHits,
} from "./recall-rank.ts";

function candidateSessionDirs(cwd: string, trustedConfigCwd: string | undefined): string[] {
  const home = homedir();
  return [
    trustedConfigCwd ? join(trustedConfigCwd, CONFIG_DIR_NAME, "sessions") : "",
    join(home, ".pi", "agent", "sessions"),
    join(home, ".pi", "sessions"),
    process.env.PI_SESSION_DIR || "",
  ].filter(Boolean);
}

function walkSessionDir(
  d: string,
  depth: number,
): Array<{ path: string; mtimeMs: number; bytes: number }> {
  if (depth > 4) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(d);
  } catch {
    /* skip permission denied or missing */
    return [];
  }
  return entries.flatMap((name) => {
    const p = join(d, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        return walkSessionDir(p, depth + 1);
      } else if (name.endsWith(".jsonl") || name.endsWith(".json")) {
        return [{ path: p, mtimeMs: st.mtimeMs, bytes: st.size }];
      }
      return [];
    } catch {
      /* skip inaccessible files */
      return [];
    }
  });
}

function listSessionFiles(
  cwd: string,
  limit: number,
  trustedConfigCwd: string | undefined,
): Array<{ path: string; mtimeMs: number; bytes: number }> {
  const collected = candidateSessionDirs(cwd, trustedConfigCwd)
    .filter(existsSync)
    .flatMap((dir) => walkSessionDir(dir, 0));
  return collected.toSorted((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function handleListAction(
  files: Array<{ path: string; mtimeMs: number; bytes: number }>,
  limit: number,
) {
  const sliced = files.slice(0, limit);
  const lines = sliced.map(
    (f) => `${new Date(f.mtimeMs).toISOString()}  ${f.bytes}B  ${f.path}`,
  );
  return {
    content: [{ type: "text", text: lines.join("\n") || "(no sessions found in known Pi dirs)" }],
    details: { files: sliced },
  };
}

function grepSingleFile(
  f: { path: string },
  query: string,
): string | undefined {
  try {
    const text = readFileSync(f.path, "utf8");
    if (!text.toLowerCase().includes(query)) return undefined;
    const snip = text
      .split(/\r?\n/)
      .filter((l) => l.toLowerCase().includes(query))
      .slice(0, 3)
      .join(" | ")
      .slice(0, 400);
    return `${f.path}\n  ${snip}`;
  } catch {
    /* skip read errors or permission denied */
    return undefined;
  }
}

function handleGrepAction(
  files: Array<{ path: string; mtimeMs: number; bytes: number }>,
  query: string,
  limit: number,
) {
  const q = query.toLowerCase();
  if (!q) throw new Error("query required for grep");
  const hits = files
    .slice(0, 80)
    .map((f) => grepSingleFile(f, q))
    .filter((h): h is string => h !== undefined)
    .slice(0, limit);
  return {
    content: [{ type: "text", text: hits.join("\n\n") || `(no hits for ${q})` }],
    details: { hitCount: hits.length },
  };
}

function searchSingleSessionFile(
  f: { path: string },
  query: string,
): string | undefined {
  try {
    const text = readFileSync(f.path, "utf8");
    if (!text.toLowerCase().includes(query.toLowerCase())) return undefined;
    const snip = text
      .split(/\r?\n/)
      .filter((l) => l.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 2)
      .join(" | ")
      .slice(0, 300);
    return `${f.path}\n  ${snip}`;
  } catch {
    /* skip read errors or permission denied */
    return undefined;
  }
}

function buildSessionHits(
  files: Array<{ path: string; mtimeMs: number; bytes: number }>,
  query: string,
  limit: number,
): string[] {
  if (query) {
    return files
      .slice(0, 80)
      .map((f) => searchSingleSessionFile(f, query))
      .filter((h): h is string => h !== undefined)
      .slice(0, limit);
  }
  return files
    .slice(0, limit)
    .map((f) => `${new Date(f.mtimeMs).toISOString()}  ${f.path}`);
}

async function handleRecallAction(
  files: Array<{ path: string; mtimeMs: number; bytes: number }>,
  query: string,
  limit: number,
  days: number,
  cwd: string,
) {
  const q = query ?? "";
  const sessionHits = buildSessionHits(files, q, limit);
  const gitLog = await recallGitLog(cwd, q, limit);
  const prs = await recallGhPrs(cwd, q, Math.min(limit, 15));
  const corpus = buildRankedRecallCorpus({
    query: q,
    days,
    sessionSnippets: sessionHits,
    gitLog,
    ghPrs: prs,
    limit,
  });
  const body = formatRankedRecallBody(corpus, days);
  return {
    content: [{ type: "text", text: body }],
    details: {
      sessionHits: sessionHits.length,
      rankedHits: corpus.hits.length,
      corpus: ["sessions", "git-log", "gh-prs", "ranked-merge"],
      top: corpus.hits.slice(0, 5).map((h) => ({
        source: h.source,
        score: h.score,
        title: h.title,
      })),
    },
  };
}

export function registerSessions(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pstack_sessions",
    label: "Pstack Sessions",
    description:
      "List/grep Pi session transcripts, or rebuild a ranked local recall corpus (sessions + git log + gh PRs merged by topic relevance). Prefer for /skill:recall topic rebuild.",
    promptSnippet: "Find recent Pi sessions / ranked recall corpus for a topic",
    promptGuidelines: [
      "Use pstack_sessions for recall fan-out instead of Cursor ~/.cursor/projects/*/agent-transcripts.",
      "pstack_sessions action=recall fans out across sessions + git log + gh PRs and returns a ranked merge (local workflow twin of rebuild-context-for-topic).",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "grep", "current", "recall"] as const, {
        description: "list | grep | current | recall",
      }),
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
      const files = listSessionFiles(ctx.cwd, 200, projectConfigCwd(ctx)).filter((f) => f.mtimeMs >= cutoff);

      if (params.action === "list") {
        return handleListAction(files, limit);
      }

      if (params.action === "recall") {
        return await handleRecallAction(files, params.query ?? "", limit, days, ctx.cwd);
      }

      if (params.action !== "grep") throw new Error("action must be list|grep|current|recall");
      return handleGrepAction(files, params.query ?? "", limit);
    },
  });
}
