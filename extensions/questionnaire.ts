/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 * allowMultiple: Space toggles options, Enter confirms the set (Cursor AskQuestion allow_multiple)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label?: string;
	prompt: string;
	options: QuestionOption[];
	allowOther?: boolean;
	allowMultiple?: boolean;
	recommended?: string;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
	values?: string[];
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
	letteredBlock?: string;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark this option as recommended and show it first" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
	allowMultiple: Type.Optional(
		Type.Boolean({ description: "Let the user pick several options (Space toggles, Enter confirms). Default: false" }),
	),
	recommended: Type.Optional(
		Type.String({ description: "Value of the option you recommend. It is shown first and labelled (Recommended)." }),
	),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

export function markRecommendedOption(question: Question): Question {
	const recommended =
		(question.recommended && question.options.find((option) => option.value === question.recommended)) ||
		question.options.find((option) => option.recommended === true);
	if (!recommended) return question;
	return {
		...question,
		options: [
			{ ...recommended, label: recommended.label.includes("(Recommended)") ? recommended.label : `${recommended.label} (Recommended)` },
			...question.options.filter((option) => option !== recommended),
		],
	};
}

export function formatQuestionnaireTab(label: string, active: boolean, answered: boolean): string {
	return `${active ? "› " : "  "}${answered ? "■" : "□"} ${label}`;
}

export function restoreOptionIndex({
	optionCount,
	hasOther,
	answer,
	selectedIndices,
}: {
	optionCount: number;
	hasOther: boolean;
	answer: Pick<Answer, "index" | "wasCustom"> | undefined;
	selectedIndices: readonly number[];
}): number {
	const optionTotal = optionCount + (hasOther ? 1 : 0);
	const lastIndex = Math.max(0, optionTotal - 1);
	const clamp = (index: number) => Math.max(0, Math.min(lastIndex, index));
	if (selectedIndices.length) return clamp(Math.min(...selectedIndices));
	if (answer?.index !== undefined) return clamp(answer.index - 1);
	if (answer?.wasCustom && hasOther) return clamp(optionCount);
	return 0;
}

export function letteredQuestionBlock(questions: readonly Pick<Question, "prompt" | "options" | "allowMultiple">[]): string {
	return questions
		.map((question, questionIndex) => {
			const letters = question.options.map(
				(option, optionIndex) => `  ${String.fromCharCode(97 + optionIndex)}) ${option.label}${option.description ? ` (${option.description})` : ""}`,
			);
			const hint = question.allowMultiple ? " (pick any, e.g. a, c)" : "";
			return `${questions.length > 1 ? `${questionIndex + 1}. ` : ""}${question.prompt}${hint}\n${letters.join("\n")}`;
		})
		.join("\n\n");
}

export function appendMissingQuestionBlocks(text: string, blocks: readonly string[]): string {
	const missing = [...new Set(blocks.filter((block) => block && !text.includes(block)))];
	return missing.length ? [text.trimEnd(), ...missing].filter(Boolean).join("\n\n") : text;
}

export function parseMultipleChoiceResponse(
	response: string,
	options: readonly QuestionOption[],
	allowOther: boolean,
): { indexes: number[]; custom?: string; other: boolean } {
	const indexes = new Set<number>();
	const unmatched: string[] = [];
	let other = false;
	for (const rawToken of response.split(",")) {
		const token = rawToken.trim();
		if (!token) continue;
		const explicitIndex = /^([a-z])$/i.test(token)
			? token.toLowerCase().charCodeAt(0) - 97
			: /^\d+$/.test(token)
				? Number(token) - 1
				: undefined;
		const matchedIndex = explicitIndex ?? options.findIndex(
			(option) => option.value.toLowerCase() === token.toLowerCase() || option.label.toLowerCase() === token.toLowerCase(),
		);
		if (matchedIndex === options.length && allowOther) {
			other = true;
		} else if (matchedIndex >= 0 && matchedIndex < options.length) {
			indexes.add(matchedIndex);
		} else if (allowOther) {
			unmatched.push(token);
		}
	}
	return { indexes: [...indexes].sort((a, b) => a - b), ...(unmatched.length ? { custom: unmatched.join(", ") } : {}), other };
}

function errorResult(
	message: string,
	questions: Question[] = [],
	letteredBlock?: string,
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true, ...(letteredBlock ? { letteredBlock } : {}) },
	};
}

