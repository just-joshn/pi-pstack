import { expect, mock, test } from "bun:test";
import pstackMode from "../../extensions/pstack-mode.ts";

mock.module("@earendil-works/pi-ai", () => ({ StringEnum: () => ({}) }));
mock.module("@earendil-works/pi-tui", () => {
	class TestEditor {
		private value = "";
		onSubmit?: (value: string) => void;
		setText(value: string) { this.value = value; }
		handleInput(data: string) {
			if (data === "\r") this.onSubmit?.(this.value);
			else this.value += data;
		}
		render() { return [this.value]; }
	}
	const Key = {
		up: "up",
		down: "\u001b[B",
		space: " ",
		enter: "\r",
		escape: "\u001b",
		tab: "\t",
		right: "right",
		left: "left",
		shift: (key: string) => `shift+${key}`,
	};
	return {
		Editor: TestEditor,
		Key,
		matchesKey: (data: string, key: string) => data === key,
		Text: class {},
		truncateToWidth: (value: string) => value,
		visibleWidth: () => 0,
		wrapTextWithAnsi: () => [],
	};
});
mock.module("typebox", () => ({
	Type: {
		Array: () => ({}),
		Boolean: () => ({}),
		Number: () => ({}),
		Object: () => ({}),
		Optional: (value: unknown) => value,
		String: () => ({}),
	},
}));

const questionnaireModule = await import("../../extensions/questionnaire.ts");
const {
	default: questionnaire,
	appendMissingQuestionBlocks,
	formatQuestionnaireTab,
	letteredQuestionBlock,
	markRecommendedOption,
	parseMultipleChoiceResponse,
	restoreOptionIndex,
} = questionnaireModule;

function makeContext(options: { mode?: string; hasUI?: boolean; branch?: any[]; ui?: Record<string, any> } = {}) {
	const statuses: Array<[string, string | undefined]> = [];
	const context = {
		mode: options.mode ?? "print",
		hasUI: options.hasUI ?? false,
		cwd: "/tmp",
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
			notify: () => {},
			...options.ui,
		},
	};
	return { context, statuses };
}

function loadQuestionnaire() {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	let tool: any;
	questionnaire({
		on: (name: string, handler: (event: any, ctx: any) => any) => (handlers[name] = handler),
		registerTool: (definition: any) => (tool = definition),
	} as any);
	return { handlers, tool };
}

function loadPstackMode() {
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	const entries: unknown[] = [];
	pstackMode({
		on: (name: string, handler: (event: any, ctx: any) => any) => (handlers[name] = handler),
		appendEntry: (...args: unknown[]) => entries.push(args),
		registerCommand: () => {},
	} as any);
	return { handlers, entries };
}

test("option-level recommendations are marked and moved first", () => {
	const question = {
		id: "priority",
		prompt: "Pick a priority",
		options: [
			{ value: "low", label: "Low" },
			{ value: "high", label: "High", recommended: true },
		],
	};
	const normalized = markRecommendedOption(question);

	expect(normalized.options.map((option) => option.value)).toEqual(["high", "low"]);
	expect(normalized.options[0].label).toBe("High (Recommended)");
	expect(question.options[1].label).toBe("High");
});

test("question-level recommendations remain supported and take precedence", () => {
	const normalized = markRecommendedOption({
		id: "scope",
		prompt: "Pick a scope",
		recommended: "small",
		options: [
			{ value: "large", label: "Large", recommended: true },
			{ value: "small", label: "Small" },
		],
	});

	expect(normalized.options.map((option) => option.value)).toEqual(["small", "large"]);
	expect(normalized.options[0].label).toBe("Small (Recommended)");
});

test("RPC multiple-choice input keeps selected option values", () => {
	const parsed = parseMultipleChoiceResponse("a, c", [
		{ value: "fast", label: "Fast" },
		{ value: "safe", label: "Safe" },
		{ value: "cheap", label: "Cheap" },
	], false);

	expect(parsed).toEqual({ indexes: [0, 2], other: false });
});

