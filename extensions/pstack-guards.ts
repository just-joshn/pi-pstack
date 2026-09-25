/**
 * Structural guards for Pi-specific failure modes.
 *
 * 1. Background polling in bash cannot wake the session. Run polling loops and watchers as background Shell tasks with notifications.
 * 2. Installed skill writes require explicit intent from the latest user message or task.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { packageResources } from "./package-resources.ts";
const SKILL_WRITE_BLOCK_REASON =
	"Installed skills change only when the user asks. If a skill looks broken, check that its own text references the missing thing; if it does not, the claim is false.";

type ShellToken = { kind: "word" | "operator"; value: string; quoted: boolean };
type ShellSegment = { tokens: ShellToken[]; backgrounded: boolean };

function readShellWord(command: string, start: number): { token: ShellToken; end: number } {
	let value = "";
	let quoted = false;
	let quote: "'" | '"' | "`" | undefined;
	let index = start;
	while (index < command.length) {
		const char = command[index];
		if (quote) {
			if (char === quote) {
				quote = undefined;
				index++;
				continue;
			}
			if (char === "\\" && quote !== "'") {
				if (index + 1 < command.length) value += command[index + 1];
				index += 2;
				continue;
			}
			value += char;
			index++;
			continue;
		}
		if (/\s/.test(char) || ";&|(){}<>".includes(char)) break;
		if (char === "\\") {
			if (index + 1 < command.length) value += command[index + 1];
			index += 2;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quoted = true;
			quote = char;
			index++;
			continue;
		}
		value += char;
		index++;
	}
	return { token: { kind: "word", value, quoted }, end: index };
}

function skipHeredocBodies(command: string, start: number, heredocs: Array<{ delimiter: string; stripTabs: boolean }>): number {
	let index = start;
	for (const heredoc of heredocs) {
		while (index < command.length) {
			const end = command.indexOf("\n", index);
			const lineEnd = end < 0 ? command.length : end;
			const line = command.slice(index, lineEnd).replace(/\r$/, "");
			const content = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
			index = end < 0 ? command.length : end + 1;
			if (content === heredoc.delimiter) break;
		}
	}
	return index;
}

function tokenizeShell(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	let pendingHeredoc: { stripTabs: boolean } | undefined;
	let index = 0;
	while (index < command.length) {
		const char = command[index];
		if (char === "\n") {
			tokens.push({ kind: "operator", value: "\n", quoted: false });
			index++;
			if (heredocs.length) index = skipHeredocBodies(command, index, heredocs.splice(0));
			pendingHeredoc = undefined;
			continue;
		}
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		if (char === "#" && (index === 0 || /\s|[;&|(){}]/.test(command[index - 1]))) {
			while (index < command.length && command[index] !== "\n") index++;
			continue;
		}
		if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
			const stripTabs = command[index + 2] === "-";
			const width = stripTabs ? 3 : 2;
			tokens.push({ kind: "operator", value: stripTabs ? "<<-" : "<<", quoted: false });
			pendingHeredoc = { stripTabs };
			index += width;
			continue;
		}
		if (char === "<" && command[index + 1] === "<" && command[index + 2] === "<") {
			tokens.push({ kind: "operator", value: "<<<", quoted: false });
			index += 3;
			continue;
		}
		const three = command.slice(index, index + 3);
		if (three === "&>>") {
			tokens.push({ kind: "operator", value: three, quoted: false });
			index += 3;
			continue;
		}
		const two = command.slice(index, index + 2);
		if (["&&", "||", "|&", "&>", "&<", ">>", ">&", "<>", ">|"].includes(two)) {
			tokens.push({ kind: "operator", value: two, quoted: false });
			index += 2;
			continue;
		}
		if (";&|(){}<>".includes(char)) {
			tokens.push({ kind: "operator", value: char, quoted: false });
			index++;
			continue;
		}
		const { token, end } = readShellWord(command, index);
		tokens.push(token);
		if (pendingHeredoc) {
			heredocs.push({ delimiter: token.value, stripTabs: pendingHeredoc.stripTabs });
			pendingHeredoc = undefined;
		}
		index = end;
	}
	return tokens;
}

function isCommandStart(tokens: ShellToken[]): boolean {
	const previous = tokens.at(-1);
	return !previous ||
		(previous.kind === "operator" && [";", "\n", "&&", "||"].includes(previous.value)) ||
		(previous.kind === "word" && ["do", "then", "else", "elif"].includes(previous.value));
}

function splitShellSegments(tokens: ShellToken[]): ShellSegment[] {
	const segments: ShellSegment[] = [];
	let current: ShellToken[] = [];
	let loopDepth = 0;
	let parenthesisDepth = 0;
	let braceDepth = 0;
	const push = (backgrounded: boolean) => {
		if (current.some((token) => token.kind === "word")) segments.push({ tokens: current, backgrounded });
		current = [];
	};

	for (const token of tokens) {
		if (token.kind === "word" && !token.quoted && isCommandStart(current)) {
			if (["while", "until", "for"].includes(token.value)) loopDepth++;
			else if (token.value === "done" && loopDepth > 0) loopDepth--;
		}
		if (token.kind === "operator") {
			if (token.value === "(") parenthesisDepth++;
			else if (token.value === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
			else if (token.value === "{") braceDepth++;
			else if (token.value === "}") braceDepth = Math.max(0, braceDepth - 1);
			if (token.value === "&" && loopDepth === 0 && parenthesisDepth === 0 && braceDepth === 0) {
				push(true);
				continue;
			}
			if ([";", "\n"].includes(token.value) && loopDepth === 0 && parenthesisDepth === 0 && braceDepth === 0) {
				push(false);
				continue;
			}
		}
		current.push(token);
	}
	push(false);
	return segments;
}

function hasPollingLoopOrWatcher(segment: ShellSegment): boolean {
	const text = segment.tokens.map((token) => token.value).join(" ");
	return (
		/\b(?:while|until|for)\b[\s\S]*\bsleep\b/i.test(text) ||
		/\bwatch-pr\b|\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[\s\S]*?--watch|\btail\s+-f\b|\bfswatch\b|\binotifywait\b/i.test(text) ||
		/\(\s*sleep\b[^)]*\)/i.test(text)
	);
}

function isDetachedCommand(tokens: ShellToken[]): boolean {
	const words = tokens.filter((token) => token.kind === "word").map((token) => token.value);
	if (words[0] === "nohup" || words[0] === "setsid") return true;
	const tmuxIndex = words.indexOf("tmux");
	if (tmuxIndex >= 0 && ["new-session", "new"].includes(words[tmuxIndex + 1]) && words.slice(tmuxIndex + 2).some((word) => word === "-d" || word.startsWith("-d"))) return true;
	return words[0] === "screen" && words.slice(1).some((word) => word.startsWith("-dm") || (word === "-d" && words.includes("-m")));
}

export function isBackgroundPoll(command: string): boolean {
	return splitShellSegments(tokenizeShell(command)).some(
		(segment) => hasPollingLoopOrWatcher(segment) && (segment.backgrounded || isDetachedCommand(segment.tokens)),
	);
}

function resolvedFilesystemPath(target: string): string {
	let current = target;
	const remainder: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return target;
		remainder.unshift(basename(current));
		current = parent;
	}
	return resolve(realpathSync(current), ...remainder);
}

function isUnderDirectory(target: string, root: string): boolean {
	const relativePath = relative(root, target);
	return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function resolvesUnderSkillsRoot(target: string, cwd: string): boolean {
	const expanded = target === "~" ? homedir() : target.startsWith("~/") ? resolve(homedir(), target.slice(2)) : resolve(cwd, target);
	const resolvedTarget = resolvedFilesystemPath(expanded);
	const roots = [resolve(getAgentDir(), "skills"), packageResources.skillsDirectory];
	return roots.some((root) => isUnderDirectory(resolvedTarget, resolvedFilesystemPath(root)));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join(" ");
}

function latestUserMessage(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") return textOf(entry.message.content);
	}
	return "";
}

const SKILL_EDIT_ACTION = /\b(?:edit(?:ed|ing)?|chang(?:e|es|ing|ed)|fix(?:es|ed|ing)?|updat(?:e|es|ed|ing)|creat(?:e|ed|ing)|add(?:ed|ing)?)\b/gi;
const SKILL_COMMAND = /\/skill:(?:create-skill|reflect|setup-pstack|automate-me)(?:\b|\s|$)/gi;
const SKILL_PATH_CANDIDATE = /(?:~\/|\/)[^\s"'<>]+/gi;
const SKILL_EDIT_NEGATION = /\b(?:do\s+not|don't|dont|did\s+not|didn't|never|avoid|without|not|no)\b(?:(?:\s+|,\s*)(?:want|need|like|plan|intend|ask|asked|request|requested|wish|expect|think|should|say|said|to|you|me|run|use|invoke|call|mention|edit(?:ed|ing)?|chang(?:e|es|ing|ed)|fix(?:es|ed|ing)?|updat(?:e|es|ed|ing)|creat(?:e|ed|ing)|add(?:ed|ing)?|poteto[- ]mode|author(?:ing)?|skill|skills|any|a|an|the|my|your|this|that|existing|installed|ever|and|or))*[,\s]*$/i;
const SKILL_INTENT_CLAUSE_BREAK = /[!?;\n]+|\.(?=\s|$)|\b(?:but|however|instead|rather)\b/gi;

function isNegatedSkillIntent(clause: string, intentIndex: number): boolean {
	const prefix = clause.slice(0, intentIndex);
	return SKILL_EDIT_NEGATION.test(prefix);
}

function hasUnnegatedIntent(clause: string, pattern: RegExp): boolean {
	for (const match of clause.matchAll(pattern)) {
		if (match.index !== undefined && !isNegatedSkillIntent(clause, match.index)) return true;
	}
	return false;
}

function hasUnnegatedProtectedSkillPath(clause: string): boolean {
	for (const match of clause.matchAll(SKILL_PATH_CANDIDATE)) {
		if (match.index !== undefined && resolvesUnderSkillsRoot(match[0], process.cwd()) && !isNegatedSkillIntent(clause, match.index)) {
			return true;
		}
	}
	return false;
}

const SKILL_BLOCK = /<skill name="([^"]+)"[^>]*>[\s\S]*?<\/skill>/gi;

export function skillWriteBlock(target: string, cwd: string, userMessage: string): { block: true; reason: string } | undefined {
	if (resolvesUnderSkillsRoot(target, cwd) && !mentionsSkillEditingIntent(userMessage)) {
		return { block: true, reason: SKILL_WRITE_BLOCK_REASON };
	}
	return undefined;
}

export function typedWords(text: string): string {
	return text.replace(SKILL_BLOCK, (_block, name: string) => ` /skill:${name} `);
}

export function isNonPotetoChild(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PSTACK_AGENTS_DEPTH !== undefined && env.PSTACK_AGENTS_DEPTH !== "0" && env.PSTACK_AGENTS_AGENT !== "poteto-agent";
}

export function mentionsSkillEditingIntent(raw: string): boolean {
	const text = typedWords(raw);
	for (const clause of text.split(SKILL_INTENT_CLAUSE_BREAK)) {
		if (hasUnnegatedIntent(clause, SKILL_COMMAND)) return true;
		const clauseWithoutCommands = clause.replace(SKILL_COMMAND, "");
		if (hasUnnegatedProtectedSkillPath(clauseWithoutCommands)) return true;
		if (/\bskills?\b/i.test(clauseWithoutCommands) && hasUnnegatedIntent(clauseWithoutCommands, SKILL_EDIT_ACTION)) return true;
		if (/\bpoteto[- ]mode\b/i.test(clauseWithoutCommands) && hasUnnegatedIntent(clauseWithoutCommands, /\bauthor(?:ing)?\b/gi)) return true;
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			if (typeof event.input !== "object" || event.input === null || !("command" in event.input)) return undefined;
			const command = event.input.command;
			if (typeof command !== "string" || !isBackgroundPoll(command)) return undefined;
			return {
				block: true,
				reason:
					"A backgrounded polling loop or watcher in bash never wakes this session, and it dies unseen. " +
					"Run it as a background Shell task with `is_background: true` and `output_notification` set to a matching line pattern. " +
					"Its exit wakes you at zero model cost (pi-runtime.md, Loops, goals, and wakes). Background servers and one-off jobs are not blocked, only polling loops and watchers.",
			};
		}

		if (event.toolName === "read" && isNonPotetoChild()) {
			const target = typeof event.input === "object" && event.input !== null && "path" in event.input ? String(event.input.path) : "";
			if (/skills\/poteto-mode\/playbooks\//.test(target)) {
				return {
					block: true,
					reason:
						"You are a Task child, not a poteto-agent. Follow your brief and the skill it names; do not load a poteto-mode playbook or seed its steps.",
				};
			}
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			if (typeof event.input !== "object" || event.input === null || !("path" in event.input)) return undefined;
			const path = event.input.path;
			if (typeof path !== "string") return undefined;
			const target = path;
			if (target) return skillWriteBlock(target, ctx.cwd, latestUserMessage(ctx));
		}
		return undefined;
	});
}
