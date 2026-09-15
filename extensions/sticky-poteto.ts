/**
 * Durable poteto sticky: re-inject poteto-mode skill body each turn when armed.
 * Stronger than a one-line systemPrompt nudge (Cursor sticky-skill twin).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

export function buildPotetoStickyPrompt(baseSystemPrompt: string): string {
  const body = loadPotetoStickyBody();
  return `${baseSystemPrompt}\n\n## Poteto mode (sticky — re-injected each turn)\n${body}\n\n(End sticky. Casual turns: stay concise. Opt out: /poteto-mode-off.)`;
}

export { POTETO_SKILL };