test("questionnaire tab labels mark the active tab in text", () => {
	expect(formatQuestionnaireTab("Scope", true, false)).toContain("›");
	expect(formatQuestionnaireTab("Priority", false, true)).not.toContain("›");
	expect(formatQuestionnaireTab("Priority", false, true)).toContain("■");
});

test("restores the cursor to the saved single, multi, and custom answers", () => {
	expect(restoreOptionIndex({ optionCount: 3, hasOther: true, answer: { wasCustom: false, index: 3 }, selectedIndices: [] })).toBe(2);
	expect(restoreOptionIndex({ optionCount: 3, hasOther: true, answer: { wasCustom: true }, selectedIndices: [] })).toBe(3);
	expect(restoreOptionIndex({ optionCount: 3, hasOther: true, answer: { wasCustom: false }, selectedIndices: [2, 0] })).toBe(0);
	expect(restoreOptionIndex({ optionCount: 3, hasOther: true, answer: undefined, selectedIndices: [] })).toBe(0);
});

test("lettered blocks and final messages preserve the questionnaire options", () => {
	const block = letteredQuestionBlock([
		{
			prompt: "Choose a route",
			allowMultiple: false,
			options: [
				{ value: "a", label: "Fast (Recommended)" },
				{ value: "b", label: "Safe" },
			],
		},
		{ prompt: "Choose a color", options: [{ value: "blue", label: "Blue" }] },
	]);
	const finalText = appendMissingQuestionBlocks("I recommend the first route.", [block]);

	expect(block).toContain("1. Choose a route");
	expect(block).toContain("a) Fast (Recommended)");
	expect(finalText).toBe(`I recommend the first route.\n\n${block}`);
	expect(appendMissingQuestionBlocks(block, [block])).toBe(block);
});

test("headless questionnaire results are appended to a final answer that rewrites the options", async () => {
	const { handlers, tool } = loadQuestionnaire();
	const { context } = makeContext();
	const result = await tool.execute(
		"question-call",
		{ questions: [{ id: "scope", prompt: "Choose a scope", options: [{ value: "a", label: "Small" }, { value: "b", label: "Large" }], allowOther: false }] },
		undefined,
		undefined,
		context,
	);
	const block = result.details.letteredBlock;

	expect(block).toContain("a) Small");
	await handlers.tool_result({ toolName: "questionnaire", toolCallId: "question-call", details: result.details, content: result.content }, context);
	const updated = await handlers.message_end(
		{
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I recommend Small." },
					{ type: "text", text: "The user needs to choose." },
				],
			},
		},
		context,
	);
	expect(updated.message.content[0].text).toBe("I recommend Small.");
	expect(updated.message.content[1].text).toContain(block);

	await handlers.tool_result({ toolName: "questionnaire", toolCallId: "question-call-2", details: result.details, content: result.content }, context);
	const unchanged = await handlers.message_end(
		{ message: { role: "assistant", content: [{ type: "text", text: block }] } },
		context,
	);
	expect(unchanged).toBeUndefined();
});

test("RPC questionnaire uses supported dialogs instead of the TUI-only custom component", async () => {
	const calls: string[] = [];
	const { tool } = loadQuestionnaire();
	const { context } = makeContext({
		mode: "rpc",
		hasUI: true,
		ui: {
			select: async (_title: string, options: string[]) => {
				calls.push("select");
				return options[1];
			},
			custom: async () => {
				throw new Error("RPC must not request a TUI custom component");
			},
		},
	});
	const result = await tool.execute(
		"rpc-question",
		{ questions: [{ id: "scope", prompt: "Choose a scope", options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }], allowOther: false }] },
		undefined,
		undefined,
		context,
	);

	expect(calls).toEqual(["select"]);
	expect(result.content[0].text).toContain("Large");
});

