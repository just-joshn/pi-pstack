/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface Todo {
	id: number;
	text: string;
	done: boolean;
	status?: TodoStatus;
}

interface TodoDetails {
	action: "list" | "add" | "toggle" | "set" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "set", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add), or replacement text (for set, e.g. '<step> skip: <reason>')" })),
	items: Type.Optional(Type.Array(Type.String(), { description: "Several todo texts added in order (for add). Use to copy a playbook's steps verbatim in one call." })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle or set)" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "cancelled"] as const, {
			description: "New status (for set). Mark the step you start as in_progress, as TodoWrite does.",
		}),
	),
});

function statusOf(todo: Todo): TodoStatus {
	return todo.status ?? (todo.done ? "completed" : "pending");
}

const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]", cancelled: "[-]" };

function glyph(todo: Todo, theme: Theme): string {
	switch (statusOf(todo)) {
		case "completed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "◐");
		case "cancelled":
			return theme.fg("dim", "✗");
		default:
			return theme.fg("dim", "○");
	}
}

function tally(todos: Todo[]): string {
	const cancelled = todos.filter((t) => statusOf(t) === "cancelled").length;
	const done = todos.filter((t) => statusOf(t) === "completed").length;
	return `${done}/${todos.length - cancelled}${cancelled ? ` · ${cancelled} cancelled` : ""}`;
}

function panelTally(todos: Todo[]): string {
	const cancelled = todos.filter((t) => statusOf(t) === "cancelled").length;
	const done = todos.filter((t) => statusOf(t) === "completed").length;
	return `${done}/${todos.length - cancelled} completed${cancelled ? ` · ${cancelled} cancelled` : ""}`;
}

const LIST_MARKER = /^\s*(?:\d+[.)]|[-*]|\[[ xX~-]\])\s+/;

function isClosed(todo: Todo): boolean {
	const status = statusOf(todo);
	return status === "completed" || status === "cancelled";
}

