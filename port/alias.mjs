#!/usr/bin/env node
/**
 * Alias-surface check: every upstream skill (minus the five names the extension
 * registers itself) must resolve to a Pi `/name` command that forwards its args,
 * no name is claimed twice, no leftover `prompts/*.md` shadows a registered name,
 * and the five reserved names are still registered somewhere in extensions/.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

// Commands may be registered by any module in the extension, not only the root.
function readExtensionSources(dir) {
  let sources = "";
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources += readExtensionSources(path);
    else if (extname(name) === ".ts") sources += readFileSync(path, "utf8");
  }
  return sources;
}

const mod = await import(pathToFileURL(resolve(ROOT, "extensions/commands/skill-commands.ts")).href);
const { RESERVED_COMMAND_NAMES, PI_ONLY_COMMANDS, readSkillCommands } = mod;
const reserved = new Set(RESERVED_COMMAND_NAMES);

const indexSrc = readFileSync(join(ROOT, "extensions/index.ts"), "utf8");
const extensionSrc = readExtensionSources(join(ROOT, "extensions"));
const skillCommandsSrc = readFileSync(join(ROOT, "extensions/commands/skill-commands.ts"), "utf8");

/**
 * Extracts a top-level function body (brace-balanced) by its declaration prefix. Skips
 * the parameter list via paren-depth tracking first, since a param type like
 * `opts: { skillsDir?: string } = {}` has its own braces before the body's opening brace.
 */
function extractFunctionBody(src, declPrefix) {
  const start = src.indexOf(declPrefix);
  if (start === -1) return null;
  const parenStart = src.indexOf("(", start);
  if (parenStart === -1) return null;
  let parenDepth = 0;
  let afterParams = -1;
  for (let i = parenStart; i < src.length; i++) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        afterParams = i + 1;
        break;
      }
    }
  }
  if (afterParams === -1) return null;
  const bodyOpen = src.indexOf("{", afterParams);
  if (bodyOpen === -1) return null;
  let braceDepth = 0;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === "{") braceDepth++;
    else if (src[i] === "}") {
      braceDepth--;
      if (braceDepth === 0) return src.slice(bodyOpen, i + 1);
    }
  }
  return null;
}

// --- every skill (minus reserved) has a registered command ---
const skills = readSkillCommands();
const skillNames = skills.map((s) => s.name).filter((n) => !reserved.has(n));
if (!indexSrc.includes("registerSkillCommands(pi)")) {
  problems.push("extensions/index.ts does not call registerSkillCommands(pi)");
}
if (!indexSrc.includes("registerPiOnlyCommands(pi)")) {
  problems.push("extensions/index.ts does not call registerPiOnlyCommands(pi)");
}

// --- no name claimed twice across skills / reserved / Pi-only buckets ---
const claims = new Map(); // name -> [source, ...]
const claim = (name, source) => {
  if (!claims.has(name)) claims.set(name, []);
  claims.get(name).push(source);
};
for (const name of skillNames) claim(name, "skill");
for (const name of reserved) claim(name, "reserved");
for (const cmd of PI_ONLY_COMMANDS) claim(cmd.name, "pi-only");
for (const [name, sources] of claims) {
  if (sources.length > 1) problems.push(`name claimed twice: ${name} (${sources.join(", ")})`);
}

// --- reserved names registered anywhere in the extension ---
for (const name of reserved) {
  if (!extensionSrc.includes(`registerCommand("${name}"`)) {
    problems.push(`reserved name missing from extension registrations: ${name}`);
  }
}

// --- no leftover prompts/*.md shadows a registered command name ---
const promptsDir = join(ROOT, "prompts");
const registeredNames = new Set([...skillNames, ...reserved, ...PI_ONLY_COMMANDS.map((c) => c.name)]);
if (existsSync(promptsDir)) {
  for (const file of readdirSync(promptsDir)) {
    if (extname(file) !== ".md") continue;
    const name = file.slice(0, -3);
    if (registeredNames.has(name)) problems.push(`prompts/${file} shadows registered command /${name}`);
  }
}

// --- registered skill / Pi-only command handlers forward args ---
const skillBody = extractFunctionBody(skillCommandsSrc, "export function registerSkillCommands");
if (!skillBody) {
  problems.push("registerSkillCommands body not found in skill-commands.ts");
} else if (!/args\.trim\(\)/.test(skillBody) || !/sendUserMessage/.test(skillBody) || !/\$\{trimmed\}/.test(skillBody)) {
  problems.push("registerSkillCommands handler does not forward trimmed args into the outgoing message");
}
const piOnlyBody = extractFunctionBody(skillCommandsSrc, "export function registerPiOnlyCommands");
if (!piOnlyBody) {
  problems.push("registerPiOnlyCommands body not found in skill-commands.ts");
} else if (!/args\.trim\(\)/.test(piOnlyBody) || !/sendUserMessage/.test(piOnlyBody) || !/\$\{trimmed\}/.test(piOnlyBody)) {
  problems.push("registerPiOnlyCommands handler does not forward trimmed args into the outgoing message");
}

for (const p of problems) console.log(`ALIAS FAIL  ${p}`);
console.log(
  `${skillNames.length} skill commands, ${reserved.size} reserved, ${PI_ONLY_COMMANDS.length} pi-only; ${problems.length} problem(s)`,
);
if (problems.length) process.exitCode = 1;
