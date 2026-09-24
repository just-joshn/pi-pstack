#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const PI = join(HOME, ".pi/agent");
const UP = join(PI, "pstack/parity/upstream");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const verbose = process.argv.includes("--verbose");
const OLD = args[0] ?? join(UP, "0.15.3");
const NEW = args[1] ?? join(UP, "current");
const ADD_MIN = 0.6;
const STALE_MIN = 0.8;
export const COVERAGE_FLOOR = 98.896; // Current 0.15.5 baseline: 4879/4933; one dropped sentence must fail.
const TERM = new Map(Object.entries({
	task: "subagent",
	cursor: "pi",
	askwrite: "todo",
	askquestion: "questionnaire",
	todowrite: "todo",
	subagent_type: "agent",
	readonly: "reader",
	generalpurpose: "pstack-general",
	leave: "omit",
	unset: "omit",
	slug: "model",
	slugs: "model",
	families: "family",
	block: "rule",
}));
const STOP = new Set("the a an and or of to in on for is are be it its that this with as by at from when each any per tool provider".split(" "));
const NEGATIONS = new Set(["not", "no", "never", "always", "only", "without", "cannot"]);
const NUMBER_WORDS = new Set("zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth once twice dozen".split(" "));
const SLUG = /(claude|gpt|grok|deepseek|anthropic|openai-codex)[a-z0-9./:-]*/g;
const MODEL_CONFIGURATION = /(?:~\/.cursor\/rules\/pstack-models\.mdc|pstack-models\.mdc|pstack models block in `?~\/.pi\/agent\/AGENTS\.md`?)/gi;
const MAPPED = [
	["skills/poteto-mode/playbooks/shipping.md", "One subagent per PR, not batched, each a Cursor cloud agent", "cloud agent maps to a local poteto-agent in a managed worktree at the PR head"],
];
export const ACCEPTED_REWRITES = new Map([
	["skills/make-bot-ui/SKILL.md", { reason: "The cloud webhook routine is rewritten as a local Pi bot session.", wholeFile: true }],
	["skills/setup-pstack/SKILL.md", { reason: "The Cursor rule file is rewritten as the Pi AGENTS model block.", wholeFile: true }],
	["skills/control-cli/SKILL.md", { reason: "Parallel Lanes use isolated local lanes instead of one cloud VM per lane.", pattern: /cloud.{0,80}(?:lane|vm)|(?:lane|vm).{0,80}cloud/i }],
	["skills/control-ui/SKILL.md", { reason: "Parallel Lanes use isolated local lanes instead of one cloud VM per lane.", pattern: /cloud.{0,80}(?:lane|vm)|(?:lane|vm).{0,80}cloud/i }],
]);

export function walk(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if ([".DS_Store", "node_modules"].includes(entry.name)) return [];
		return entry.isDirectory() ? walk(path) : [path];
	});
}

export function sentences(text) {
	const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const out = [];
	let fence = false;
	for (const raw of body.split("\n")) {
		if (/^\s*(```|````)/.test(raw)) {
			fence = !fence;
			continue;
		}
		const line = raw.replace(/^\s*(?:[-*]|\d+\.|>|#+|\|)\s*/, "").trim();
		if (!line) continue;
		if (fence) {
			out.push(line);
			continue;
		}
		for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z*`(\[])/)) {
			if (sentence.trim()) out.push(sentence.trim());
		}
	}
	return out;
}

