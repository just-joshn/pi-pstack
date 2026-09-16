/**
 * Lightweight poteto playbook matcher (Cursor sticky host twin piece).
 * Scores user text against playbook keyword rules; loads matched steps for sticky inject.
 * Prefer twins over disclaimers: when sticky is on, force playbook routing into the turn.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLAYBOOKS_DIR = resolve(PACKAGE_ROOT, "skills", "poteto-mode", "playbooks");

export interface PlaybookRule {
  id: string;
  file: string;
  /** Higher wins ties after score. */
  priority: number;
  /** Case-insensitive substring / word cues. */
  cues: string[];
  /** Optional stronger regex cues (counted once each). */
  patterns?: RegExp[];
}

/** Ordered rules — more specific playbooks first via priority + cue specificity. */
export const PLAYBOOK_RULES: PlaybookRule[] = [
  {
    id: "babysit",
    file: "babysit.md",
    priority: 100,
    cues: [
      "babysit",
      "get it green",
      "merge-ready",
      "address the bugbot",
      "check on pr",
      "anything outstanding",
      "pr status",
      "watch the pr",
    ],
    patterns: [
      /\bcheck on\s+(?:pr\s*)?#?\d+/i,
      /\bbugbot\b.{0,60}\b(?:pulls?\s+request|pr|comment(?:ed|s)?|review(?:ed|s)?|thread|#\d+)/i,
    ],
  },
  {
    id: "shipping",
    file: "shipping.md",
    priority: 95,
    cues: ["land the stack", "ship it", "merge when ready", "land this", "ship the stack"],
    patterns: [/\b(?:land|ship)\b.*\b(?:pr|stack)\b/i],
  },
  {
    id: "investigation",
    file: "investigation.md",
    priority: 90,
    cues: [
      "how does",
      "why was",
      "are we sure",
      "should we do",
      "read-only investigation",
      "investigate",
    ],
    patterns: [/\bwhy (?:is|was|does|did)\b/i, /\bhow does\b/i],
  },
  {
    id: "bug-fix",
    file: "bug-fix.md",
    priority: 88,
    cues: ["bug fix", "fix the bug", "reproduce", "root cause", "regression"],
    patterns: [/\b(?:broken|crash(?:es|ing)?|bug)\b/i],
  },
  {
    id: "perf-issue",
    file: "perf-issue.md",
    priority: 85,
    cues: ["perf issue", "too slow", "latency", "performance regression"],
    patterns: [/\b(?:slow|latency|perf(?:ormance)?)\b/i],
  },
  {
    id: "hillclimb",
    file: "hillclimb.md",
    priority: 84,
    cues: ["hillclimb", "hill climb", "improve the metric", "before/after"],
  },
  {
    id: "runtime-forensics",
    file: "runtime-forensics.md",
    priority: 83,
    cues: ["runtime forensics", "memory leak", "idle cpu", "live instrumentation"],
  },
  {
    id: "trace-forensics",
    file: "trace-forensics.md",
    priority: 82,
    cues: ["trace forensics", "cpuprofile", "spindump", "heap snapshot"],
  },
  {
    id: "refactoring",
    file: "refactoring.md",
    priority: 80,
    cues: ["refactor", "rename", "extract", "dedupe", "behavior-preserving"],
  },
  {
    id: "feature",
    file: "feature.md",
    priority: 75,
    cues: ["new feature", "add a feature", "implement", "build this", "changed behavior"],
    patterns: [/\b(?:add|implement|build)\b.+\b(?:feature|endpoint|command)\b/i],
  },
  {
    id: "prototype",
    file: "prototype.md",
    priority: 78,
    cues: ["prototype", "mock it up", "try this layout", "sketch it", "throwaway sketch"],
  },
  {
    id: "visual-parity",
    file: "visual-parity.md",
    priority: 77,
    cues: ["visual parity", "pixel-exact", "pixel perfect", "match the ui"],
  },
  {
    id: "authoring-a-skill",
    file: "authoring-a-skill.md",
    priority: 86,
    cues: ["author a skill", "write a skill", "edit skill.md", "authoring a skill", "modify a skill"],
    patterns: [/\bSKILL\.md\b/],
  },
  {
    id: "eval",
    file: "eval.md",
    priority: 70,
    cues: ["eval the skill", "prompt change", "agent behavior eval"],
  },
  {
    id: "autonomous-run",
    file: "autonomous-run.md",
    priority: 92,
    cues: ["run until done", "poll until", "going to bed", "fully autonomous", "autonomously", "finish condition", "don't stop"],
  },
  {
    id: "orchestrate",
    file: "orchestrate.md",
    priority: 91,
    cues: ["orchestrate", "own this migration", "run this whole project", "standing program"],
  },
  {
    id: "autopilot-full",
    file: "autopilot-full.md",
    priority: 89,
    cues: ["autopilot this queue", "full autopilot", "one-owner-per-pr"],
  },
  {
    id: "autopilot-stack",
    file: "autopilot-stack.md",
    priority: 88,
    cues: ["autopilot-stack", "stack them, don't ship", "build the stack, i'll land"],
  },
  {
    id: "session-pickup",
    file: "session-pickup.md",
    priority: 87,
    cues: ["session pickup", "pick up where", "resume the session", "take over this"],
  },
  {
    id: "pause-safely",
    file: "pause-safely.md",
    priority: 86,
    cues: ["pause safely", "suspend work", "going offline", "context compaction"],
  },
  {
    id: "multi-phase-plan",
    file: "multi-phase-plan.md",
    priority: 74,
    cues: ["multi-phase", "multi-pr plan", "stacked prs", "phase plan"],
  },
  {
    id: "worktree-cleanup",
    file: "worktree-cleanup.md",
    priority: 72,
    cues: [
      "clean up worktrees",
      "prune worktrees",
      "free up space",
      "what's using my disk",
      "delete old simulators",
    ],
  },
  {
    id: "opening-a-pr",
    file: "opening-a-pr.md",
    priority: 60,
    cues: ["open a pr", "opening a pr", "create a pull request"],
  },
];

export interface PlaybookMatch {
  id: string;
  file: string;
  path: string;
  score: number;
  priority: number;
}

/** Score user text; return best match or undefined if below threshold. */
export function matchPlaybook(userText: string, minScore = 2): PlaybookMatch | undefined {
  const text = (userText ?? "").trim();
  if (!text) return undefined;
  const lower = text.toLowerCase();
  let best: PlaybookMatch | undefined;

  for (const rule of PLAYBOOK_RULES) {
    let score = 0;
    for (const cue of rule.cues) {
      if (lower.includes(cue.toLowerCase())) score += cue.split(/\s+/).length >= 3 ? 3 : 2;
    }
    for (const pat of rule.patterns ?? []) {
      pat.lastIndex = 0;
      if (pat.test(text)) score += 3;
    }
    // Explicit /skill:poteto-mode <playbook> or playbooks/<id>
    if (new RegExp(`\\bplaybooks/${rule.id}\\b`, "i").test(text)) score += 10;
    if (new RegExp(`\\b${rule.id}\\s+playbook\\b`, "i").test(text)) score += 4;
    if (score < minScore) continue;
    const path = join(PLAYBOOKS_DIR, rule.file);
    const cand: PlaybookMatch = {
      id: rule.id,
      file: rule.file,
      path,
      score,
      priority: rule.priority,
    };
    if (
      !best ||
      cand.score > best.score ||
      (cand.score === best.score && cand.priority > best.priority)
    ) {
      best = cand;
    }
  }
  return best;
}

/** Strip frontmatter and cap playbook body for sticky inject. */
export function loadPlaybookBody(fileOrId: string, maxBytes = 24_000): string {
  let file = fileOrId;
  if (!file.endsWith(".md")) file = `${file}.md`;
  const path = file.includes("/") ? file : join(PLAYBOOKS_DIR, file);
  if (!existsSync(path)) return `(playbook missing: ${path})`;
  let raw = readFileSync(path, "utf8");
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end >= 0) raw = raw.slice(end + 4).replace(/^\r?\n/, "");
  }
  const body = raw.trim();
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  let cut = body.slice(0, maxBytes);
  while (Buffer.byteLength(cut, "utf8") > maxBytes) cut = cut.slice(0, -1);
  return `${cut}\n\n[…playbook truncated for sticky inject; full: ${path}]`;
}

