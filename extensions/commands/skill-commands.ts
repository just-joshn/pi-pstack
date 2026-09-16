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
import { chromeStatusLabel, chromeThemeToken, readSkillChrome, splitFrontmatter, type SkillChrome } from "../lib/skill-chrome.ts";

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
];

export interface SkillCommand {
  name: string;
  description: string;
}

/** Reads every skill's SKILL.md under skillsDir, deduped and sorted by name. */
export function readSkillCommands(skillsDir: string = DEFAULT_SKILLS_DIR): SkillCommand[] {
  let dirents;
  try {
    dirents = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const byName = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const skillPath = join(skillsDir, dirent.name, "SKILL.md");
      if (!existsSync(skillPath)) return null;
      const frontmatter = splitFrontmatter(readFileSync(skillPath, "utf8")).fields;
      if (!frontmatter.name) return null;
      return { name: frontmatter.name, description: frontmatter.description ?? "" };
    })
    .filter((cmd): cmd is SkillCommand => cmd !== null)
    .reduce((map, cmd) => {
      if (!map.has(cmd.name)) map.set(cmd.name, cmd);
      return map;
    }, new Map<string, SkillCommand>());
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills whose slash name is owned by an extension command that does more than
 * forward the skill body. The skill stays reachable as /skill:<name>.
 */
export const SHADOWED_SKILL_NAMES = ["setup-pstack"];

interface SkillChromeUiContext {
  readonly ui?: {
    setStatus: (key: string, value: string | undefined) => void;
    theme?: { fg?: (token: string, text: string) => string };
  };
}

/** Render declared chrome on the host status line; a partial or headless UI is a no-op. */
function renderSkillChrome(
  ctx: SkillChromeUiContext | undefined,
  chrome: SkillChrome | undefined,
  name: string,
): void {
  if (!ctx?.ui || typeof ctx.ui.setStatus !== "function") return;
  if (!chrome) {
    ctx.ui.setStatus("pstack-skill", undefined);
    return;
  }
  const label = chromeStatusLabel(chrome, name);
  const token = chromeThemeToken(chrome.color);
  const value = token && typeof ctx.ui.theme?.fg === "function" ? ctx.ui.theme.fg(token, label) : label;
  ctx.ui.setStatus("pstack-skill", value);
}

/**
 * Registers `/name` for every skill not in `reserved`, forwarding trimmed user args into
 * `/skill:name <args>` so Pi's native skill loader expands it (not the removed prompt
 * templates, whose single-pass substitution dropped both args and the skill wrap).
 */
export function registerSkillCommands(
  pi: ExtensionAPI,
  opts: { skillsDir?: string; reserved?: Iterable<string>; shadowed?: Iterable<string> } = {},
): void {
  const skillsDir = opts.skillsDir ?? DEFAULT_SKILLS_DIR;
  const reserved = new Set(opts.reserved ?? RESERVED_COMMAND_NAMES);
  const shadowed = new Set(opts.shadowed ?? SHADOWED_SKILL_NAMES);
  for (const skill of readSkillCommands(opts.skillsDir)) {
    if (reserved.has(skill.name) || shadowed.has(skill.name)) continue;
    pi.registerCommand(skill.name, {
      description: skill.description || `Invoke the ${skill.name} skill`,
      handler: async (args, ctx) => {
        renderSkillChrome(ctx, readSkillChrome(join(skillsDir, skill.name, "SKILL.md")), skill.name);
        const trimmed = args.trim();
        const msg = trimmed ? `/skill:${skill.name} ${trimmed}` : `/skill:${skill.name}`;
        pi.sendUserMessage(msg, { expandPromptTemplates: true, deliverAs: "followUp" });
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
        pi.sendUserMessage(msg, { expandPromptTemplates: true, deliverAs: "followUp" });
      },
    });
  }
}
