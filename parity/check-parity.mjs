#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { agentMentions, COVERAGE_FLOOR } from "./sync-check.mjs";

const HOME = homedir();
const PI = join(HOME, ".pi/agent");
const PI_SKILLS = join(PI, "skills");
const PI_AGENTS = join(PI, "agents");
// Upstream is the vendored snapshot of the current official plugin (cursor/plugins), not the local Cursor cache,
// which can lag. Refresh it with a new upstream/<version>/ dir, then point upstream/current at it and run sync-check.mjs.
const UPSTREAM = join(PI, "pstack/parity/upstream/current");
const CURSOR = join(UPSTREAM, "pstack");
const TEAM_KIT = join(UPSTREAM, "cursor-team-kit/skills");

const problems = [];
const ACCEPTED = new Map([
	["skills/make-bot-ui/SKILL.md", "cloud webhook routine replaced by a local Pi bot session (cloud to local)"],
	["skills/setup-pstack/SKILL.md", "Cursor rule file replaced by the AGENTS.md pstack block"],
	["skills/control-cli/SKILL.md", "Parallel Lanes replaces one cloud VM per lane with isolated local lanes"],
	["skills/control-ui/SKILL.md", "Parallel Lanes replaces one cloud VM per lane with isolated local lanes"],
]);
const WHOLE_FILE_REWRITES = new Set(["skills/make-bot-ui/SKILL.md", "skills/setup-pstack/SKILL.md"]);
const FRONTMATTER_EXCEPTIONS = new Map([
	["skills/make-bot-ui/SKILL.md:description", "local Pi bot replaces the cloud webhook routine (round3-decisions.tsv#Q15)"],
	["skills/setup-pstack/SKILL.md:description", "Pi model block replaces Cursor rules (pi-runtime.md:104-117; fixes-round2.tsv#U3)"],
	["skills/typescript-best-practices/SKILL.md:description", "Pi best-practices entry is intentionally model-invocable (pi-runtime.md:15)"],
	["skills/typescript-best-practices/SKILL.md:disable-model-invocation", "retained local model-invocation exception"],
	["agents/poteto-agent.md:description", "Pi routes through the named poteto agent (decisions.tsv#12; pi-runtime.md:25-26)"],
]);
const STEP_ALIASES = new Map([["skills/no-comments/SKILL.md", new Map([["spawn", "snapshot"]])]]);
const AGENT_ROLE_ADDITIONS = new Map([
	["skills/arena/SKILL.md", ["pstack-general", "pstack-reader", "poteto-agent"]],
	["skills/automate-me/SKILL.md", ["pstack-general"]],
	["skills/maintain-verification-skill/SKILL.md", ["pstack-reader"]],
	["skills/poteto-mode/playbooks/autopilot-full.md", ["poteto-agent"]],
	["skills/poteto-mode/playbooks/autopilot-stack.md", ["poteto-agent"]],
	["skills/poteto-mode/playbooks/shipping.md", ["poteto-agent"]],
	["skills/poteto-mode/playbooks/worktree-cleanup.md", ["pstack-reader"]],
	["skills/recall/SKILL.md", ["pstack-general"]],
	["skills/show-me-your-work/SKILL.md", ["pstack-reader"]],
]);
const problem = (file, msg) => {
	const key = relative(PI, file);
	if (ACCEPTED.has(key) && /^(headings|numbered steps)/.test(msg)) return accepted.push(`${key}: ${msg} [accepted: ${ACCEPTED.get(key)}]`);
	problems.push(`${relative(HOME, file)}: ${msg}`);
};
const accepted = [];

function walk(dir) {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = join(dir, e.name);
		if (e.name === ".DS_Store" || e.name === "node_modules" || e.name === ".omc") return [];
		return e.isDirectory() ? walk(p) : [p];
	});
}

function frontmatter(text) {
	const m = text.match(/^---\n([\s\S]*?)\n---/);
	return m ? m[1] : "";
}

function frontmatterFields(text) {
	const lines = frontmatter(text).split("\n");
	const fields = new Map();
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if ([">", ">-", ">+", "|", "|-", "|+"].includes(value)) {
			const parts = [];
			while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) parts.push(lines[++i].trim());
			value = parts.join(" ");
		} else if ((value.startsWith("\"") && !value.endsWith("\"")) || (value.startsWith("'") && !value.endsWith("'"))) {
			while (i + 1 < lines.length && !value.endsWith(value[0])) value += ` ${lines[++i].trim()}`;
		}
		if (value.startsWith("\"") && value.endsWith("\"")) {
			try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
		} else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
		fields.set(match[1], value.trim());
	}
	return fields;
}

