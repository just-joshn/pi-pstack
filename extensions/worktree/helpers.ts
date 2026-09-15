/**
 * Shared worktree create/sanitize helpers for pstack_worktree + swarm/arena isolation.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Soft cap on pstack-managed worktrees under .pstack-worktrees (create refuses past this). */
export const MAX_PSTACK_WORKTREES = 12;

export class WorktreeSanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeSanitizeError";
  }
}

/** Reject path/option injection: no `..`, no leading `-`, no path separators, no NUL. */
export function sanitizeWorktreeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new WorktreeSanitizeError("worktree name required");
  if (trimmed.startsWith("-")) {
    throw new WorktreeSanitizeError("worktree name must not start with '-'");
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new WorktreeSanitizeError("worktree name must not contain '..', path separators, or NUL");
  }
  if (!/^[A-Za-z0-9._@+=,-]+$/.test(trimmed)) {
    throw new WorktreeSanitizeError("worktree name has unsupported characters");
  }
  return trimmed;
}

/** Sanitize a git ref used as worktree base (no option injection). */
export function sanitizeBaseRef(base: string): string {
  const trimmed = base.trim();
  if (!trimmed) throw new WorktreeSanitizeError("base ref required");
  if (trimmed.startsWith("-")) {
    throw new WorktreeSanitizeError("base ref must not start with '-'");
  }
  if (trimmed.includes("..") || trimmed.includes("\0") || /\s/.test(trimmed)) {
    throw new WorktreeSanitizeError("base ref must not contain '..', whitespace, or NUL");
  }
  if (!/^[A-Za-z0-9._\/~^+-]+$/.test(trimmed)) {
    throw new WorktreeSanitizeError("base ref has unsupported characters");
  }
  return trimmed;
}

export function worktreeRoot(cwd: string): string {
  return join(cwd, ".pstack-worktrees");
}

export function countPstackWorktrees(cwd: string): number {
  const root = worktreeRoot(cwd);
  if (!existsSync(root)) return 0;
  try {
    return readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

export async function createIsolatedWorktree(
  cwd: string,
  name: string,
  base = "HEAD",
): Promise<{ path: string; branch: string }> {
  const slug = sanitizeWorktreeName(name);
  const ref = sanitizeBaseRef(base);
  if (countPstackWorktrees(cwd) >= MAX_PSTACK_WORKTREES) {
    throw new WorktreeSanitizeError(
      `pstack worktree session cap (${MAX_PSTACK_WORKTREES}) reached; remove/prune before creating more`,
    );
  }
  const path = join(worktreeRoot(cwd), slug);
  const branch = `pstack/${slug}`;
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branch, path, ref], { cwd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git worktree add failed: ${msg}`);
  }
  return { path, branch };
}

/**
 * For multi-writer fan-out: ensure each writer has a unique cwd.
 * Missing cwd or shared parent cwd → auto-allocate a worktree.
 * Explicit duplicate non-parent cwd → reject.
 */
export async function ensureWriterIsolation(
  parentCwd: string,
  writers: Array<{ cwd?: string; label: string }>,
): Promise<string[]> {
  if (writers.length <= 1) {
    return writers.map((w) => w.cwd ?? parentCwd);
  }

  const parentResolved = resolve(parentCwd);
  const assigned: string[] = [];
  const seen = new Map<string, string>();

  for (let i = 0; i < writers.length; i++) {
    const w = writers[i];
    let cwd = w.cwd?.trim() || "";
    const needsAuto =
      !cwd || resolve(cwd) === parentResolved;

    if (needsAuto) {
      const created = await createIsolatedWorktree(
        parentCwd,
        `auto-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      );
      cwd = created.path;
    }

    const resolved = resolve(cwd);
    const prev = seen.get(resolved);
    if (prev) {
      throw new Error(
        `multi-writer isolation: ${w.label} and ${prev} share cwd ${cwd}; pass unique cwd or omit cwd for auto worktree`,
      );
    }
    seen.set(resolved, w.label);
    assigned.push(cwd);
  }
  return assigned;
}

export async function removeWorktree(cwd: string, name: string): Promise<string> {
  const slug = sanitizeWorktreeName(name);
  const path = join(worktreeRoot(cwd), slug);
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", path], { cwd });
  } catch {
    await execFileAsync("git", ["worktree", "remove", path], { cwd });
  }
  return path;
}

export async function pruneWorktrees(cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", ["worktree", "prune", "-v"], { cwd });
  return stdout || stderr || "pruned";
}
