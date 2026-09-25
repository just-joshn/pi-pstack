import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-ai", () => ({ StringEnum: () => ({}) }));
mock.module("@earendil-works/pi-tui", () => ({
	Editor: class {},
	Key: {},
	matchesKey: () => false,
	Text: class {},
	truncateToWidth: (value: string) => value,
	visibleWidth: () => 0,
	wrapTextWithAnsi: () => [],
}));
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

const { default: todoExtension } = await import("../../extensions/todo.ts");

function loadTodo(branch: any[] = []) {
	let tool: any;
	const handlers: Record<string, (event: any, ctx: any) => any> = {};
	todoExtension({
		on: (name: string, handler: (event: any, ctx: any) => any) => (handlers[name] = handler),
		registerTool: (definition: any) => (tool = definition),
		registerCommand: () => {},
	} as any);
	const context = {
		mode: "print",
		hasUI: false,
		sessionManager: { getBranch: () => branch },
		ui: { setWidget: () => {} },
	};
	return { context, handlers, tool };
}

test("previous todo details are deep snapshots after later state changes", async () => {
	const { context, tool } = loadTodo();
	const added = await tool.execute("add", { action: "add", items: ["Reproduce", "Fix"] }, undefined, undefined, context);
	const before = structuredClone(added.details.todos);

	await tool.execute("set", { action: "set", id: 1, status: "completed", text: "Reproduce skip: n/a" }, undefined, undefined, context);

	expect(added.details.todos).toEqual(before);
	expect(added.details.todos[0].text).toBe("Reproduce");
	expect(added.details.todos[0].done).toBe(false);
});

test("list result details cannot mutate the extension's live todo state", async () => {
	const { context, tool } = loadTodo();
	await tool.execute("add", { action: "add", text: "Keep state isolated" }, undefined, undefined, context);
	const listed = await tool.execute("list", { action: "list" }, undefined, undefined, context);
	listed.details.todos[0].text = "Changed outside";

	const next = await tool.execute("list-again", { action: "list" }, undefined, undefined, context);
	expect(next.details.todos[0].text).toBe("Keep state isolated");

	const updated = await tool.execute("set", { action: "set", id: 1, status: "in_progress" }, undefined, undefined, context);
	updated.details.todos[0].text = "Changed again";
	const afterSet = await tool.execute("list", { action: "list" }, undefined, undefined, context);
	expect(afterSet.details.todos[0].text).toBe("Keep state isolated");
});

test("reconstructed todo state is detached from saved branch details", async () => {
	const branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: {
					action: "add",
					todos: [{ id: 4, text: "Saved branch item", done: false }],
					nextId: 5,
				},
			},
		},
	];
	const { context, handlers, tool } = loadTodo(branch);
	await handlers.session_start({ reason: "resume" }, context);
	branch[0].message.details.todos[0].text = "Changed session history";

	const listed = await tool.execute("list", { action: "list" }, undefined, undefined, context);
	expect(listed.details.todos).toEqual([{ id: 4, text: "Saved branch item", done: false }]);
	expect(listed.details.nextId).toBe(5);
});
