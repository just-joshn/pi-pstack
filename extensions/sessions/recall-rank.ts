/**
 * Ranked merge of recall corpus hits (sessions + git + gh) for topic rebuild.
 * Pure — no ExtensionAPI.
 */

export type RecallSource = "session" | "git" | "gh";

export interface RecallHit {
  source: RecallSource;
  score: number;
  title: string;
  detail: string;
  /** Optional path / url / sha for citation */
  ref?: string;
}

export interface RankedRecallCorpus {
  query: string;
  hits: RecallHit[];
  sections: {
    sessions: string;
    git: string;
    gh: string;
  };
  rankedBlock: string;
}

function scoreText(query: string, text: string, base: number): number {
  const q = query.trim().toLowerCase();
  if (!q) return base;
  const lower = text.toLowerCase();
  let score = base;
  if (lower.includes(q)) score += 10;
  for (const tok of q.split(/\s+/).filter((t) => t.length > 2)) {
    if (lower.includes(tok)) score += 3;
  }
  // Prefer denser matches
  const first = lower.indexOf(q);
  if (first >= 0 && first < 80) score += 2;
  return score;
}

/** Parse session hit lines into RecallHit rows. */
export function hitsFromSessionSnippets(
  snippets: string[],
  query: string,
): RecallHit[] {
  return snippets.map((s) => {
    const [pathLine, ...rest] = s.split("\n");
    const detail = rest.join("\n").trim() || pathLine;
    return {
      source: "session" as const,
      score: scoreText(query, s, 20),
      title: (pathLine ?? "session").slice(0, 120),
      detail: detail.slice(0, 400),
      ref: pathLine?.trim(),
    };
  });
}

/** Parse git log --oneline lines. */
export function hitsFromGitLog(gitLog: string, query: string): RecallHit[] {
  if (!gitLog || gitLog.startsWith("git log unavailable") || gitLog.startsWith("(no")) {
    return [];
  }
  return gitLog
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([0-9a-f]{7,40})\s+(.*)$/i);
      const sha = m?.[1];
      const msg = m?.[2] ?? line;
      return {
        source: "git" as const,
        score: scoreText(query, line, 15),
        title: msg.slice(0, 120),
        detail: line.slice(0, 300),
        ref: sha,
      };
    });
}

/** Parse gh pr list formatted lines (#N [STATE] title …). */
export function hitsFromGhPrs(prs: string, query: string): RecallHit[] {
  if (
    !prs ||
    prs.startsWith("(gh not") ||
    prs.startsWith("(no matching") ||
    prs.startsWith("gh pr list failed")
  ) {
    return [];
  }
  return prs
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^#(\d+)\s+/);
      return {
        source: "gh" as const,
        score: scoreText(query, line, 18),
        title: line.slice(0, 140),
        detail: line.slice(0, 300),
        ref: m ? `#${m[1]}` : undefined,
      };
    });
}

/** Merge + rank hits descending by score (stable by source priority on ties). */
export function rankRecallHits(hits: RecallHit[], limit = 30): RecallHit[] {
  const sourcePri: Record<RecallSource, number> = { session: 3, gh: 2, git: 1 };
  return [...hits]
    .sort(
      (a, b) =>
        b.score - a.score || sourcePri[b.source] - sourcePri[a.source] || a.title.localeCompare(b.title),
    )
    .slice(0, limit);
}

/** Build full ranked corpus document. */
export function buildRankedRecallCorpus(opts: {
  query: string;
  days: number;
  sessionSnippets: string[];
  gitLog: string;
  ghPrs: string;
  limit?: number;
}): RankedRecallCorpus {
  const limit = opts.limit ?? 25;
  const hits = rankRecallHits(
    [
      ...hitsFromSessionSnippets(opts.sessionSnippets, opts.query),
      ...hitsFromGitLog(opts.gitLog, opts.query),
      ...hitsFromGhPrs(opts.ghPrs, opts.query),
    ],
    limit,
  );
  const rankedBlock =
    hits.length === 0
      ? "(no ranked hits)"
      : hits
          .map(
            (h, i) =>
              `${i + 1}. [${h.source} score=${h.score}] ${h.title}${h.ref ? ` ⟨${h.ref}⟩` : ""}\n   ${h.detail}`,
          )
          .join("\n");
  return {
    query: opts.query,
    hits,
    sections: {
      sessions: opts.sessionSnippets.join("\n\n") || "(no session hits)",
      git: opts.gitLog || "(no git log hits)",
      gh: opts.ghPrs || "(no gh PR hits)",
    },
    rankedBlock,
  };
}

export function formatRankedRecallBody(corpus: RankedRecallCorpus, days: number): string {
  return [
    "## Recall corpus (local, ranked)",
    `query=${corpus.query || "(none)"} days=${days}`,
    "",
    "### Ranked merge (sessions + git + gh)",
    corpus.rankedBlock,
    "",
    "### Pi sessions (raw)",
    corpus.sections.sessions,
    "",
    "### git log",
    corpus.sections.git,
    "",
    "### gh PRs",
    corpus.sections.gh,
  ].join("\n");
}