/** List known playbook ids (disk ∩ rules). */
export function listPlaybookIds(): string[] {
  const onDisk = new Set(
    existsSync(PLAYBOOKS_DIR)
      ? readdirSync(PLAYBOOKS_DIR)
          .filter((n) => n.endsWith(".md"))
          .map((n) => n.replace(/\.md$/, ""))
      : [],
  );
  return PLAYBOOK_RULES.map((r) => r.id).filter((id) => onDisk.has(id));
}

/**
 * Build sticky injection block: skill body already provided; append matched playbook
 * steps and forced routing instruction.
 */
/** Resolve a PlaybookMatch from a persisted playbook id (session restore). */
export function playbookMatchFromId(id: string, score = 0): PlaybookMatch | undefined {
  const rule = PLAYBOOK_RULES.find((r) => r.id === id);
  if (!rule) {
    const file = `${id}.md`;
    const path = join(PLAYBOOKS_DIR, file);
    if (!existsSync(path)) return undefined;
    return { id, file, score, priority: 0 };
  }
  return { id: rule.id, file: rule.file, score, priority: rule.priority };
}

/** Inject block for a restored/forced playbook id (full steps, not a routing note). */
export function buildPlaybookInjectFromId(
  id: string,
  opts?: { score?: number; restored?: boolean },
): string | undefined {
  const match = playbookMatchFromId(id, opts?.score ?? 0);
  if (!match) return undefined;
  const body = loadPlaybookBody(match.file);
  const header = opts?.restored
    ? `## Restored sticky playbook (steps reinjected)`
    : `## Matched playbook (sticky routing — forced)`;
  const why = opts?.restored
    ? `Session restore / force-invoke fallback → **${match.id}** (\`playbooks/${match.file}\`).`
    : `Matched **${match.id}** (score=${match.score}) → \`playbooks/${match.file}\`.`;
  return [
    header,
    why,
    `Open a todolist whose first items are this playbook's steps, copied in verbatim.`,
    `Do not soft-ignore: this turn is poteto-mode + ${match.id}.`,
    "",
    body,
    "",
    `(End matched playbook ${match.id}.)`,
  ].join("\n");
}

export function buildPlaybookInjectBlock(match: PlaybookMatch): string {
  const body = loadPlaybookBody(match.file);
  return [
    `## Matched playbook (sticky routing — forced)`,
    `Matched **${match.id}** (score=${match.score}) → \`playbooks/${match.file}\`.`,
    `Open a todolist whose first items are this playbook's steps, copied in verbatim.`,
    `Do not soft-ignore: this turn is poteto-mode + ${match.id}.`,
    "",
    body,
    "",
    `(End matched playbook ${match.id}.)`,
  ].join("\n");
}

export { PACKAGE_ROOT };