async function runDialogQuestionnaire(questions: Question[], ctx: ExtensionContext): Promise<QuestionnaireResult> {
	const answers: Answer[] = [];
	for (const question of questions) {
		const label = question.label || question.id;
		if (question.allowMultiple) {
			const choices = question.options.map(
				(option, index) => `${String.fromCharCode(97 + index)}) ${option.label}${option.description ? ` (${option.description})` : ""}`,
			);
			if (question.allowOther) choices.push(`${String.fromCharCode(97 + question.options.length)}) Type something.`);
			const response = await ctx.ui.input(
				`${label}: ${question.prompt}\n${choices.join("\n")}\nEnter letters, option values, or custom text separated by commas.`,
				"a, c",
				{ signal: ctx.signal },
			);
			if (response === undefined) return { questions, answers, cancelled: true };
			const parsed = parseMultipleChoiceResponse(response, question.options, question.allowOther === true);
			let custom = parsed.custom;
			if (parsed.other) {
				const value = await ctx.ui.input(`${label}: your other answer`, "Type your answer", { signal: ctx.signal });
				if (value === undefined) return { questions, answers, cancelled: true };
				custom = value.trim() || "(no response)";
			}
			const chosen = parsed.indexes.map((index) => question.options[index]);
			const values = chosen.map((option) => option.value);
			const labels = chosen.map((option) => option.label);
			if (custom) {
				values.push(custom);
				labels.push(custom);
			}
			if (!values.length) {
				values.push("(no response)");
				labels.push("(no response)");
			}
			answers.push({ id: question.id, value: values.join(", "), label: labels.join(", "), wasCustom: custom !== undefined, values });
			continue;
		}

		const choices = question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` (${option.description})` : ""}`);
		if (question.allowOther) choices.push(`${question.options.length + 1}. Type something.`);
		const selected = await ctx.ui.select(question.prompt, choices, { signal: ctx.signal });
		if (selected === undefined) return { questions, answers, cancelled: true };
		const index = choices.indexOf(selected);
		if (index === question.options.length && question.allowOther) {
			const value = await ctx.ui.input(`${label}: your answer`, "Type your answer", { signal: ctx.signal });
			if (value === undefined) return { questions, answers, cancelled: true };
			const custom = value.trim() || "(no response)";
			answers.push({ id: question.id, value: custom, label: custom, wasCustom: true });
			continue;
		}
		const option = question.options[index];
		if (!option) return { questions, answers, cancelled: true };
		answers.push({ id: question.id, value: option.value, label: option.label, wasCustom: false, index: index + 1 });
	}
	return { questions, answers, cancelled: false };
}

export default function questionnaire(pi: ExtensionAPI) {
	const pendingQuestionBlocks: string[] = [];

	pi.on("before_agent_start", async () => {
		pendingQuestionBlocks.length = 0;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.hasUI || event.toolName !== "questionnaire") return undefined;
		const details = event.details as QuestionnaireResult | undefined;
		if (details?.letteredBlock) pendingQuestionBlocks.push(details.letteredBlock);
		return undefined;
	});

	pi.on("message_end", async (event, ctx) => {
		if (ctx.hasUI || event.message.role !== "assistant" || !Array.isArray(event.message.content)) return undefined;
		if (event.message.content.some((part) => part.type === "toolCall")) return undefined;
		const textParts = event.message.content.filter((part) => part.type === "text");
		if (!textParts.length || !pendingQuestionBlocks.length) return undefined;
		const completeText = textParts.map((part) => part.text).join("\n");
		const missingBlocks = [...new Set(pendingQuestionBlocks.filter((block) => block && !completeText.includes(block)))];
		pendingQuestionBlocks.length = 0;
		if (!missingBlocks.length) return undefined;
		const content = [...event.message.content];
		const lastTextIndex = content.findLastIndex((part) => part.type === "text");
		const lastText = content[lastTextIndex];
		if (lastText?.type === "text") {
			content[lastTextIndex] = { ...lastText, text: appendMissingQuestionBlocks(lastText.text, missingBlocks) };
		}
		return { message: { ...event.message, content } };
	});
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions (Pi's AskQuestion). Use for clarifying requirements, getting preferences, or confirming decisions. Set question-level `recommended` to an option value or option-level `recommended: true`; the recommended option is shown first with (Recommended). Single questions show an option list; several questions show tabs.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.questions.length === 0) return errorResult("Error: No questions provided");

			const questions: Question[] = params.questions.map((question, index) => {
				const recommended = markRecommendedOption(question);
				return {
					...recommended,
					label: recommended.label || `Q${index + 1}`,
					allowOther: recommended.allowOther !== false,
					allowMultiple: recommended.allowMultiple === true,
				};
			});

			if (!ctx.hasUI) {
				const block = letteredQuestionBlock(questions);
				const needsRec = questions.some((question) => !question.options.some((option) => option.label.includes("(Recommended)")));
				return errorResult(
					"UI not available (non-interactive run). Ask the user in chat instead: post the question below verbatim" +
						(needsRec ? ", after marking your recommended option with (Recommended) and moving it first" : "") +
						", then end your turn and wait for the answer.\n\n" +
						block,
					questions,
					block,
				);
			}

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			let result: QuestionnaireResult;
			if (ctx.mode === "tui") {
				result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();
				const picks = new Map<string, Set<number>>();

				function picksFor(questionId: string): Set<number> {
					let set = picks.get(questionId);
					if (!set) {
						set = new Set<number>();
						picks.set(questionId, set);
					}
					return set;
				}

				function saveMultiAnswer(q: Question, custom?: string) {
					const previous = answers.get(q.id);
					const preservedCustom = custom ?? (previous?.wasCustom ? previous.values?.at(-1) : undefined);
					const chosen = [...picksFor(q.id)].sort((a, b) => a - b).map((i) => q.options[i]);
					const values = chosen.map((o) => o.value);
					const labels = chosen.map((o) => o.label);
					if (preservedCustom) {
						values.push(preservedCustom);
						labels.push(preservedCustom);
					}
					answers.set(q.id, {
						id: q.id,
						value: values.join(", "),
						label: labels.join(", "),
						wasCustom: preservedCustom !== undefined,
						values,
					});
				}

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function restoreCurrentOptionIndex() {
					const question = currentQuestion();
					optionIndex = restoreOptionIndex({
						optionCount: question?.options.length ?? 0,
						hasOther: question?.allowOther === true,
						answer: question ? answers.get(question.id) : undefined,
						selectedIndices: question ? [...picksFor(question.id)] : [],
					});
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					restoreCurrentOptionIndex();
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					const inputQuestion = questions.find((question) => question.id === inputQuestionId);
					if (inputQuestion?.allowMultiple) saveMultiAnswer(inputQuestion, trimmed);
					else saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti && q?.allowMultiple && (picksFor(q.id).size > 0 || answers.has(q.id)) && (matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
						saveMultiAnswer(q);
					}
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							restoreCurrentOptionIndex();
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							restoreCurrentOptionIndex();
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					if (q?.allowMultiple && matchesKey(data, Key.space)) {
						const opt = opts[optionIndex];
						if (!opt.isOther) {
							const set = picksFor(q.id);
							if (set.has(optionIndex)) set.delete(optionIndex);
							else set.add(optionIndex);
							refresh();
						}
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						if (q.allowMultiple) {
							const set = picksFor(q.id);
							if (set.size === 0) set.add(optionIndex);
							saveMultiAnswer(q);
							advanceAfterAnswer();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const renderWidth = Math.max(1, width);
					const q = currentQuestion();
					const opts = currentOptions();

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label || questions[i].id;
							const color = isAnswered ? "success" : "muted";
							const text = ` ${formatQuestionnaireTab(lbl, isActive, isAnswered)} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = ` ${isSubmitTab ? "›" : " "} ✓ Submit `;
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const box = q?.allowMultiple && !isOther ? (picksFor(q.id).has(i) ? "[x] " : "[ ] ") : "";
							const label = `${i + 1}. ${box}${opt.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";

							addWrappedWithPrefix(prefix, theme.fg(color, label));
							if (opt.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
							}
						}
					}

					// Content
					if (inputMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						// Show options for reference
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc to cancel"));
					} else if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
								addWrappedWithPrefix(" ", summary);
							}
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const toggle = q?.allowMultiple ? " • Space toggle" : "";
						const help = isMulti
							? `Tab/←→ navigate • ↑↓ select${toggle} • Enter confirm • Esc cancel`
							: `↑↓ navigate${toggle} • Enter ${q?.allowMultiple ? "confirm" : "select"} • Esc cancel`;
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
				});
			} else {
				result = await runDialogQuestionnaire(questions, ctx);
			}

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.values) {
					return `${qLabel}: user selected: ${a.label}`;
				}
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${labels})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