function canonicalField(field, value) {
	if (value === undefined) return undefined;
	if (field === "name") return value.toLowerCase().trim().replace(/[ _]+/g, "-");
	if (field === "description") return value.replace(/\/skill:/g, "/").replace(/\s+/g, " ").trim();
	if (["disable-model-invocation", "is_background", "async"].includes(field)) return /^(?:true|yes)$/i.test(value);
	if (field === "tools") return value.replace(/[\[\]']/g, "").split(/[\s,]+/).filter(Boolean).sort().join(",");
	return value.trim();
}

function headings(text) {
	const body = text.replace(/^---\n[\s\S]*?\n---/, "").replace(/````[\s\S]*?````/g, "").replace(/```[\s\S]*?```/g, "");
	return body.split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/\/skill:/g, "/").trim());
}

function numberedSteps(text) {
	const body = text.replace(/^---\n[\s\S]*?\n---/, "").replace(/````[\s\S]*?````/g, "").replace(/```[\s\S]*?```/g, "");
	return body.split("\n").filter((l) => /^\s*\d+\.\s+/.test(l)).length;
}

function stepFirstWords(text) {
	const body = text.replace(/^---\n[\s\S]*?\n---/, "").replace(/````[\s\S]*?````/g, "").replace(/```[\s\S]*?```/g, "");
	return body.split("\n").flatMap((line) => {
		const step = line.match(/^\s*\d+\.\s+(.*)$/)?.[1];
		if (!step) return [];
		const word = step.replace(/^\*\*?/, "").replace(/[*_`]/g, "").trim().match(/^[\p{L}\p{N}-]+/u)?.[0];
		return word ? [word.toLowerCase()] : [];
	});
}

function compareFrontmatter(upstream, port, rel) {
	const a = frontmatterFields(upstream);
	const b = frontmatterFields(port);
	for (const field of ["name", "description", "disable-model-invocation"]) {
		const av = canonicalField(field, a.get(field));
		const bv = canonicalField(field, b.get(field));
		if (av === bv || FRONTMATTER_EXCEPTIONS.has(`${rel}:${field}`)) continue;
		problem(join(PI, rel), `${field} ${JSON.stringify(bv)}, upstream ${JSON.stringify(av)}`);
	}
	if (rel.startsWith("agents/")) {
		const sourceTools = canonicalField("tools", a.get("tools")) ?? "";
		const portTools = canonicalField("tools", b.get("tools")) ?? "";
		if (sourceTools !== portTools) problem(join(PI, rel), `tools ${JSON.stringify(portTools)}, upstream tools ${JSON.stringify(sourceTools)}`);
	}
}

function compareAgentSets(upstream, port, rel) {
	const expected = new Set(agentMentions(upstream).map((entry) => entry.normalized));
	for (const extra of AGENT_ROLE_ADDITIONS.get(rel) ?? []) expected.add(extra);
	const actual = new Set(agentMentions(port).map((entry) => entry.normalized));
	if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
		problem(join(PI, rel), `agent-name set [${[...actual].sort().join(", ")}], upstream mapping expects [${[...expected].sort().join(", ")}]`);
	}
}

function checkPair(upstream, port) {
	if (!existsSync(port)) return problem(port, `missing port of ${relative(HOME, upstream)}`);
	if (!upstream.endsWith(".md")) return;
	const a = readFileSync(upstream, "utf8");
	const b = readFileSync(port, "utf8");
	const rel = relative(PI, port);
	const ha = headings(a);
	const hb = headings(b);
	const missing = ha.filter((h) => !hb.includes(h));
	if (missing.length) problem(port, `headings dropped from upstream: ${missing.join(" | ")}`);
	const extra = hb.filter((h) => !ha.includes(h));
	if (extra.length) problem(port, `headings not in upstream: ${extra.join(" | ")}`);
	const na = numberedSteps(a);
	const nb = numberedSteps(b);
	if (na !== nb) problem(port, `numbered steps ${nb}, upstream has ${na}`);
	if (!WHOLE_FILE_REWRITES.has(rel)) {
		const aliases = STEP_ALIASES.get(rel) ?? new Map();
		const expected = stepFirstWords(a).map((word) => aliases.get(word) ?? word);
		const actual = stepFirstWords(b);
		if (expected.join("|") !== actual.join("|")) problem(port, `numbered step first-word order [${actual.join(", ")}], upstream maps to [${expected.join(", ")}]`);
	}
	compareFrontmatter(a, b, rel);
	compareAgentSets(a, b, rel);
}

for (const f of walk(join(CURSOR, "skills"))) checkPair(f, join(PI_SKILLS, relative(join(CURSOR, "skills"), f)));
for (const f of walk(join(CURSOR, "agents"))) checkPair(f, join(PI_AGENTS, relative(join(CURSOR, "agents"), f)));
for (const s of ["deslop", "control-cli", "control-ui"]) checkPair(join(TEAM_KIT, s, "SKILL.md"), join(PI_SKILLS, s, "SKILL.md"));
for (const s of ["loop", "goal"]) {
	if (!existsSync(join(PI_SKILLS, s, "SKILL.md"))) problem(join(PI_SKILLS, s), "missing port of Cursor built-in");
}
if (!existsSync(join(PI_SKILLS, "create-skill/SKILL.md"))) problem(join(PI_SKILLS, "create-skill"), "missing");

const MAPPING_FILE = join(PI_SKILLS, "poteto-mode/references/pi-runtime.md");
const CURSOR_ONLY = [
	[/~\/\.cursor\//, "Cursor home path"],
	[/cursor-team-kit/, "cursor-team-kit reference"],
	[/(^|[\s(`])\.cursor\/(skills|rules|automations)/, "Cursor project path"],
	[/agent-transcripts/, "Cursor transcript directory"],
	[/\bTodoWrite\b/, "Cursor TodoWrite tool"],
	[/\bAskQuestion\b/, "Cursor AskQuestion tool"],
	[/grok-4\.\d|gpt-5\.6-sol-max|\bclaude-[a-z0-9-]+-(max|xhigh|high|medium)\b/, "Cursor model slug"],
	[/notify_on_output|cursor-subscriptions/, "Cursor loop primitive"],
	[/Cursor dashboard|cloud-sleeper|cloud VM|Cursor cloud agent/, "Cursor cloud primitive"],
	[/Cursor's built-in/, "Cursor built-in reference"],
];
const PI_MAPPING_CONTEXT = /means what that file maps it to|local equivalent|migration source|ask the user \(`AskQuestion`\)|Pi's form|Pi equivalent|the Pi form|Pi port|\(Pi's `|per `\.\.\/poteto-mode\/references\/pi-runtime\.md`|per `\.\.\/references\/pi-runtime\.md`|Cursor's|Cursor built-in|is `allow_multiple|matches TodoWrite|TodoWrite.{0,3}in Cursor|Pi's `AskQuestion`|Pi's TodoWrite|mapped on Pi/;

const skillNames = readdirSync(PI_SKILLS).filter((d) => existsSync(join(PI_SKILLS, d, "SKILL.md")));
const agentNames = new Set(
	readdirSync(PI_AGENTS).map((f) => (readFileSync(join(PI_AGENTS, f), "utf8").match(/^name:\s*(.+)$/m) ?? [])[1]?.trim()),
);
for (const builtin of ["scout", "researcher", "evidence-auditor", "worker", "reviewer", "oracle", "advisor", "delegate"]) agentNames.add(builtin);

let models = new Set();
try {
	const out = execFileSync("pi", ["--list-models"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	models = new Set(out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 1).map((c) => `${c[0]}/${c[1]}`));
} catch {
	problem(PI, "pi --list-models failed; model ids unchecked");
}

const REMOVED_RUNTIME = [
	[/\bsubagent\s*\(/i, "removed subagent(...) tool syntax"],
	[/\bworkflowScript\b/i, "removed workflowScript runtime"],
	[/\bruns\.all\b/i, "removed runs.all runtime"],
	[/\bbg_wait\b/i, "removed bg_wait runtime"],
	[/\bschedule\.create\b/i, "removed schedule.create runtime"],
	[/\bmission\.create\b/i, "removed mission.create runtime"],
	[/\bpstack-shell\b/i, "removed pstack-shell runtime"],
	[/\bsubagents_enable\b/i, "removed subagents_enable runtime"],
];
const TASK_SCHEMA_FILE = join(PI, "extensions/pstack-agents/index.ts");
const TASK_SCHEMA = existsSync(TASK_SCHEMA_FILE)
	? readFileSync(TASK_SCHEMA_FILE, "utf8").match(/const TaskParameters = Type\.Union\(\[([\s\S]*?)^\]\);/m)?.[1]
	: undefined;
const TASK_ARGUMENTS = new Set(
	[...(TASK_SCHEMA?.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Type\./gm) ?? [])].map((match) => match[1]),
);
if (!TASK_ARGUMENTS.size) problem(TASK_SCHEMA_FILE, "could not read Task arguments from TypeBox TaskParameters schema");

const portFiles = [...walk(PI_SKILLS).filter((f) => f.endsWith(".md")), ...walk(PI_AGENTS)];
for (const file of portFiles) {
	const text = readFileSync(file, "utf8");
	for (const [pattern, label] of REMOVED_RUNTIME) {
		if (pattern.test(text)) problems.push(`${relative(HOME, file)}: ${label} remains`);
	}
	for (const match of text.matchAll(/\bTask\s*\(\s*\{([^{}]*)\}\s*\)/g)) {
		const line = text.slice(0, match.index).split("\n").length;
		const where = `${relative(HOME, file)}:${line}`;
		for (const part of match[1].split(",")) {
			const argument = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/)?.[1];
			if (argument && !TASK_ARGUMENTS.has(argument)) {
				problems.push(`${where}: unknown Task argument "${argument}" (not in pstack-agents TypeBox schema)`);
			}
		}
	}
	const lines = text.split("\n");
	lines.forEach((line, i) => {
		const where = `${relative(HOME, file)}:${i + 1}`;
		if (file !== MAPPING_FILE) {
			for (const [re, label] of CURSOR_ONLY) {
				if (!re.test(line)) continue;
				const isPath = label.endsWith("path");
				const rel = relative(PI, file);
				const migrationPath = rel === "skills/setup-pstack/SKILL.md" && line.includes("~/.cursor/rules/pstack-models.mdc") && /migration source/i.test(line);
				const managedTaskMapping = label === "Cursor cloud primitive" && /\bTask\b/.test(line) && /managed (?:local )?worktree/i.test(line);
				if ((isPath && !migrationPath) || (!isPath && !PI_MAPPING_CONTEXT.test(line) && !managedTaskMapping)) problems.push(`${where}: ${label} left unmapped`);
			}
		}
		for (const m of line.matchAll(/(?<![\w:/.-])\/([a-z][a-z0-9-]+)(?![\w/.-])/g)) {
			if (skillNames.includes(m[1]) && !["loop", "goal"].includes(m[1])) problems.push(`${where}: slash command /${m[1]} should be /skill:${m[1]}`);
		}
		for (const m of line.matchAll(/agent:\s*"([^"]+)"/g)) {
			if (!agentNames.has(m[1]) && !m[1].includes("<")) problems.push(`${where}: unknown agent "${m[1]}"`);
		}
		for (const mention of agentMentions(line)) {
			if (!agentNames.has(mention.normalized) && !agentNames.has(mention.name) && !mention.name.includes("<")) {
				problems.push(`${where}: unknown mapped agent "${mention.name}"`);
			}
		}
		for (const m of line.matchAll(/`((?:anthropic|openai-codex|deepseek)\/[a-z0-9.-]+)(?::[a-z]+)?`/g)) {
			if (models.size && !models.has(m[1])) problems.push(`${where}: model ${m[1]} not in pi --list-models`);
		}
		for (const m of line.matchAll(/`(\.\.\/[^`\s]+?\.(?:md|mjs|sh|ts))`/g)) {
			if (!m[1].includes("<") && !existsSync(resolve(dirname(file), m[1]))) problems.push(`${where}: broken path ${m[1]}`);
		}
	});
}

for (const script of ["scripts/check-plan.mjs", "scripts/worktree-audit.sh", "scripts/watch-pr/watch-pr", "scripts/orch/orch.ts"]) {
	if (!existsSync(join(PI_SKILLS, "poteto-mode", script))) problem(join(PI_SKILLS, "poteto-mode", script), "missing script");
}
for (const ext of ["todo.ts", "questionnaire.ts", "pstack-mode.ts", "pstack-guards.ts"]) {
	if (!existsSync(join(PI, "extensions", ext))) problem(join(PI, "extensions", ext), "missing pstack extension");
}
for (const ext of ["extensions/pstack-agents/index.ts", "extensions/pstack-agents/runner.mjs"]) {
	if (!existsSync(join(PI, ext))) problem(join(PI, ext), "missing pstack-agents runtime file");
}
const agentsMd = readFileSync(join(PI, "AGENTS.md"), "utf8");
if (!agentsMd.includes("<!-- pstack-models:begin -->")) problem(join(PI, "AGENTS.md"), "pstack models block missing");
if (!agentsMd.includes("Standing delegation authorization.")) problem(join(PI, "AGENTS.md"), "standing delegation authorization missing for playbooks that prescribe delegation");
if (!agentsMd.includes("skills/poteto-mode/SKILL.md")) problem(join(PI, "AGENTS.md"), "poteto-mode reminder must name the SKILL.md path; the model cannot run a slash command");

// Default models: every Cursor default slug in an upstream file must appear in the port as its Pi id.
const MODEL_MAP = new Map([
	["claude-opus-5-5-max", "anthropic/claude-opus-5-5:max"],
	["gpt-5.6-sol-max", "openai-codex/gpt-5.6-sol:max"],
	["grok-4.7-xhigh-fast", "anthropic/claude-sonnet-5:xhigh"],
	["claude-opus-5-5-medium", "anthropic/claude-opus-5-5:medium"],
	["grok-4.7-medium-fast", "anthropic/claude-sonnet-5:medium"],
]);
const count = (text, needle) => text.split(needle).length - 1;
for (const f of walk(join(CURSOR, "skills")).filter((f) => /\.(md|mjs)$/.test(f))) {
	const up = readFileSync(f, "utf8");
	const portFile = join(PI_SKILLS, relative(join(CURSOR, "skills"), f));
	if (!existsSync(portFile)) continue;
	const port = readFileSync(portFile, "utf8");
	for (const m of new Set(up.match(/\b(?:claude|gpt|grok)-[a-z0-9.-]+-(?:max|xhigh|high|medium|fast)\b/g) ?? [])) {
		const pi = MODEL_MAP.get(m);
		if (!pi) {
			problems.push(`${relative(HOME, f)}: upstream model ${m} has no Pi mapping in check-parity MODEL_MAP`);
			continue;
		}
		if (count(port, pi) < count(up, m)) problems.push(`${relative(HOME, portFile)}: ${pi} appears ${count(port, pi)}x, upstream ${m} ${count(up, m)}x`);
	}
	for (const stale of ["claude-fable-5-1:", "deepseek-v4-pro", "claude-opus-5-5:xhigh"]) {
		if (port.includes(stale)) problems.push(`${relative(HOME, portFile)}: stale pre-0.15.3 default ${stale}`);
	}
}
const usedAgentRoles = new Set(portFiles.flatMap((file) => agentMentions(readFileSync(file, "utf8")).map((entry) => entry.normalized)));
for (const role of ["pstack-general", "pstack-reader"]) {
	if (!usedAgentRoles.has(role)) continue;
	const definition = join(PI_AGENTS, `${role}.md`);
	if (!existsSync(definition)) {
		problems.push(`${relative(HOME, definition)}: missing mapped ${role} agent`);
		continue;
	}
	const fields = frontmatterFields(readFileSync(definition, "utf8"));
	const tools = canonicalField("tools", fields.get("tools")) ?? "";
	const expectedTools = role === "pstack-reader" ? "bash,find,grep,ls,read" : "";
	if (tools !== expectedTools) problems.push(`${relative(HOME, definition)}: tools ${JSON.stringify(tools)}, expected ${JSON.stringify(expectedTools)} for ${role}`);
}

const sync = (() => {
	try {
		execFileSync("node", [join(PI, "pstack/parity/sync-check.mjs")], { encoding: "utf8" });
		return "";
	} catch (e) {
		return String(e.stdout).trim().split("\n").pop();
	}
})();
if (sync) problems.push(`sync-check: ${sync}`);

const audit = spawnSync(process.execPath, [join(PI, "pstack/parity/full-audit.mjs"), "--check", `--floor=${COVERAGE_FLOOR}`], { encoding: "utf8" });
if (audit.status !== 0) {
	const output = String(audit.stdout ?? "").trim().split("\n").filter(Boolean);
	for (const line of output) problems.push(line.startsWith("full-audit:") ? line : `full-audit: ${line}`);
	if (!output.length) problems.push(`full-audit: exited ${audit.status ?? "without a status"}`);
}

if (process.argv.includes("--verbose") && accepted.length) console.log(accepted.join("\n") + "\n");
if (problems.length) {
	console.log(problems.join("\n"));
	console.log(`\n${problems.length} problem(s)`);
	process.exit(1);
}
console.log("pstack parity: 0 problems");
