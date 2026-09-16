/**
 * Skill frontmatter chrome: the icon, color, and reminder a SKILL.md declares.
 *
 * Pi's skill-name validator forces lowercase kebab names, so the chrome is read
 * from the file rather than derived from a display name. Callers render it
 * through the documented ctx.ui.setStatus surface with a theme.fg color token.
 */
import { existsSync, readFileSync } from "node:fs";

export interface SkillChrome {
  readonly icon?: string;
  readonly color?: string;
  readonly reminder?: string;
}

export interface Frontmatter {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Best-effort mapping of a declared color name onto a Pi theme token. The theme
 * exposes a fixed token set, not arbitrary color names.
 */
const COLOR_TOKEN: Readonly<Record<string, string>> = Object.freeze({
  yellow: "warning",
  gold: "warning",
  amber: "warning",
  orange: "warning",
  red: "error",
  crimson: "error",
  green: "success",
  blue: "accent",
  cyan: "accent",
  teal: "accent",
  purple: "accent",
  violet: "accent",
  magenta: "accent",
  gray: "muted",
  grey: "muted",
  dim: "dim",
});

function parseFoldedScalar(bodyLines: string[], startIndex: number): { value: string; nextIndex: number } {
  let parts: string[] = [];
  let i = startIndex;
  while (i < bodyLines.length && /^\s+\S/.test(bodyLines[i])) {
    parts = [...parts, bodyLines[i].trim()];
    i = i + 1;
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
 * Parses the scalar keys upstream skills use: plain, double-quoted with escaped
 * quotes, and `>-`/`|` folded block scalars.
 */
function parseFields(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const matched = /^([a-zA-Z0-9_-]+):\s?(.*)$/.exec(lines[i]);
    if (!matched) {
      i = i + 1;
      continue;
    }
    const key = matched[1];
    const rest = matched[2].trim();
    if (rest === ">-" || rest === ">" || rest === "|-" || rest === "|") {
      const folded = parseFoldedScalar(lines, i + 1);
      out[key] = folded.value;
      i = folded.nextIndex;
      continue;
    }
    out[key] = unquote(rest);
    i = i + 1;
  }
  return out;
}

/** Split a SKILL.md into its frontmatter fields and markdown body. */
export function splitFrontmatter(raw: string): Frontmatter {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    return Object.freeze({ fields: Object.freeze({}), body: raw.trim() });
  }
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing === -1) {
    return Object.freeze({ fields: Object.freeze({}), body: raw.trim() });
  }
  const fields = parseFields(lines.slice(1, closing + 1));
  const body = lines.slice(closing + 2).join("\n").replace(/^\r?\n/, "").trim();
  return Object.freeze({ fields: Object.freeze(fields), body });
}

/** The declared chrome keys, trimmed; absent keys are undefined. */
export function chromeFromFields(fields: Readonly<Record<string, string>>): SkillChrome {
  const pick = (key: "icon" | "color" | "reminder"): string | undefined => {
    const value = fields[key]?.trim();
    return value ? value : undefined;
  };
  return Object.freeze({ icon: pick("icon"), color: pick("color"), reminder: pick("reminder") });
}

export function parseSkillChrome(raw: string): SkillChrome {
  return chromeFromFields(splitFrontmatter(raw).fields);
}

export function readSkillChrome(skillPath: string): SkillChrome | undefined {
  if (!existsSync(skillPath)) return undefined;
  return parseSkillChrome(readFileSync(skillPath, "utf8"));
}

export function chromeStatusLabel(chrome: SkillChrome, name?: string): string {
  const icon = chrome.icon ?? "";
  const label = name ? `${icon} ${name}`.trim() : icon;
  return label || name || "skill";
}

/** The Pi theme token for a declared color name, or undefined when unmapped. */
export function chromeThemeToken(color: string | undefined): string | undefined {
  return color ? COLOR_TOKEN[color.toLowerCase()] : undefined;
}
