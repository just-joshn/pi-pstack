#!/usr/bin/env node
// One-shot migration: copy the live loose-file port from ~/.pi/agent into this package and rewrite
// install-location paths. Rerunnable; every rewrite asserts its expected match count.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = join(homedir(), ".pi/agent");
const RUNTIME_SRC = join(LIVE, "pstack/pstack-agents/extensions/pstack-agents");
const UPSTREAM_SRC = join(LIVE, "pstack/parity/upstream/0.15.5");

export const PI_ADDED_SKILLS = ["control-cli", "control-ui", "create-skill", "deslop", "goal", "loop", "skill-design-principles"];
const upstreamSkills = readdirSync(join(UPSTREAM_SRC, "pstack/skills"));
export const PACKAGE_SKILLS = [...upstreamSkills, ...PI_ADDED_SKILLS].sort();
const EXTENSION_FILES = ["pstack-guards.ts", "pstack-mode.ts", "questionnaire.ts", "todo.ts"];
const LEGACY = ["extensions/subagent", "extensions/pstack-slash.ts", "agents/reviewer.md", "agents/worker.md", "tests", "state", "vitest.config.ts", "PARITY.md", "AGENTS.md"];
const skip = (src) => !/(^|\/)(node_modules|\.DS_Store)(\/|$)/.test(src);

for (const path of [...LEGACY, "skills", "agents", "extensions", "parity/upstream", "parity/probes"]) rmSync(join(REPO, path), { recursive: true, force: true });

for (const skill of PACKAGE_SKILLS) cpSync(join(LIVE, "skills", skill), join(REPO, "skills", skill), { recursive: true, filter: skip });
for (const file of EXTENSION_FILES) cpSync(join(LIVE, "extensions", file), join(REPO, "extensions", file));
cpSync(RUNTIME_SRC, join(REPO, "extensions/pstack-agents"), { recursive: true, filter: (src) => skip(src) && !src.endsWith("package.json") });
cpSync(join(LIVE, "agents"), join(REPO, "agents"), { recursive: true, filter: skip });
cpSync(UPSTREAM_SRC, join(REPO, "parity/upstream/0.15.5"), { recursive: true, filter: skip });
cpSync(join(LIVE, "pstack/parity/round3-probes"), join(REPO, "parity/probes"), { recursive: true, filter: skip });
for (const file of ["check-parity.mjs", "full-audit.mjs", "sync-check.mjs", "pi-additions.tsv", "decisions.tsv", "fixes-round2.tsv", "round3-decisions.tsv"]) {
  cpSync(join(LIVE, "pstack/parity", file), join(REPO, "parity", file));
}
for (const dir of ["docs", "automations", "assets"]) {
  rmSync(join(REPO, dir), { recursive: true, force: true });
  cpSync(join(UPSTREAM_SRC, "pstack", dir), join(REPO, dir), { recursive: true, filter: skip });
}
cpSync(join(UPSTREAM_SRC, "pstack/LICENSE"), join(REPO, "LICENSE"));