test("RPC multiple-choice dialog records comma-separated selections", async () => {
	const { tool } = loadQuestionnaire();
	const { context } = makeContext({
		mode: "rpc",
		hasUI: true,
		ui: { input: async () => "a, c" },
	});
	const result = await tool.execute(
		"rpc-multi",
		{
			questions: [{
				id: "tags",
				prompt: "Choose tags",
				options: [{ value: "fast", label: "Fast" }, { value: "safe", label: "Safe" }, { value: "cheap", label: "Cheap" }],
				allowMultiple: true,
				allowOther: false,
			}],
		},
		undefined,
		undefined,
		context,
	);

	expect(result.content[0].text).toContain("Fast, Cheap");
});

test("multi-select custom answers survive navigating back and tabbing away", async () => {
	type TestQuestionnaireComponent = { handleInput(data: string): void };
	type TestQuestionnaireFactory = (
		tui: { requestRender(): void },
		theme: object,
		keybindings: undefined,
		done: (value: unknown) => void,
	) => TestQuestionnaireComponent;
	const { tool } = loadQuestionnaire();
	const keys = ["\u001b[B", "\r", ...Array.from("custom"), "\r", "shift+tab", "\t", "\r", "\r"];
	const { context } = makeContext({
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (factory: TestQuestionnaireFactory) =>
				new Promise((resolve) => {
					const component = factory({ requestRender() {} }, {}, undefined, resolve);
					for (const key of keys) component.handleInput(key);
				}),
		},
	});
	const result = await tool.execute(
		"custom-answer",
		{
			questions: [
				{ id: "Q1", prompt: "Q1?", allowMultiple: true, options: [{ value: "a", label: "A" }] },
				{ id: "Q2", prompt: "Q2?", allowMultiple: true, options: [{ value: "b", label: "B" }] },
			],
		},
		undefined,
		undefined,
		context,
	);

	expect(result.details.answers).toEqual([
		{ id: "Q1", value: "custom", label: "custom", wasCustom: true, values: ["custom"] },
		{ id: "Q2", value: "b", label: "B", wasCustom: false, values: ["b"] },
	]);
});

test("named skill invocation injects its own steps even when poteto-mode is inactive", async () => {
	const { handlers } = loadPstackMode();
	const { context } = makeContext();
	const result = await handlers.before_agent_start({ prompt: '<skill name="tdd">Follow TDD.</skill>' }, context);

	expect(result.message.display).toBe(false);
	expect(result.message.content).toBe(
		"The user invoked /skill:tdd. tdd's own steps are this task's playbook: seed the todo list with them and follow them. Do not read ~/.pi/agent/skills/poteto-mode/playbooks/*.md or seed another playbook's steps for this task. The skill's own prescribed questions are part of its steps, not blocking on the human. poteto-mode's principles and reply rules still apply.",
	);
});

test("named skill injection replaces the sticky reminder for that turn", async () => {
	const { handlers } = loadPstackMode();
	const { context } = makeContext();
	await handlers.before_agent_start({ prompt: '<skill name="poteto-mode">Sticky mode.</skill>' }, context);
	const result = await handlers.before_agent_start({ prompt: '<skill name="tdd">Follow TDD.</skill>' }, context);

	expect(result.message.content).toContain("The user invoked /skill:tdd.");
	expect(result.message.content).not.toContain("poteto-mode is active in this session");
});

test("loop and goal skill invocations remain exempt from the named-skill injection", async () => {
	const { handlers } = loadPstackMode();
	const { context } = makeContext();

	expect(await handlers.before_agent_start({ prompt: '<skill name="loop">Objective.</skill>' }, context)).toBeUndefined();
	expect(await handlers.before_agent_start({ prompt: '<skill name="goal">Objective.</skill>' }, context)).toBeUndefined();
});

test("pstack status uses hasUI, including RPC status support", async () => {
	const { handlers } = loadPstackMode();
	const rpc = makeContext({ mode: "rpc", hasUI: true });
	const print = makeContext({ mode: "tui", hasUI: false });

	await handlers.session_start({ reason: "startup" }, rpc.context);
	await handlers.session_start({ reason: "startup" }, print.context);
	expect(rpc.statuses).toEqual([["pstack-mode", undefined]]);
	expect(print.statuses).toEqual([]);
});
