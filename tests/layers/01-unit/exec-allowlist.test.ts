import { expect, test } from "vitest";
import {
  DEFAULT_ALLOWED_COMMANDS,
  DEFAULT_TRUSTED_BIN_DIRS,
  INTERPRETER_COMMANDS,
  resolveTrustedCommand,
  type ExecAllowlistOptions,
} from "../../../extensions/lib/exec-allowlist.ts";

const COMPANION_ALLOWLIST = [...DEFAULT_ALLOWED_COMMANDS, ...INTERPRETER_COMMANDS];

function refusalReason(command: unknown, options?: ExecAllowlistOptions): string {
  const result = resolveTrustedCommand(command, options);
  if (result.ok) throw new Error(`${String(command)} was allowed but should be refused`);
  return result.reason;
}

function realpathThrows(code: string): (path: string) => string {
  return () => {
    const err = new Error(code) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };
}

test("exec-allowlist refuses an absolute path outside the trusted directories", () => {
  expect(refusalReason("/tmp/evil/git")).toMatch(/not in a trusted binary directory/);
  expect(refusalReason("/usr/local/git")).toMatch(/not in a trusted binary directory/);
  expect(refusalReason("./git")).toMatch(/not in a trusted binary directory/);
  expect(refusalReason("../tmp/evil/git")).toMatch(/not in a trusted binary directory/);
  expect(refusalReason("/usr/bin/../../tmp/evil/git")).toMatch(/not in a trusted binary directory/);
});

test("exec-allowlist allows trusted bare names and trusted paths", () => {
  expect(resolveTrustedCommand("git").ok).toBe(true);
  expect(resolveTrustedCommand("git", { commandAllowlist: COMPANION_ALLOWLIST }).ok).toBe(true);
  expect(resolveTrustedCommand("/usr/local/bin/git").ok).toBe(true);
  expect(resolveTrustedCommand("/usr/bin/git").ok).toBe(true);
});

test("exec-allowlist keeps the name allowlist and its message order", () => {
  expect(refusalReason("rm")).toBe("command 'rm' not in control_cli allowlist (npm, pnpm, yarn, go, cargo, pytest, git, gh, pi, tsx)");
  expect(refusalReason("rm", { commandAllowlist: ["npm", "git"] })).toBe("command 'rm' not in control_cli allowlist (npm, git)");
});

test("exec-allowlist rejects malformed argv0", () => {
  expect(refusalReason("")).toBe("argv[0] must be a command name/path");
  expect(refusalReason("-v")).toBe("argv[0] must be a command name/path");
  expect(refusalReason(undefined)).toBe("argv[0] must be a command name/path");
  expect(refusalReason("git\0evil")).toBe("argv[0] must not contain a NUL byte");
});

test("exec-allowlist requires an explicit opt-in for pure interpreters", () => {
  const options = { commandAllowlist: COMPANION_ALLOWLIST };
  expect(refusalReason("node", options)).toMatch(/interpreter 'node' requires an explicit allowInterpreters opt-in/);
  expect(refusalReason("bun", options)).toMatch(/interpreter 'bun'/);
  expect(resolveTrustedCommand("node", { ...options, allowInterpreters: true }).ok).toBe(true);
  expect(resolveTrustedCommand("bun", { ...options, allowInterpreters: true }).ok).toBe(true);
  expect(resolveTrustedCommand("git", options).ok).toBe(true);
});

test("exec-allowlist refuses a trusted path whose realpath escapes the trusted directories", () => {
  expect(refusalReason("/usr/local/bin/git", { realpath: () => "/tmp/evil/git" })).toMatch(/resolves to '\/tmp\/evil\/git'/);
});

test("exec-allowlist allows a trusted path that does not exist yet", () => {
  expect(resolveTrustedCommand("/usr/local/bin/git", { realpath: realpathThrows("ENOENT") }).ok).toBe(true);
});

test("exec-allowlist refuses a trusted path when realpath fails for another reason", () => {
  expect(refusalReason("/usr/local/bin/git", { realpath: realpathThrows("EACCES") })).toMatch(/could not be resolved/);
});

test("exec-allowlist trusts only the four documented binary directories", () => {
  expect([...DEFAULT_TRUSTED_BIN_DIRS]).toEqual([
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ]);
});