// [file relative to REPO, old, new, expected count]
const S = "<pstack>";
const REWRITES = [
  ["skills/poteto-mode/SKILL.md", "The `pstack-mode` extension (`~/.pi/agent/extensions/pstack-mode.ts`)", `The \`pstack-mode\` extension (\`${S}/extensions/pstack-mode.ts\`)`, 1],
  ["skills/poteto-mode/SKILL.md", "so read the skill's text under `~/.pi/agent/skills/<name>/`", "so read the skill's text in the directory Pi loaded it from", 1],
  ["skills/poteto-mode/SKILL.md", "which is `~/.pi/agent/skills/principle-<slug>/SKILL.md`", `which is \`${S}/skills/principle-<slug>/SKILL.md\``, 1],
  ["skills/poteto-mode/references/pi-runtime.md", "the `pstack-agents` extension at `~/.pi/agent/extensions/pstack-agents/`.", `the \`pstack-agents\` extension at \`${S}/extensions/pstack-agents/\`. \`${S}\` is the pi-pstack package root, the directory two levels above this skill's \`SKILL.md\`.`, 1],
  ["skills/poteto-mode/references/pi-runtime.md", "(`~/.pi/agent/extensions/questionnaire.ts`)", `(\`${S}/extensions/questionnaire.ts\`)`, 1],
  ["skills/poteto-mode/references/pi-runtime.md", "(`~/.pi/agent/extensions/todo.ts`)", `(\`${S}/extensions/todo.ts\`)`, 1],
  ["skills/poteto-mode/references/pi-runtime.md", "| `~/.cursor/skills/<name>/` | `~/.pi/agent/skills/<name>/`. |", `| \`~/.cursor/skills/<name>/\` | \`~/.pi/agent/skills/<name>/\`. pstack's own skills live in \`${S}/skills/<name>/\`. |`, 1],
  ["skills/poteto-mode/references/pi-runtime.md", "(`~/.pi/agent/extensions/pstack-mode.ts`)", `(\`${S}/extensions/pstack-mode.ts\`)`, 1],
  ["skills/poteto-mode/references/pi-runtime.md", "Resolve paths relative to `~/.pi/agent/skills/poteto-mode/`.", `Resolve paths relative to \`${S}/skills/poteto-mode/\`.`, 1],
  ["skills/poteto-mode/references/pi-runtime.md", "Edit the installed copy under `~/.pi/agent/skills/`;", "Edit the installed copy at the path Pi loaded it from;", 1],
  ["skills/poteto-mode/playbooks/autopilot-full.md", "`~/.pi/agent/skills/poteto-mode/", `\`${S}/skills/poteto-mode/`, 1],
  ["skills/poteto-mode/playbooks/autopilot-stack.md", "`~/.pi/agent/skills/poteto-mode/", `\`${S}/skills/poteto-mode/`, 1],
  ["skills/poteto-mode/playbooks/babysit.md", "`~/.pi/agent/skills/poteto-mode/", `\`${S}/skills/poteto-mode/`, 1],
  ["skills/poteto-mode/playbooks/multi-phase-plan.md", "~/.pi/agent/skills/", `${S}/skills/`, 8],
  ["skills/setup-pstack/SKILL.md", "read `~/.pi/agent/skills/poteto-mode/SKILL.md` in full", `read \`${S}/skills/poteto-mode/SKILL.md\` in full`, 1],
  ["skills/setup-pstack/SKILL.md", "Write it with a small script rather than by hand", `Replace \`${S}\` with the absolute pi-pstack package root, two directories above this skill's \`SKILL.md\`. Write it with a small script rather than by hand`, 1],
  ["skills/setup-pstack/SKILL.md", "In `~/.pi/agent/settings.json`, set `subagents.modelScope` to", "In `~/.pi/agent/extensions/pstack-agents.json`, set `modelScope` to", 1],
  ["agents/poteto-agent.md", "/Users/josh-desktop/.pi/agent/skills/", `${S}/skills/`, 3],
];

for (const [file, from, to, count] of REWRITES) {
  const path = join(REPO, file);
  const text = readFileSync(path, "utf8");
  const found = text.split(from).length - 1;
  if (found !== count) throw new Error(`${file}: expected ${count} of ${JSON.stringify(from)}, found ${found}`);
  writeFileSync(path, text.split(from).join(to));
}

mkdirSync(join(REPO, "parity"), { recursive: true });
symlinkSync("0.15.5", join(REPO, "parity/upstream/current"));
console.log(`copied ${PACKAGE_SKILLS.length} skills, ${EXTENSION_FILES.length + 1} extensions, ${readdirSync(join(REPO, "agents")).length} agents; ${REWRITES.length} rewrites applied`);
console.log(relative(process.cwd(), REPO) || ".");
