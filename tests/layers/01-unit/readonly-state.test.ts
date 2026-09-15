/**
 * Unit tests for readonly-state pure functions and transitions.
 * Tests call exported helpers without a live Pi host.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeReadonlyTools } from "../../../extensions/readonly-state/index.ts";

describe("computeReadonlyTools basic", () => {
    it("toolsBefore from activeTools when non-empty", () => {
      const result = computeReadonlyTools(
        ["read", "write", "bash", "pstack_spawn"],
        ["write", "bash", "pstack_spawn"],
        new Set(["write", "bash"]),
      );
      assert.deepEqual(result.toolsBefore, ["write", "bash", "pstack_spawn"]);
      assert.ok(result.nextActive.includes("read"));
      assert.ok(result.nextActive.includes("pstack_spawn"));
      assert.ok(!result.nextActive.includes("write"));
      assert.ok(!result.nextActive.includes("bash"));
    });

    it("toolsBefore from allTools when activeTools empty", () => {
      const result = computeReadonlyTools(
        ["read", "write", "bash"],
        [],
        new Set(["write", "bash"]),
      );
      assert.deepEqual(result.toolsBefore, ["read", "write", "bash"]);
      assert.ok(result.nextActive.includes("read"));
      assert.ok(!result.nextActive.includes("write"));
    });

    it("keeps pstack tools except write-blocked", () => {
      const result = computeReadonlyTools(
        ["read", "pstack_spawn", "pstack_ship", "write"],
        ["read", "pstack_spawn", "pstack_ship", "write"],
        new Set(["write", "pstack_ship"]),
      );
      assert.ok(result.nextActive.includes("pstack_spawn"));
      assert.ok(!result.nextActive.includes("pstack_ship"));
    });
});

describe("computeReadonlyTools edges", () => {
    it("always keeps read grep find ls", () => {
      const result = computeReadonlyTools(
        ["read", "grep", "find", "ls", "write"],
        ["write"],
        new Set(["write"]),
      );
      assert.ok(result.nextActive.includes("read"));
      assert.ok(result.nextActive.includes("grep"));
      assert.ok(result.nextActive.includes("find"));
      assert.ok(result.nextActive.includes("ls"));
    });

    it("filters nextActive correctly", () => {
      const result = computeReadonlyTools(
        ["read", "write", "pstack_spawn"],
        ["read", "write", "pstack_spawn"],
        new Set(["write"]),
      );
      assert.ok(result.nextActive.includes("read"));
      assert.ok(result.nextActive.includes("pstack_spawn"));
      assert.ok(!result.nextActive.includes("write"));
    });

    it("empty nextActive when no match", () => {
      const result = computeReadonlyTools([], [], new Set());
      assert.deepEqual(result.nextActive, []);
      assert.deepEqual(result.toolsBefore, []);
    });

    it("handles empty inputs", () => {
      const result = computeReadonlyTools([], [], new Set());
      assert.ok(Array.isArray(result.nextActive));
      assert.ok(Array.isArray(result.toolsBefore));
    });
});
