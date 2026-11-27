import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	type ExtensionContext,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isRecord } from "./lib/validation.ts";

export const agentDir = () => process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
export const piBin = process.env["PSTACK_PI_BIN"] ?? "pi";
export const artifacts = (ctx: ExtensionContext) =>
	join(agentDir(), "pstack", "sessions", ctx.sessionManager.getSessionId());
export const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
const TRUNCATION_NOTICE = "\n[Output truncated. Request a narrower result or read the listed artifacts.]";

export function result(value: unknown) {
	const output = text(value) ?? "";
	const first = truncateHead(output);
	const bounded = first.truncated
		? truncateHead(first.content, {
				maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(TRUNCATION_NOTICE),
				maxLines: DEFAULT_MAX_LINES - 1,
			}).content + TRUNCATION_NOTICE
		: output;
	return { content: [{ type: "text" as const, text: bounded }], details: undefined };
}
export const stringEnum = <const T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>(StringEnum(values));
export function fail(message: string): never {
	throw new Error(message);
}
export function unreachable(value: never): never {
	throw new Error(`Unhandled case: ${String(value)}`);
}
export const hasErrorCode = (error: unknown, code: string) => isRecord(error) && error["code"] === code;
export async function atomicWrite(path: string, data: string) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(data);
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch((cleanupError: unknown) => {
			throw new AggregateError([error, cleanupError], "Atomic write and cleanup failed", {
				cause: error,
			});
		});
		throw error;
	}
}
export function tsvRow(values: unknown[]) {
	return values.map((v) => String(v).replaceAll(/[\t\r\n]/g, " ")).join("\t") + "\n";
}
export type Notify = (ctx: ExtensionContext, message: string) => void;
export const notifier =
	(pi: ExtensionAPI): Notify =>
	(ctx, message) => {
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		else pi.sendMessage({ customType: "pstack-output", content: message, display: true });
	};
