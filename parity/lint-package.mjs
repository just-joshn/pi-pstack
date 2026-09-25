#!/usr/bin/env node
// Lints what `npm pack` ships: portable paths, a valid manifest, and valid skills. Exit 1 with one line per finding.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT = /\.(md|ts|mjs|js|json|sh|py|txt|tsv|ya?ml)$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ABSOLUTE_HOME = /(?:\/Users\/(?!you\/|<)[A-Za-z0-9._-]+\/|\/home\/(?!user\/|<)[A-Za-z0-9._-]+\/)/;
const BARE_AGENT_DIR = /\$PI_CODING_AGENT_DIR\//;
const HOMEDIR_AGENT = /homedir\(\)[^;\n]{0,120}\.pi["'`/\s,]+agent/;

export function packFiles(root) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out)[0].files.map((file) => file.path);
}

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!match) return undefined;
  const fields = {};
  let key;
  for (const line of match[1].split("\n")) {
    const pair = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (pair) {
      key = pair[1];
      fields[key] = pair[2].replace(/^["']|["']$/g, "");
    } else if (key && /^\s+\S/.test(line) && fields[key] !== undefined && /^[>|]-?$/.test(fields[key].trim() || ">")) {
      fields[key] = `${fields[key].replace(/^[>|]-?$/, "")} ${line.trim()}`.trim();
    }
  }
  return fields;
}

export function lintPackage(root, shipped = packFiles(root)) {
  const findings = [];
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const skillNames = readdirSync(join(root, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const packageSkillRef = new RegExp(`~/\\.pi/agent/skills/(?:${skillNames.join("|")})(?:/|\\b)`);
  const packageFileRef = /~\/\.pi\/agent\/(?:extensions\/(?!pstack-agents\.json)[A-Za-z0-9._-]+|agents\/[A-Za-z0-9._-]+)/;

  for (const entry of manifest.pi?.extensions ?? []) if (!existsSync(join(root, entry))) findings.push(`package.json: pi.extensions entry ${entry} does not exist`);
  for (const entry of manifest.pi?.skills ?? []) if (!existsSync(join(root, entry))) findings.push(`package.json: pi.skills entry ${entry} does not exist`);
  if (!manifest.keywords?.includes("pi-package")) findings.push("package.json: keywords must include pi-package");

  for (const file of shipped) {
    // Upstream skills ship their script tests; extension tests and dev tooling do not ship.
    if (/^extensions\/.*\.test\.ts$|(^|\/)node_modules\/|^parity\//.test(file)) findings.push(`${file}: must not ship (extension test, node_modules, or parity tooling)`);
    if (!TEXT.test(file)) continue;
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const at = `${file}:${index + 1}`;
      if (line.includes("<pstack>")) findings.push(`${at}: unresolved <pstack> token`);
      if (ABSOLUTE_HOME.test(line)) findings.push(`${at}: absolute home path`);
      if (file.startsWith("skills/") && /~\/\.pi\/agent\//.test(line)) findings.push(`${at}: agent-dir path ignores PI_CODING_AGENT_DIR; use \${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/`);
      if (BARE_AGENT_DIR.test(line)) findings.push(`${at}: bare $PI_CODING_AGENT_DIR/ (unset by default); use \${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/`);
      if (packageSkillRef.test(line)) findings.push(`${at}: package skill referenced at a user install path; use a skill-relative path or the skill name`);
      if (packageFileRef.test(line)) findings.push(`${at}: package extension or agent referenced at a user install path`);
      if (file.startsWith("extensions/") && HOMEDIR_AGENT.test(line)) findings.push(`${at}: homedir() joined with .pi/agent; use getAgentDir()`);
    });
  }

  for (const name of skillNames) {
    const file = join(root, "skills", name, "SKILL.md");
    if (!existsSync(file)) { findings.push(`skills/${name}: missing SKILL.md`); continue; }
    const fields = frontmatter(readFileSync(file, "utf8"));
    if (!fields) { findings.push(`skills/${name}/SKILL.md: missing frontmatter`); continue; }
    if (fields.name !== name) findings.push(`skills/${name}/SKILL.md: name ${fields.name} does not match its directory`);
    if (!SKILL_NAME.test(name) || name.length > 64) findings.push(`skills/${name}: invalid skill name`);
    if (!fields.description) findings.push(`skills/${name}/SKILL.md: missing description`);
    else if (fields.description.length > 1024) findings.push(`skills/${name}/SKILL.md: description longer than 1024 characters`);
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const findings = lintPackage(fileURLToPath(new URL("..", import.meta.url)));
  for (const finding of findings) console.error(finding);
  console.log(`package lint: ${findings.length} finding(s)`);
  process.exitCode = findings.length ? 1 : 0;
}
