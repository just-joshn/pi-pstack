/**
 * Executable trust policy for the control-cli tool.
 *
 * A basename allowlist is not a path check: a file called `git` under /tmp
 * passes it. argv0 is resolved to a real path and must land in a trusted
 * binary directory before it is handed to exec.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const DEFAULT_TRUSTED_BIN_DIRS = Object.freeze([
  "/usr/bin",
  "/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
]);

export const DEFAULT_ALLOWED_COMMANDS = Object.freeze([
  "npm",
  "pnpm",
  "yarn",
  "go",
  "cargo",
  "pytest",
  "git",
  "gh",
  "pi",
  "tsx",
]);

export const INTERPRETER_COMMANDS = Object.freeze([
  "node",
  "npx",
  "python",
  "python3",
  "bun",
  "make",
]);

export type ExecResolution =
  | { readonly ok: true; readonly command: string; readonly base: string; readonly realPath?: string }
  | { readonly ok: false; readonly reason: string };

export type ExecAllowlistOptions = {
  readonly commandAllowlist?: readonly string[];
  readonly allowInterpreters?: boolean;
  readonly trustedDirs?: readonly string[];
  readonly realpath?: (path: string) => string;
};

type RealpathOutcome =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly reason: string };

function validateCommandString(command: unknown): string | undefined {
  if (typeof command !== "string" || command === "") return "argv[0] must be a command name/path";
  if (command.includes("\0")) return "argv[0] must not contain a NUL byte";
  if (command.startsWith("-")) return "argv[0] must be a command name/path";
  return undefined;
}

function inspectRealpath(realpath: (path: string) => string, path: string): RealpathOutcome {
  try {
    return { kind: "resolved", path: realpath(path) };
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return { kind: "missing" };
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

function validateTrustedPath(argv0: string, options: ExecAllowlistOptions): ExecResolution {
  const trustedDirs = options.trustedDirs ?? DEFAULT_TRUSTED_BIN_DIRS;
  const absolute = resolve(argv0);
  const base = basename(argv0);
  if (!trustedDirs.includes(dirname(absolute))) {
    return {
      ok: false,
      reason: `command path '${argv0}' is not in a trusted binary directory (${[...trustedDirs].join(", ")})`,
    };
  }
  const outcome = inspectRealpath(options.realpath ?? realpathSync, absolute);
  if (outcome.kind === "error") {
    return { ok: false, reason: `command path '${argv0}' could not be resolved: ${outcome.reason}` };
  }
  if (outcome.kind === "missing") return { ok: true, command: argv0, base };
  if (!trustedDirs.includes(dirname(outcome.path))) {
    return {
      ok: false,
      reason: `command path '${argv0}' resolves to '${outcome.path}', outside a trusted binary directory`,
    };
  }
  return { ok: true, command: argv0, base, realPath: outcome.path };
}

export function resolveTrustedCommand(
  command: unknown,
  options: ExecAllowlistOptions = {},
): ExecResolution {
  const invalid = validateCommandString(command);
  if (invalid !== undefined) return { ok: false, reason: invalid };
  const argv0 = command as string;
  const base = basename(argv0);
  const names = options.commandAllowlist ?? DEFAULT_ALLOWED_COMMANDS;
  if (INTERPRETER_COMMANDS.includes(base) && options.allowInterpreters !== true) {
    return { ok: false, reason: `interpreter '${base}' requires an explicit allowInterpreters opt-in` };
  }
  if (!names.includes(base)) {
    return { ok: false, reason: `command '${base}' not in control_cli allowlist (${[...names].join(", ")})` };
  }
  if (!argv0.includes("/")) return { ok: true, command: argv0, base };
  return validateTrustedPath(argv0, options);
}
