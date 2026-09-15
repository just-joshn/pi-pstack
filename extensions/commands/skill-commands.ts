/**
 * Registers one Pi slash command per upstream pstack skill so `/name` (Cursor's contract)
 * dispatches to `/skill:name`, forwarding user-typed arguments. Also carries the three
 * Pi-only conveniences (`babysit`, `ship`, `deslop`) that replace the deleted
 * `prompts/*.md` templates, whose single-pass substitution dropped both args and the
 * `/skill:` skill-load pipeline (D1/D2 in the alias-command-surface task brief).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILLS_DIR = resolve(MODULE_DIR, "../../skills");

/** Names the extension already registers with richer behavior (sticky arming, tool stripping). */
export const RESERVED_COMMAND_NAMES = [
  "poteto-mode",
  "poteto-mode-off",
  "pstack",
  "pstack-readonly",
  "pstack-readonly-off",
] as const;

export interface PiOnlyCommand {
  name: string;
  description: string;
  body: string;
}

/** Pi-only conveniences that are not upstream skills; formerly `prompts/*.md`. */
export const PI_ONLY_COMMANDS: PiOnlyCommand[] = [
  {
    name: "babysit",
    description: "Babysit a PR to green",
    body: "Follow poteto-mode playbooks/babysit.md. Use pstack_babysit / pstack_loop (mode=dynamic) for wakes, not Cursor /loop chrome.",
  },
  {
    name: "ship",
    description: "Ship a green stack",
    body: "Follow poteto-mode playbooks/shipping.md. Use pstack_ship (gh-only). Per-PR verify via local pstack_spawn + worktree (background omit/default; drain pstack_jobs), not Cursor cloud VMs.",
  },
  {
    name: "deslop",
    description: "Deslop twin before commit",
    body: "Run pstack_deslop on the current diff, then /skill:unslop.",
  },
];

export interface SkillCommand {
  name: string;
  description: string;
}

function parseFoldedScalar(bodyLines: string[], startIndex: number): { value: string; nextIndex: number } {
  const parts: string[] = [];
  let i = startIndex;
  while (i < bodyLines.length && /^\s+\S/.test(bodyLines[i])) {
    parts.push(bodyLines[i].trim());
    i++;
  }
  return { value: parts.join(" "), nextIndex: i };
}

function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Parses the `name:`/`description:` keys out of a SKILL.md frontmatter block. Handles the
 * three scalar shapes upstream skills use: plain (`bro`), double-quoted with embedded
 * escaped quotes (`how`), and `>-` folded block scalars (`make-bot-ui`).
 */
function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const body = lines.slice(1, end);
  const out: Record<string, string> = {};
  for (let i = 0; i < body.length; i++) {
    const m = /^([a-zA-Z0-9_-]+):\s?(.*)$/.exec(body[i]);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (rest === ">-" || rest === ">" || rest === "|-" || rest === "|") {
      const folded = parseFoldedScalar(body, i + 1);
      out[key] = folded.value;
      i = folded.nextIndex - 1;
      continue;
    }
    out[key] = unquote(rest);
  }
  return out;
}

/** Reads every skill's SKILL.md under skillsDir, deduped and sorted by name. */
export function readSkillCommands(skillsDir: string = DEFAULT_SKILLS_DIR): SkillCommand[] {
  let dirents;
  try {
    dirents = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const byName = new Map<string, SkillCommand>();
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const skillPath = join(skillsDir, dirent.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const frontmatter = parseFrontmatter(readFileSync(skillPath, "utf8"));
    if (!frontmatter.name) continue;
    if (!byName.has(frontmatter.name)) {
      byName.set(frontmatter.name, { name: frontmatter.name, description: frontmatter.description ?? "" });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Registers `/name` for every skill not in `reserved`, forwarding trimmed user args into
 * `/skill:name <args>` so Pi's native skill loader expands it (not the removed prompt
 * templates, whose single-pass substitution dropped both args and the skill wrap).
 */
export function registerSkillCommands(
  pi: ExtensionAPI,
  opts: { skillsDir?: string; reserved?: Iterable<string> } = {},
): void {
  const reserved = new Set(opts.reserved ?? RESERVED_COMMAND_NAMES);
  for (const skill of readSkillCommands(opts.skillsDir)) {
    if (reserved.has(skill.name)) continue;
    pi.registerCommand(skill.name, {
      description: skill.description || `Invoke the ${skill.name} skill`,
      handler: async (args) => {
        const trimmed = args.trim();
        const msg = trimmed ? `/skill:${skill.name} ${trimmed}` : `/skill:${skill.name}`;
        pi.sendUserMessage(msg, { expandPromptTemplates: true });
      },
    });
  }
}

/** Registers the three Pi-only conveniences, forwarding args the same way as skill commands. */
export function registerPiOnlyCommands(pi: ExtensionAPI, commands: PiOnlyCommand[] = PI_ONLY_COMMANDS): void {
  for (const cmd of commands) {
    pi.registerCommand(cmd.name, {
      description: cmd.description,
      handler: async (args) => {
        const trimmed = args.trim();
        const msg = trimmed ? `${cmd.body} ${trimmed}` : cmd.body;
        pi.sendUserMessage(msg, { expandPromptTemplates: true });
      },
    });
  }
}
