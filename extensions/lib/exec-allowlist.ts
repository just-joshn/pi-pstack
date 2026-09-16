/**
 * Executable trust policy for the control-cli tool.
 *
 * A basename allowlist is not a path check: a file called `git` under /tmp
 * passes it. A bare name is resolved the way the child process will resolve it,
 * and the first PATH match must sit in a trusted binary directory, so a PATH
 * entry the child can write never becomes the executable this tool runs. An
 * absolute argv0 is checked directly, and its realpath must stay inside the
 * trusted directories too.
 *
 * Interpreters are the one exception, and only under an explicit
 * `allowInterpreters` opt-in. That opt-in is a grant of arbitrary code
 * execution, so the directory an interpreter loads from adds no capability the
 * grant did not already confer; the location check is skipped for it and the
 * name is passed through as given.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

/**
 * Commands that run caller-supplied code. Nothing here is reachable unless the
 * operator sets the explicit opt-in, because the allowlist cannot bound what any
 * of them executes.
 */
export const INTERPRETER_COMMANDS = Object.freeze([
  "node",
  "npx",
  "python",
  "python3",
  "bun",
  "make",
  "tsx",
]);

export type ExecResolution =
  | { readonly ok: true; readonly command: string; readonly base: string; readonly realPath?: string }
  | { readonly ok: false; readonly reason: string };

export type ExecAllowlistOptions = {
  readonly commandAllowlist?: readonly string[];
  readonly allowInterpreters?: boolean;
  readonly trustedDirs?: readonly string[];
  readonly realpath?: (path: string) => string;
  readonly isExecutable?: (path: string) => boolean;
  readonly pathEnv?: string;
};

type RealpathOutcome =
  | { readonly kind: "resolved"; readonly path: string }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly reason: string };

type FileProbe = (path: string) => boolean;

function validateCommandString(command: unknown): string | undefined {
  if (typeof command !== "string" || command === "") return "argv[0] must be a command name/path";
  if (command.includes("\0")) return "argv[0] must not contain a NUL byte";
  if (command.startsWith("-")) return "argv[0] must be a command name/path";
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function trustedDirsFor(options: ExecAllowlistOptions): readonly string[] {
  return options.trustedDirs ?? DEFAULT_TRUSTED_BIN_DIRS;
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

function realPathOf(path: string, options: ExecAllowlistOptions): string | undefined {
  const outcome = inspectRealpath(options.realpath ?? realpathSync, path);
  return outcome.kind === "resolved" ? outcome.path : undefined;
}

/** First PATH entry holding an executable with this name, the way exec will pick it. */
function locateOnPath(name: string, pathEnv: string, isExecutable: FileProbe): string | undefined {
  for (const dir of pathEnv.split(":")) {
    const candidate = join(dir === "" ? process.cwd() : dir, name);
    if (isExecutable(candidate)) return resolve(candidate);
  }
  return undefined;
}

function notInTrustedDir(label: string, trustedDirs: readonly string[]): string {
  return `${label} is not in a trusted binary directory (${[...trustedDirs].join(", ")})`;
}

/** Why this absolute path is not trustworthy, or undefined when it is. */
function trustFailure(label: string, absolute: string, options: ExecAllowlistOptions): string | undefined {
  const trustedDirs = trustedDirsFor(options);
  if (!trustedDirs.includes(dirname(absolute))) return notInTrustedDir(label, trustedDirs);
  const outcome = inspectRealpath(options.realpath ?? realpathSync, absolute);
  if (outcome.kind === "error") return `${label} could not be resolved: ${outcome.reason}`;
  if (outcome.kind === "missing") return undefined;
  if (!trustedDirs.includes(dirname(outcome.path))) {
    return `${label} resolves to '${outcome.path}', outside a trusted binary directory`;
  }
  return undefined;
}

/**
 * PATH resolution executes the entry it finds; it does not follow the entry's
 * symlink to choose it. The located directory is therefore what must be trusted,
 * and the target is left alone: a package manager's `bin` directory is normally a
 * set of symlinks into a versioned install tree, and following those would refuse
 * the platform's own git.
 */
function locatedTrustFailure(label: string, located: string, options: ExecAllowlistOptions): string | undefined {
  if (trustedDirsFor(options).includes(dirname(located))) return undefined;
  return `${label} resolves to '${located}', outside a trusted binary directory`;
}

function validateTrustedPath(argv0: string, options: ExecAllowlistOptions): ExecResolution {
  const failure = trustFailure(`command path '${argv0}'`, resolve(argv0), options);
  return failure === undefined
    ? { ok: true, command: argv0, base: basename(argv0) }
    : { ok: false, reason: failure };
}

/**
 * A bare name nothing on PATH matches is passed through: there is no file to
 * execute, so the spawn reports ENOENT on its own.
 */
function resolveBareName(
  argv0: string,
  base: string,
  interpreter: boolean,
  options: ExecAllowlistOptions,
): ExecResolution {
  if (interpreter) return { ok: true, command: argv0, base };
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const located = locateOnPath(base, pathEnv, options.isExecutable ?? isExecutableFile);
  if (located === undefined) return { ok: true, command: argv0, base };
  const failure = locatedTrustFailure(`command '${base}'`, located, options);
  if (failure !== undefined) return { ok: false, reason: failure };
  const realPath = realPathOf(located, options);
  return { ok: true, command: argv0, base, ...(realPath !== undefined ? { realPath } : {}) };
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
  const interpreter = INTERPRETER_COMMANDS.includes(base);
  if (interpreter && options.allowInterpreters !== true) {
    return { ok: false, reason: `interpreter '${base}' requires an explicit allowInterpreters opt-in` };
  }
  if (!names.includes(base)) {
    return { ok: false, reason: `command '${base}' not in control_cli allowlist (${[...names].join(", ")})` };
  }
  if (!argv0.includes("/")) return resolveBareName(argv0, base, interpreter, options);
  return validateTrustedPath(argv0, options);
}
