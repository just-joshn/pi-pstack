import assert from "node:assert/strict";
import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

import { isRecord } from "../lib/validation.ts";

/** Gives a value the shape the test states. A wrong shape fails the assertion that reads it. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-parameters -- The one place where tests assert a shape instead of proving it.
export const shaped = <T>(value: unknown): T => value as T;
/** A test double that has only the members the code under test uses. */
export const double = <T>(members: Partial<T>): T => shaped<T>(members);

/** The item at an index; fails the test when there is none. */
export function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert(item !== undefined, `No item ${index}`);
  return item;
}
/** The value that follows a command-line flag. */
export const flag = (args: readonly string[] | undefined, name: string) =>
  args?.[args.indexOf(name) + 1];

const exec = promisify(execFile);
const output = (value: unknown) => (typeof value === "string" ? value : "");
/** Runs a program and reports its exit status instead of rejecting. */
export async function spawned(file: string, args: string[], options: ExecFileOptions = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, { ...options, encoding: "utf8" });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = isRecord(error) ? error : {};
    return {
      status: typeof failure["code"] === "number" ? failure["code"] : 1,
      stdout: output(failure["stdout"]),
      stderr: output(failure["stderr"]),
    };
  }
}