function snapshotTodos(todos: Todo[]): Todo[] {
	return structuredClone(todos);
}

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", panelTally(this.todos))}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const check = glyph(todo, th);
				const id = th.fg("accent", `#${todo.id}`);
				const text = isClosed(todo) ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = structuredClone(details.todos);
				nextId = details.nextId;
			}
		}
	};

	const renderWidget = (ctx: ExtensionContext) => {
		if (todos.length === 0 || todos.every(isClosed)) {
			ctx.ui.setWidget("todo", undefined);
			return;
		}
		ctx.ui.setWidget("todo", (_tui, theme) => {
			const lines = [theme.fg("muted", `Todos ${tally(todos)}`)];
			for (const t of todos) {
				const text = isClosed(t) ? theme.fg("dim", t.text) : statusOf(t) === "in_progress" ? theme.fg("accent", t.text) : t.text;
				lines.push(`${glyph(t, theme)} ${theme.fg("accent", `#${t.id}`)} ${text}`);
			}
			return {
				render: (width: number) => lines.map((line) => truncateToWidth(line, width)),
				invalidate: () => {},
			};
		});
	};

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		renderWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		renderWidget(ctx);
	});

	const runTodo = (params: { action: TodoDetails["action"]; text?: string; items?: string[]; id?: number; status?: TodoStatus }) => {
		switch (params.action) {
			case "list":
				return {
					content: [
						{
							type: "text",
							text: todos.length
								? todos.map((t) => `${MARK[statusOf(t)]} #${t.id}: ${t.text}`).join("\n")
								: "No todos",
						},
					],
					details: { action: "list", todos: snapshotTodos(todos), nextId } as TodoDetails,
				};

			case "add": {
				const texts = params.items?.length ? params.items : params.text ? [params.text] : [];
				if (!texts.length) {
					return {
						content: [{ type: "text", text: "Error: text required for add" }],
						details: { action: "add", todos: snapshotTodos(todos), nextId, error: "text required" } as TodoDetails,
					};
				}
				const open = new Set(todos.filter((t) => !isClosed(t)).map((t) => t.text));
				const skipped: string[] = [];
				const added: Todo[] = [];
				for (const raw of texts) {
					const text = raw.replace(LIST_MARKER, "").trim();
					if (!text) continue;
					if (open.has(text)) {
						skipped.push(text);
						continue;
					}
					open.add(text);
					added.push({ id: nextId++, text, done: false });
				}
				todos.push(...added);
				const lines = added.map((t) => `Added todo #${t.id}: ${t.text}`);
				if (skipped.length) lines.push(`Already open, not added again: ${skipped.join(" | ")}`);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { action: "add", todos: snapshotTodos(todos), nextId } as TodoDetails,
				};
			}

			case "toggle": {
				if (params.id === undefined) {
					return {
						content: [{ type: "text", text: "Error: id required for toggle" }],
						details: { action: "toggle", todos: snapshotTodos(todos), nextId, error: "id required" } as TodoDetails,
					};
				}
				const todo = todos.find((t) => t.id === params.id);
				if (!todo) {
					return {
						content: [{ type: "text", text: `Todo #${params.id} not found` }],
						details: {
							action: "toggle",
							todos: snapshotTodos(todos),
							nextId,
							error: `#${params.id} not found`,
						} as TodoDetails,
					};
				}
				todo.done = statusOf(todo) !== "completed";
				todo.status = todo.done ? "completed" : "pending";
				return {
					content: [{ type: "text", text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}` }],
					details: { action: "toggle", todos: snapshotTodos(todos), nextId } as TodoDetails,
				};
			}

			case "set": {
				const todo = params.id === undefined ? undefined : todos.find((t) => t.id === params.id);
				if (!todo || !params.status) {
					const error = !params.status ? "status required for set" : `#${params.id} not found`;
					return {
						content: [{ type: "text", text: `Error: ${error}` }],
						details: { action: "set", todos: snapshotTodos(todos), nextId, error } as TodoDetails,
					};
				}
				todo.status = params.status;
				todo.done = params.status === "completed";
				if (params.text?.trim()) todo.text = params.text.trim();
				return {
					content: [{ type: "text", text: `Todo #${todo.id} ${params.status}` }],
					details: { action: "set", todos: snapshotTodos(todos), nextId } as TodoDetails,
				};
			}

			case "clear": {
				const open = todos.filter((t) => !isClosed(t));
				if (open.length) {
					const error = `${open.length} open todo(s): ${open.map((t) => `#${t.id}`).join(", ")}. Close each first with set (completed, or cancelled), using text "<step> skip: <reason>" for a step you chose not to do, then clear.`;
					return {
						content: [{ type: "text", text: `Error: ${error}` }],
						details: { action: "clear", todos: snapshotTodos(todos), nextId, error } as TodoDetails,
					};
				}
				const count = todos.length;
				todos = [];
				nextId = 1;
				return {
					content: [{ type: "text", text: `Cleared ${count} todos` }],
					details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
				};
			}

			default:
				return {
					content: [{ type: "text", text: `Unknown action: ${params.action}` }],
					details: {
						action: "list",
						todos: snapshotTodos(todos),
						nextId,
						error: `unknown action: ${params.action}`,
					} as TodoDetails,
				};
		}
	};

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage the session todo list (Pi's TodoWrite). Actions: list, add (text, or items for several at once; list numbers are stripped and already-open duplicates skipped), set (id + status: pending, in_progress, completed, cancelled; optional text replaces the item text), toggle (id, flips completed), clear (only when every item is closed). Mark a skipped step with set {id, status: 'completed', text: '<step> skip: <reason>'}.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = runTodo(params);
			renderWidget(ctx);
			return result;
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("muted", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = glyph(t, theme);
						const itemText = isClosed(t) ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg.split("\n").join(" · ")), 0, 0);
				}

				case "toggle":
				case "set": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// Register the /todos command for users
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
