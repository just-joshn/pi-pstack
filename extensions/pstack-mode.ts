/**
 * Sticky poteto-mode, Pi's form of Cursor's `mode: true` + `reminder:` skill frontmatter.
 *
 * Once poteto-mode is loaded in a session (via /skill:poteto-mode or by reading its SKILL.md),
 * every later turn gets the mode's reminder, and the footer shows the mode, until the user
 * opts out (`/poteto off`, or "turn off poteto mode").
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { packageResources } from "./package-resources.ts";

const SKILL_PATH = packageResources.potetoModeSkillFile;

export function stickyModeReminderText(): string {
	return (
		"poteto-mode is active in this session. New task? Playbook match or rigor needed -> apply poteto-mode: " +
		`if its SKILL.md (${packageResources.potetoModeSkillFile}) is no longer in your context, read it in full first, ` +
		"then read the matched playbook and seed the todo list before any other tool call. " +
		"A /skill:<name> the user typed is that task's playbook: seed and follow that skill's own steps, under poteto-mode's principles and reply rules, " +
		"and do not wrap it in another playbook. " +
		"A single direct instruction (run this, start that, a quick question) is not a new task. Casual turn or user opts out -> don't."
	);
}
const OPT_OUT = /\b(turn off|disable|exit|leave|stop using|opt out of|no more)\s+(the\s+)?poteto[- ]?mode\b/i;
const NAMED_SKILL_EXCLUSIONS = new Set(["poteto-mode", "loop", "goal"]);
const STATE_TYPE = "pstack-mode-state";

type ModeState = { active: boolean };

function loadsSkill(text: string): boolean {
	return text.includes('<skill name="poteto-mode"');
}

function invokedNamedSkills(prompt: string): string[] {
	const names = new Set<string>();
	for (const match of prompt.matchAll(/<skill name="([^"]+)"/g)) {
		const name = match[1];
		if (name && !NAMED_SKILL_EXCLUSIONS.has(name)) names.add(name);
	}
	return [...names];
}

export function namedSkillInstruction(name: string): string {
	return `The user invoked /skill:${name}. ${name}'s own steps are this task's playbook: seed the todo list with them and follow them. Do not read ${packageResources.potetoPlaybooksDirectory}/*.md or seed another playbook's steps for this task. The skill's own prescribed questions are part of its steps, not blocking on the human. poteto-mode's principles and reply rules still apply.`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join(" ");
}

export default function (pi: ExtensionAPI) {
	if (process.env.PSTACK_AGENTS_DEPTH !== undefined && process.env.PSTACK_AGENTS_AGENT !== "poteto-agent") return;

	let active = false;

	const show = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus("pstack-mode", active ? "👑 poteto" : undefined);
	};

	const set = (next: boolean, ctx: ExtensionContext) => {
		if (next === active) return;
		active = next;
		pi.appendEntry<ModeState>(STATE_TYPE, { active });
		show(ctx);
	};

	const reconstruct = (ctx: ExtensionContext) => {
		active = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				active = Boolean((entry.data as ModeState | undefined)?.active);
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role === "user") {
				const text = textOf(msg.content);
				if (loadsSkill(text)) active = true;
				else if (OPT_OUT.test(text)) active = false;
			} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === "toolCall" && part.name === "read" && String(part.arguments?.path ?? "").endsWith(SKILL_PATH)) {
						active = true;
					}
				}
			}
		}
		show(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_compact", async (_event, ctx) => show(ctx));

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "read" && String((event.input as { path?: string }).path ?? "").endsWith(SKILL_PATH)) set(true, ctx);
		return undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		show(ctx);
		const loadsPotetoMode = loadsSkill(event.prompt);
		const optsOut = OPT_OUT.test(event.prompt);
		if (loadsPotetoMode) set(true, ctx);
		else if (optsOut) set(false, ctx);

		const namedSkills = invokedNamedSkills(event.prompt);
		if (namedSkills.length) {
			return {
				message: {
					customType: "pstack-mode-named-skill",
					content: namedSkills.map(namedSkillInstruction).join("\n\n"),
					display: false,
				},
			};
		}
		if (loadsPotetoMode || optsOut || !active) return undefined;
		return { message: { customType: "pstack-mode-reminder", content: stickyModeReminderText(), display: false } };
	});

	pi.registerCommand("poteto", {
		description: "Show or toggle sticky poteto-mode: /poteto [on|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") set(true, ctx);
			else if (arg === "off") set(false, ctx);
			ctx.ui.notify(`poteto-mode is ${active ? "on" : "off"}`, "info");
		},
	});
}