function lexicalWords(sentence) {
	return sentence.toLowerCase()
		.replace(MODEL_CONFIGURATION, " modelconfiguration ")
		.replace(/\/skill:([a-z][a-z0-9-]*)/g, "/$1")
		.replace(SLUG, " model ")
		.replace(/\b(?:don't|doesn't|didn't|can't|cannot)\b/g, " not ")
		.replace(/(?<=\d)[-–](?=\d)/g, " ")
		.replace(/[`*_"'()[\]{}:,.;!?|>–—]/g, " ")
		.split(/\s+/)
		.map((word) => TERM.get(word) ?? word)
		.filter(Boolean);
}

export function tokens(sentence) {
	const words = lexicalWords(sentence);
	const result = new Set(words.filter((word) => (word.length > 2 && !STOP.has(word)) || NEGATIONS.has(word) || NUMBER_WORDS.has(word) || /^\d+(?:\.\d+)*$/.test(word)));
	const contexts = new Set();
	for (let i = 0; i < words.length; i++) {
		if (!NEGATIONS.has(words[i])) continue;
		const before = words.slice(0, i).reverse().find((word) => !STOP.has(word) && !NEGATIONS.has(word)) ?? "^";
		const after = words.slice(i + 1).find((word) => !STOP.has(word) && !NEGATIONS.has(word)) ?? "$";
		contexts.add(`${before}|${words[i]}|${after}`);
	}
	Object.defineProperty(result, "negationContexts", { value: contexts });
	return result;
}

export function criticalTokens(tokenSet) {
	return new Set([...tokenSet].filter((word) => NEGATIONS.has(word) || NUMBER_WORDS.has(word) || /^\d+(?:\.\d+)*$/.test(word)));
}

export function jaccard(a, b) {
	if (!a.size && !b.size) return 1;
	let intersection = 0;
	for (const word of a) if (b.has(word)) intersection++;
	return intersection / (a.size + b.size - intersection);
}

function sameSet(a, b) {
	return a.size === b.size && [...a].every((word) => b.has(word));
}

export function similarity(a, b) {
	if (!sameSet(criticalTokens(a), criticalTokens(b))) return 0;
	if (!sameSet(a.negationContexts ?? new Set(), b.negationContexts ?? new Set())) return 0;
	return jaccard(a, b);
}

export function mappedPairs(PI_ROOT, UP_ROOT) {
	const pairs = [
		...walk(join(UP_ROOT, "pstack/skills")).map((upstream) => [upstream, join(PI_ROOT, "skills", relative(join(UP_ROOT, "pstack/skills"), upstream))]),
		...walk(join(UP_ROOT, "pstack/agents")).map((upstream) => [upstream, join(PI_ROOT, "agents", relative(join(UP_ROOT, "pstack/agents"), upstream))]),
		...walk(join(UP_ROOT, "cursor-team-kit/skills")).filter((file) => ["deslop", "control-cli", "control-ui"].some((skill) => file.includes(`/skills/${skill}/`))).map((upstream) => {
			const skill = upstream.match(/\/skills\/([^/]+)\//)?.[1];
			return [upstream, join(PI_ROOT, "skills", skill, ...upstream.split(`/skills/${skill}/`).at(-1).split("/"))];
		}),
	].filter(([upstream]) => upstream.endsWith(".md"));
	return pairs.map(([upstream, port]) => ({ upstream, port, rel: relative(PI_ROOT, port) }));
}

export function acceptedRewrite(rel, sentence = "") {
	const rewrite = ACCEPTED_REWRITES.get(rel);
	return rewrite && (rewrite.wholeFile || rewrite.pattern.test(sentence)) ? rewrite : undefined;
}

export function agentMentions(text) {
	const pattern = /(?:`(?:agent|subagent_type)`|(?:agent|subagent_type))\s*[:=]\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z][\w.-]*))/g;
	const mentions = [];
	for (const match of text.matchAll(pattern)) {
		const name = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim();
		const before = text.lastIndexOf("\n\n", match.index) + 2;
		const after = text.indexOf("\n\n", match.index);
		const paragraph = text.slice(before, after < 0 ? text.length : after);
		const readonly = paragraph.match(/`?readonly`?\s*[:=]\s*`?(true|false)`?/i)?.[1]?.toLowerCase();
		const normalized = /^generalpurpose$/i.test(name) ? (readonly === "true" ? "pstack-reader" : "pstack-general") : name.toLowerCase();
		mentions.push({ name, normalized, index: match.index });
	}
	return mentions;
}

export function key(sentence) {
	const words = tokens(sentence);
	return `${[...words].sort().join(" ")}\0${[...(words.negationContexts ?? [])].sort().join(" ")}`;
}

function portPath(rel, PI_ROOT) {
	const [kit, top, ...rest] = rel.split("/");
	if ((kit === "cursor-team-kit" || kit === "pstack") && top === "skills") return join(PI_ROOT, "skills", ...rest);
	if (kit === "pstack" && top === "agents") return join(PI_ROOT, "agents", ...rest);
	return undefined;
}

function acceptedDelta(rel, sentence) {
	const rewrite = acceptedRewrite(rel, sentence);
	if (rewrite && !rewrite.wholeFile) return rewrite.reason;
	return MAPPED.find(([file, prefix]) => rel.endsWith(file) && sentence.startsWith(prefix))?.[2];
}

function run() {
	const files = new Set([...walk(OLD), ...walk(NEW)].map((file) => relative(file.startsWith(OLD) ? OLD : NEW, file)));
	const report = [];
	let missing = 0;
	let stale = 0;
	for (const rel of [...files].sort()) {
		if (!rel.endsWith(".md")) continue;
		const port = portPath(rel, PI);
		if (!port) continue;
		const oldText = existsSync(join(OLD, rel)) ? readFileSync(join(OLD, rel), "utf8") : "";
		const newText = existsSync(join(NEW, rel)) ? readFileSync(join(NEW, rel), "utf8") : "";
		if (oldText === newText) continue;
		const oldSentences = sentences(oldText);
		const newSentences = sentences(newText);
		const oldKeys = new Set(oldSentences.map(key));
		const newKeys = new Set(newSentences.map(key));
		const added = newSentences.filter((sentence) => !oldKeys.has(key(sentence)) && tokens(sentence).size >= 3);
		const removed = oldSentences.filter((sentence) => !newKeys.has(key(sentence)) && tokens(sentence).size >= 3);
		if (!existsSync(port)) {
			if (added.length) report.push(`${rel}: port file missing (${relative(HOME, port)})`), (missing += added.length);
			continue;
		}
		const portTokens = sentences(readFileSync(port, "utf8")).map(tokens);
		for (const sentence of added) {
			const score = portTokens.reduce((best, candidate) => Math.max(best, similarity(tokens(sentence), candidate)), 0);
			const mapped = acceptedDelta(rel, sentence);
			if (score < ADD_MIN && mapped) {
				if (verbose) report.push(`mapped  ${relative(HOME, port)}: ${mapped}`);
			} else if (score < ADD_MIN) {
				missing++;
				report.push(`MISSING ${relative(HOME, port)} (${score.toFixed(2)}): ${sentence}`);
			} else if (verbose) report.push(`ok      ${relative(HOME, port)} (${score.toFixed(2)}): ${sentence.slice(0, 90)}`);
		}
		for (const sentence of removed) {
			const rewrite = acceptedRewrite(rel, sentence);
			if (rewrite && !rewrite.wholeFile) continue;
			const upstreamTokens = tokens(sentence);
			for (const candidate of portTokens) {
				const toOld = similarity(upstreamTokens, candidate);
				if (toOld < STALE_MIN) continue;
				const toNew = added.reduce((best, addedSentence) => Math.max(best, similarity(tokens(addedSentence), candidate)), 0);
				if (toOld > toNew + 0.05) {
					stale++;
					report.push(`STALE   ${relative(HOME, port)} (${toOld.toFixed(2)}): ${sentence}`);
					break;
				}
			}
		}
	}
	console.log(report.join("\n"));
	console.log(`\nsync-check ${relative(UP, OLD)} -> ${relative(UP, NEW)}: ${missing} missing, ${stale} stale`);
	process.exitCode = missing || stale ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) run();
