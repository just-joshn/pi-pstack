import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { isRecord } from "../lib/validation.ts";

export const agentDir = () => process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
export const piBin = process.env["PSTACK_PI_BIN"] ?? "pi";
export const artifacts = (ctx: ExtensionContext) =>
  join(agentDir(), "pstack", "sessions", ctx.sessionManager.getSessionId());
export const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: text(value) }],
  details: undefined,
});
export const stringEnum = <const T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>(StringEnum(values));
export function fail(message: string): never {
  throw new Error(message);
}
export function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
export const hasErrorCode = (error: unknown, code: string) =>
  isRecord(error) && error["code"] === code;
export async function atomicWrite(path: string, data: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
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
