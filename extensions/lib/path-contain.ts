/**
 * Path containment at system boundaries. A caller-supplied path is compared
 * against a workspace root only after resolving it through the filesystem, so a
 * symlink cannot smuggle a write or a child cwd outside the workspace.
 *
 * realpath needs the path to exist, and the leaf (a log file, a fresh session
 * dir) often does not. Resolve the longest existing ancestor instead, then
 * re-attach the not-yet-existing tail: every symlink on the existing prefix is
 * resolved, which is exactly where an escape can hide.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, resolve, sep } from "node:path";

/** Extra workspace roots a caller opts into, `path.delimiter`-separated. */
export const ALLOWED_CWD_ENV = "PSTACK_ALLOWED_CWD";

export interface ContainmentOptions {
  /** Workspace root the path must stay inside. Defaults to `process.cwd()`. */
  root?: string;
  /** Base for a relative path. Defaults to the root. */
  base?: string;
  /** Additional roots treated as contained (the documented escape hatch). */
  allowedRoots?: string[];
  /** Name used in the refusal message, e.g. `cwd` or `resumeSessionDir`. */
  label?: string;
}

export function isPathInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/** Realpath of the longest existing ancestor of `target`, plus the missing tail. */
export function resolveExistingAncestor(target: string): string {
  let current = target;
  let missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(target);
    missing = [basename(current), ...missing];
    current = parent;
  }
  return resolve(realpathSync(current), ...missing);
}

/** Split `PSTACK_ALLOWED_CWD` into absolute roots; relative entries resolve against `base`. */
export function allowedCwdRoots(base: string, raw: string | undefined = process.env[ALLOWED_CWD_ENV]): string[] {
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (isAbsolute(entry) ? entry : resolve(base, entry)));
}

/**
 * Validate that `requested` resolves inside the workspace root. Returns the
 * lexically resolved absolute path (the value callers keep using); throws when
 * the realpath escapes the root and no allowed root contains it.
 */
export function assertPathContainment(requested: string, options: ContainmentOptions = {}): string {
  const root = options.root ?? process.cwd();
  const base = options.base ?? root;
  const absolute = resolve(base, requested);
  const rootReal = resolveExistingAncestor(root);
  const candidateReal = resolveExistingAncestor(absolute);
  const inside =
    isPathInside(rootReal, candidateReal) ||
    (options.allowedRoots ?? []).some((extra) => isPathInside(resolveExistingAncestor(extra), candidateReal));
  if (!inside) {
    const label = options.label ?? "path";
    throw new Error(
      `${label} escapes the workspace root: ${absolute} resolves to ${candidateReal}, outside ${rootReal}. ` +
        `Pass a path under the workspace, or set ${ALLOWED_CWD_ENV} to add an allowed root.`,
    );
  }
  return absolute;
}
