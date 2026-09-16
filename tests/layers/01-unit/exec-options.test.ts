import { test } from "node:test";
import assert from "node:assert/strict";
import { execOptions } from "../../../extensions/lib/exec-options.ts";

test("execOptions drops keys whose value is undefined", () => {
  assert.deepEqual(execOptions(), {});
  assert.deepEqual(execOptions({ signal: undefined, timeout: undefined, cwd: undefined }), {});
  assert.deepEqual(execOptions({ signal: undefined, timeout: 5 }), { timeout: 5 });
});

test("execOptions keeps every defined value", () => {
  const controller = new AbortController();
  assert.deepEqual(execOptions({ signal: controller.signal, timeout: 5, cwd: "/tmp/x" }), {
    signal: controller.signal,
    timeout: 5,
    cwd: "/tmp/x",
  });
  assert.deepEqual(execOptions({ timeout: 0, cwd: "" }), { timeout: 0, cwd: "" });
});
