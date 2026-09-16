import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.match(refusalReason("/tmp/evil/git"), /not in a trusted binary directory/);
  assert.match(refusalReason("/usr/local/git"), /not in a trusted binary directory/);
  assert.match(refusalReason("./git"), /not in a trusted binary directory/);
  assert.match(refusalReason("../tmp/evil/git"), /not in a trusted binary directory/);
  assert.match(refusalReason("/usr/bin/../../tmp/evil/git"), /not in a trusted binary directory/);
});

test("exec-allowlist allows trusted bare names and trusted paths", () => {
  assert.equal(resolveTrustedCommand("git").ok, true);
  assert.equal(resolveTrustedCommand("git", { commandAllowlist: COMPANION_ALLOWLIST }).ok, true);
  assert.equal(resolveTrustedCommand("/usr/local/bin/git").ok, true);
  assert.equal(resolveTrustedCommand("/usr/bin/git").ok, true);
});

test("exec-allowlist keeps the name allowlist and its message order", () => {
  assert.equal(
    refusalReason("rm"),
    "command 'rm' not in control_cli allowlist (npm, pnpm, yarn, go, cargo, pytest, git, gh, pi, tsx)",
  );
  assert.equal(
    refusalReason("rm", { commandAllowlist: ["npm", "git"] }),
    "command 'rm' not in control_cli allowlist (npm, git)",
  );
});

test("exec-allowlist rejects malformed argv0", () => {
  assert.equal(refusalReason(""), "argv[0] must be a command name/path");
  assert.equal(refusalReason("-v"), "argv[0] must be a command name/path");
  assert.equal(refusalReason(undefined), "argv[0] must be a command name/path");
  assert.equal(refusalReason("git\0evil"), "argv[0] must not contain a NUL byte");
});

test("exec-allowlist requires an explicit opt-in for pure interpreters", () => {
  const options = { commandAllowlist: COMPANION_ALLOWLIST };
  assert.match(refusalReason("node", options), /interpreter 'node' requires an explicit allowInterpreters opt-in/);
  assert.match(refusalReason("bun", options), /interpreter 'bun'/);
  assert.equal(resolveTrustedCommand("node", { ...options, allowInterpreters: true }).ok, true);
  assert.equal(resolveTrustedCommand("bun", { ...options, allowInterpreters: true }).ok, true);
  assert.equal(resolveTrustedCommand("git", options).ok, true);
});

test("exec-allowlist refuses a trusted path whose realpath escapes the trusted directories", () => {
  assert.match(
    refusalReason("/usr/local/bin/git", { realpath: () => "/tmp/evil/git" }),
    /resolves to '\/tmp\/evil\/git'/,
  );
});

test("exec-allowlist allows a trusted path that does not exist yet", () => {
  assert.equal(resolveTrustedCommand("/usr/local/bin/git", { realpath: realpathThrows("ENOENT") }).ok, true);
});

test("exec-allowlist refuses a trusted path when realpath fails for another reason", () => {
  assert.match(
    refusalReason("/usr/local/bin/git", { realpath: realpathThrows("EACCES") }),
    /could not be resolved/,
  );
});

test("exec-allowlist trusts only the four documented binary directories", () => {
  assert.deepEqual([...DEFAULT_TRUSTED_BIN_DIRS], [
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ]);
});
