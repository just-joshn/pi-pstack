import { describe, expect, test } from "bun:test";
import type { ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import registerTodo, { createTodoState, parseTodoDetails, runTodo } from "./todo.ts";

describe("todo execution", () => {
  test("uses sequential execution and assigns stable IDs to concurrent adds", async () => {
    const executionModes = new Map<string, ToolExecutionMode | undefined>();
    const pi = {
      registerTool: (tool: { name: string; executionMode?: ToolExecutionMode }) => {
        executionModes.set(tool.name, tool.executionMode);
      },
      registerCommand: () => {},
      on: () => () => {},
    };
    registerTodo(pi);
    expect(executionModes.get("todo")).toBe("sequential");

    const state = createTodoState();
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => runTodo(state, { action: "add", text: "First step" })),
      Promise.resolve().then(() => runTodo(state, { action: "add", items: ["Second step", "Third step"] })),
    ]);
    expect(first.content[0]?.text).toBe("Added todo #1: First step");
    expect(second.content[0]?.text).toBe("Added todo #2: Second step\nAdded todo #3: Third step");
    expect(first.details.todos).toEqual([{ id: 1, text: "First step", done: false }]);
    expect(second.details.todos).toEqual([
      { id: 1, text: "First step", done: false },
      { id: 2, text: "Second step", done: false },
      { id: 3, text: "Third step", done: false },
    ]);
    expect(runTodo(state, { action: "list" }).content[0]?.text).toBe(
      "[ ] #1: First step\n[ ] #2: Second step\n[ ] #3: Third step",
    );
  });

  test("validates restored TodoDetails from JSON values", () => {
    expect(parseTodoDetails({
      action: "add",
      todos: [{ id: 1, text: "Read brief", done: false }],
      nextId: 2,
    })).toEqual({ action: "add", todos: [{ id: 1, text: "Read brief", done: false }], nextId: 2 });
    expect(parseTodoDetails({ action: "add", todos: [{ id: "1", text: "Read brief", done: false }], nextId: 2 })).toBeUndefined();
    expect(parseTodoDetails({ action: "add", todos: [{ id: 1, text: "Read brief", done: false }], nextId: 0 })).toBeUndefined();
    expect(parseTodoDetails({ action: "other", todos: [], nextId: 1 })).toBeUndefined();
  });
});
