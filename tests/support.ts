import assert from "node:assert/strict";
import { type ExecFileOptions, execFile } from "node:child_process";
import { promisify } from "node:util";

import { isRecord } from "../src/lib/validation.ts";

export const assumeShape = <T>(value: unknown): T => value as T;
export const double = <T>(members: Partial<T>): T => assumeShape<T>(members);

export function nth<T>(items: readonly T[], index: number): T {
	const item = items[index];
	assert(item !== undefined, `No item ${index}`);
	return item;
}
export const flag = (args: readonly string[] | undefined, name: string) => args?.[args.indexOf(name) + 1];
export const loadedExtensions = (args: readonly string[]) =>
	args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));

const exec = promisify(execFile);
const output = (value: unknown) => (typeof value === "string" ? value : "");
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
