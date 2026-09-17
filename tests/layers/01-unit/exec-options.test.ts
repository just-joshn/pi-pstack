import { expect, test } from "vitest";
import { execOptions } from "../../../extensions/lib/exec-options.ts";

test("execOptions drops keys whose value is undefined", () => {
  expect(execOptions()).toEqual({});
  expect(execOptions({ signal: undefined, timeout: undefined, cwd: undefined })).toEqual({});
  expect(execOptions({ signal: undefined, timeout: 5 })).toEqual({ timeout: 5 });
});

test("execOptions keeps every defined value", () => {
  const controller = new AbortController();
  expect(execOptions({ signal: controller.signal, timeout: 5, cwd: "/tmp/x" })).toEqual({
    signal: controller.signal,
    timeout: 5,
    cwd: "/tmp/x",
  });
  expect(execOptions({ timeout: 0, cwd: "" })).toEqual({ timeout: 0, cwd: "" });
});
