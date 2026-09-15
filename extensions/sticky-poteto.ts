/**
 * Durable poteto sticky: re-inject poteto-mode skill body each turn when armed.
 * Stage 2 close-local-v2: also auto-match user text to a poteto playbook and
 * inject matched steps / forced poteto-mode routing (not skill-body append only).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPlaybookInjectBlock,
  buildPlaybookInjectFromId,
  matchPlaybook,
  type PlaybookMatch,
} from "./sticky-playbook.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POTETO_SKILL = resolve(PACKAGE_ROOT, "skills", "poteto-mode", "SKILL.md");

let cachedBody: string | undefined;

/** Strip YAML frontmatter; return markdown body (or empty). */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw.trim();
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw.trim();
  const after = raw.slice(end + 4);
  return after.replace(/^\r?\n/, "").trim();
}

/**
 * Load poteto-mode skill body for sticky injection.
 * Caches in-process; re-reads if file missing from cache after package updates via reload.
 */
export function loadPotetoStickyBody(): string {
  if (cachedBody != null) return cachedBody;
  if (!existsSync(POTETO_SKILL)) {
    cachedBody =
      "Poteto mode is active (pi-pstack). Skill file missing — apply /skill:poteto-mode when a playbook matches. Use pstack_spawn / pstack_swarm / pstack_arena.";
    return cachedBody;
  }
  const raw = readFileSync(POTETO_SKILL, "utf8");
  const body = stripFrontmatter(raw);
  // Cap extreme size so sticky cannot blow the context window; keep routing-critical head.
  const MAX = 48_000;
  if (Buffer.byteLength(body, "utf8") <= MAX) {
    cachedBody = body;
  } else {
    let cut = body.slice(0, MAX);
    while (Buffer.byteLength(cut, "utf8") > MAX) cut = cut.slice(0, -1);
    cachedBody = `${cut}\n\n[…poteto-mode skill truncated for sticky inject; full file: skills/poteto-mode/SKILL.md]`;
  }
  return cachedBody;
}

/** Clear cache (tests / reload). */
export function clearPotetoStickyCache(): void {
  cachedBody = undefined;
}

export interface StickyPromptOptions {
  /** Latest user turn text for playbook auto-match. */
  userText?: string;
  /** Precomputed match (tests / callers that already matched). */
  match?: PlaybookMatch | null;
  /** Min matcher score (default 2). */
  minScore?: number;
  /** Persisted playbook id from session restore — reinject full steps when no live match. */
  restoredPlaybookId?: string | null;
  /** Playbook assigned by this turn's input hook; renders as a matched block. */
  assignedPlaybookId?: string | null;
  /** Score for assignedPlaybookId (informational in the injected header). */
  assignedScore?: number;
}

/**
 * Build sticky system prompt: skill body + optional matched playbook steps.
 * When a playbook matches, forces poteto-mode routing for this turn.
 */
export function buildPotetoStickyPrompt(
  baseSystemPrompt: string,
  opts?: StickyPromptOptions,
): string {
  const body = loadPotetoStickyBody();
  const match =
    opts?.match === null
      ? undefined
      : opts?.match ??
        (opts?.assignedPlaybookId
          ? playbookMatchFromId(opts.assignedPlaybookId, opts.assignedScore ?? 0)
          : undefined) ??
        (opts?.userText ? matchPlaybook(opts.userText, opts.minScore ?? 2) : undefined);

  const baseParts = [
    baseSystemPrompt,
    "",
    "## Poteto mode (sticky — re-injected each turn)",
    body,
    "",
    "(End sticky skill body. Casual turns: stay concise. Opt out: /poteto-mode-off.)",
  ];

  const tailParts = match
    ? ["", buildPlaybookInjectBlock(match)]
    : (() => {
        const restoredBlock = opts?.restoredPlaybookId
          ? buildPlaybookInjectFromId(opts.restoredPlaybookId, { restored: true, score: 0 })
          : undefined;
        return restoredBlock
          ? ["", restoredBlock]
          : [
              "",
              "## Sticky playbook routing",
              "No high-confidence playbook match this turn. If the task clearly maps to a poteto playbook, open `skills/poteto-mode/playbooks/<id>.md` and copy steps into the todolist before acting.",
            ];
      })();

  const parts = [...baseParts, ...tailParts];

  return parts.join("\n");
}

/** Match-only helper for extension input hook. */
export function matchStickyPlaybook(userText: string): PlaybookMatch | undefined {
  return matchPlaybook(userText);
}

export { POTETO_SKILL, matchPlaybook };
export type { PlaybookMatch };
