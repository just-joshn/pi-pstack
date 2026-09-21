#!/usr/bin/env node
// Port conformance checker for the pi build of pstack.
// Usage: node skills/poteto-mode/scripts/check-port.mjs [packageRoot]
// Exits 1 and prints one finding per line when the tree drifts back toward
// Cursor-only tooling, breaks pi's Agent Skills rules, or loses a link.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, normalize } from "node:path";

const root = resolve(process.argv[2] ?? join(dirname(new URL(import.meta.url).pathname), "../../.."));
const findings = [];
const add = (file, line, msg) => findings.push(`${relative(root, file)}:${line}: ${msg}`);

const BANNED = [
	[/cursor-team-kit/i, "cursor-team-kit is not installable from pi"],
	[/\bcontrol-(ui|cli)\b/i, "control-ui/control-cli ship only in cursor-team-kit; name the project harness"],
	[/\/deslop\b/i, "/deslop does not exist here; the commit slop pass is inlined"],
	[/subagent_type/i, "Cursor Task parameter; pi uses the subagent tool's `agent`"],
	[/\bgeneralPurpose\b/, "Cursor agent name; pi's general-purpose agent is `worker`"],
	[/\bAskQuestion\b/, "Cursor tool; ask with numbered options instead"],
	[/(^|[^\w])\/loop\b/, "Cursor command; use a watcher, heartbeat, or shell loop"],
	[/\bcreate-skill\b/, "Cursor built-in; authoring routes to the authoring-a-skill playbook"],
	[/\.cursor\//, "Cursor config path; pi uses .pi/ and ~/.pi/agent/"],
	[/cursor\/rules\/pstack-models|pstack-models\.mdc/i, "model rule lives in ~/.pi/agent/AGENTS.md"],
	[/run_in_background|environment:\s*"cloud"|cloud_base_branch/i, "Cursor Task/cloud parameters have no pi equivalent"],
	[/Cursor cloud agent|cloud-sleeper|cloud root\b/i, "no cloud agents in pi; use local subagents in worktrees"],
	[/grok-4\.\d|claude-fable-5-1-thinking|gpt-5\.6-sol|claude-opus-5-thinking/i, "Cursor model slug; use provider/model-id or a role default"],
	// Session paths: the leading slash is dropped, so `/x/y` becomes `--x-y--`.
	[/working directory with `\/` replaced by `-`/, "ambiguous session-path encoding; state that the leading slash is dropped"],
	[/sessions\/--"\$\(pwd \| sed 's\/\\\/\/-\/g'\)"/, "pwd|sed without stripping the leading slash yields a three-dash prefix"],
];

const ALLOW = [
	/api2\.cursor\.sh/, // make-bot-ui targets a real Cursor webhook by design
	/cursor location/i, // text cursor, not the editor
];

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".git") continue;
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

const files = walk(root);
const markdown = files.filter((f) => f.endsWith(".md"));

// 0. Editor and OS junk. A local-path package install ships the tree as-is,
// so these ride along even though .gitignore covers them.
for (const file of files) {
	if (file.endsWith(".DS_Store") || file.endsWith("~") || file.endsWith(".orig") || file.endsWith(".rej"))
		add(file, 1, "stray editor or OS file inside the package");
}

// 1. Banned Cursor-only tokens, skipping the sections that document the gap.
for (const file of markdown) {
	if (file.includes("/automations/benny/")) continue;
	const isReadme = relative(root, file) === "README.md";
	const lines = readFileSync(file, "utf-8").split("\n");
	let inNotShipped = false;
	lines.forEach((text, i) => {
		if (isReadme && text.startsWith("## ")) inNotShipped = text.trim() === "## not shipped here";
		if (inNotShipped) return;
		if (ALLOW.some((re) => re.test(text))) return;
		for (const [re, why] of BANNED) if (re.test(text)) add(file, i + 1, `${why} (${re.source})`);
	});
}

// 2. Skill frontmatter against pi's name rules.
const skillsDir = join(root, "skills");
const skillNames = new Set();
for (const entry of readdirSync(skillsDir)) {
	const skillFile = join(skillsDir, entry, "SKILL.md");
	if (!existsSync(skillFile)) continue;
	const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(skillFile, "utf-8"));
	if (!fm) {
		add(skillFile, 1, "missing YAML frontmatter");
		continue;
	}
	const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1].trim();
	const description = /^description:\s*(.+)$/m.exec(fm[1])?.[1].trim();
	if (!name) add(skillFile, 2, "frontmatter has no name");
	else {
		skillNames.add(name);
		if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64)
			add(skillFile, 2, `name "${name}" breaks pi's rules (lowercase, digits, single hyphens, <=64 chars)`);
		if (name !== entry) add(skillFile, 2, `name "${name}" does not match directory "${entry}"`);
	}
	if (!description) add(skillFile, 3, "frontmatter has no description; pi will not load the skill");
	else if (description.length > 1024) add(skillFile, 3, "description exceeds 1024 chars");
	// Upstream ships every pstack skill slash-only. Losing the flag leaks the
	// skill's description into every system prompt and lets the model self-invoke.
	if (!/^disable-model-invocation:\s*true\s*$/m.test(fm[1]))
		add(skillFile, 4, "missing `disable-model-invocation: true`; skill would leak into the system prompt");
}

// 3. Slash aliases must track the skills on disk exactly.
const slashFile = join(root, "extensions/pstack-slash.ts");
const listed = new Set([...readFileSync(slashFile, "utf-8").matchAll(/^\t"([a-z0-9-]+)",$/gm)].map((m) => m[1]));
for (const name of skillNames) if (!listed.has(name)) add(slashFile, 1, `skill "${name}" has no slash alias`);
for (const name of listed) if (!skillNames.has(name)) add(slashFile, 1, `slash alias "${name}" has no skill`);

// 4. Relative Markdown links resolve on disk.
for (const file of markdown) {
	readFileSync(file, "utf-8")
		.split("\n")
		.forEach((text, i) => {
			for (const m of text.matchAll(/\]\((\.{1,2}\/[^)\s#]+)/g)) {
				if (!existsSync(normalize(join(dirname(file), m[1])))) add(file, i + 1, `dead relative link ${m[1]}`);
			}
		});
}

if (findings.length === 0) {
	console.log("check-port: clean");
	process.exit(0);
}
for (const f of findings.sort()) console.log(f);
console.log(`\ncheck-port: ${findings.length} finding(s)`);
process.exit(1);
