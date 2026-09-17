/**
 * Pi skills-documentation conformance for every SKILL.md the package ships.
 *
 * Pi's loader stays lenient and never checks that skill files resolve each
 * other, so these assertions hold the tree to the documented contract:
 * frontmatter limits, name/directory parity, the progressive-disclosure size
 * budget, and references that resolve from the skill directory the system
 * prompt names.
 */
import { expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { repoRoot } from "../support/repo-root.mjs";

const ROOT = repoRoot(import.meta.url);
const SKILL_ROOTS = ["skills", "automations/benny/skills"];
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;
const MAX_SKILL_LINES = 500;
const NAME_PATTERN = /^[a-z0-9-]+$/;
const SKIPPED_DIRS = new Set(["node_modules", ".git"]);
const EXTERNAL_PATTERN = /^(?:https?:|mailto:|#)/;
const GLOB_PATTERN = /[*<>]/;
const ABSOLUTE_PATH_PATTERN = /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g;
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+?)(?:\s+"[^"]*")?\)/g;
const CODE_PATH_PATTERN = /`((?:references|scripts|playbooks|assets|sources)\/[^`\s]+)`/g;

const { parseFrontmatter } = await import(
  pathToFileURL(join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js")).href
);

function listFiles(dir, match) {
  return readdirSync(dir, { withFileTypes: true }).reduce((files, entry) => {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) return files;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return files.concat(listFiles(full, match));
    return match(entry.name) ? files.concat([full]) : files;
  }, []);
}

const skillFiles = SKILL_ROOTS.flatMap((root) => listFiles(join(ROOT, root), (name) => name === "SKILL.md")).toSorted();
const markdownFiles = SKILL_ROOTS.flatMap((root) => listFiles(join(ROOT, root), (name) => name.endsWith(".md"))).toSorted();

function label(file) {
  return file.slice(ROOT.length + 1);
}

function frontmatter(file) {
  return parseFrontmatter(readFileSync(file, "utf8")).frontmatter;
}

/** The skill directory: the nearest ancestor holding the SKILL.md file. */
function skillRoot(file) {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, "SKILL.md"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(file);
    dir = parent;
  }
}

function nameViolations(name) {
  if (typeof name !== "string" || name.trim() === "") return ["name is missing or empty"];
  return [
    name.length > MAX_NAME_LENGTH ? `name exceeds ${MAX_NAME_LENGTH} characters` : null,
    NAME_PATTERN.test(name) ? null : "name contains characters outside a-z, 0-9, and hyphen",
    name.startsWith("-") || name.endsWith("-") ? "name starts or ends with a hyphen" : null,
    name.includes("--") ? "name contains consecutive hyphens" : null,
  ].filter(Boolean);
}

function descriptionViolations(description) {
  if (typeof description !== "string" || description.trim() === "") return ["description is missing or empty"];
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
  }
  return [];
}

function isStringMap(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function optionalFieldViolations(frontmatterFields) {
  const { compatibility, metadata } = frontmatterFields;
  const allowedTools = frontmatterFields["allowed-tools"];
  const disableInvocation = frontmatterFields["disable-model-invocation"];
  return [
    compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > MAX_COMPATIBILITY_LENGTH)
      ? `compatibility is not a string of ${MAX_COMPATIBILITY_LENGTH} characters or fewer`
      : null,
    allowedTools !== undefined && typeof allowedTools !== "string" ? "allowed-tools is not a space-delimited string" : null,
    disableInvocation !== undefined && typeof disableInvocation !== "boolean"
      ? "disable-model-invocation is not a boolean"
      : null,
    metadata !== undefined && !isStringMap(metadata) ? "metadata is not a map of string values" : null,
  ].filter(Boolean);
}

function frontmatterViolations(file) {
  const fields = frontmatter(file);
  const directory = basename(dirname(file));
  return [
    ...nameViolations(fields.name).map((problem) => `${label(file)}: ${problem}`),
    ...descriptionViolations(fields.description).map((problem) => `${label(file)}: ${problem}`),
    ...optionalFieldViolations(fields).map((problem) => `${label(file)}: ${problem}`),
    fields.name === directory ? null : `${label(file)}: name "${fields.name}" does not match directory "${directory}"`,
  ].filter(Boolean);
}

function referencesIn(text) {
  const links = [...text.matchAll(LINK_PATTERN)].map((match) => match[1]);
  const paths = [...text.matchAll(CODE_PATH_PATTERN)].map((match) => match[1]);
  return links.concat(paths).filter((target) => !EXTERNAL_PATTERN.test(target));
}

function unresolvedReferences(file) {
  const root = skillRoot(file);
  return referencesIn(readFileSync(file, "utf8"))
    // `url`-style placeholders in prompt templates are not paths and never resolve.
    .map((target) => ({ target, clean: target.split("#")[0].replace(/[.,;:]$/, "") }))
    .filter(({ clean }) => clean !== "" && !GLOB_PATTERN.test(clean) && /[./]/.test(clean))
    .filter(({ clean }) => !existsSync(resolve(root, clean)))
    .map(({ target }) => `${label(file)}: ${target}`);
}

function absolutePaths(file) {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(ABSOLUTE_PATH_PATTERN)].map((match) => `${label(file)}: ${match[0]}`);
}

test("every shipped skill loads under the Pi loader with no diagnostics", () => {
  const result = loadSkills({
    cwd: ROOT,
    agentDir: join(ROOT, ".pi", "agent"),
    skillPaths: SKILL_ROOTS.map((root) => join(ROOT, root)),
    includeDefaults: false,
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.skills.length).toBe(skillFiles.length);
  const names = result.skills.map((skill) => skill.name);
  expect([...new Set(names)].length).toBe(names.length);
});

test("every skill frontmatter matches the documented field rules", () => {
  expect(skillFiles.flatMap(frontmatterViolations)).toEqual([]);
});

test("every SKILL.md stays under the 500-line progressive-disclosure budget", () => {
  const overBudget = skillFiles
    .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }))
    .filter(({ lines }) => lines > MAX_SKILL_LINES)
    .map(({ file, lines }) => `${label(file)}: ${lines} lines`);
  expect(overBudget).toEqual([]);
});

test("every relative reference resolves from the skill root", () => {
  expect(markdownFiles.flatMap(unresolvedReferences)).toEqual([]);
});

test("no skill file hardcodes an absolute local path", () => {
  expect(markdownFiles.flatMap(absolutePaths)).toEqual([]);
});
