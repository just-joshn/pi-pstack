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
  const seen = new Map<string, string>();

  const assigned = await Promise.all(
    writers.map(async (w, i) => {
      let cwd = w.cwd?.trim() || "";
      const needsAuto = !cwd || resolve(cwd) === parentResolved;

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
      return cwd;
    }),
  );
  return assigned;
}

export async function removeWorktree(cwd: string, name: string): Promise<string> {
  const slug = sanitizeWorktreeName(name);
  const path = join(worktreeRoot(cwd), slug);
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", path], { cwd });
  } catch {
    /* retry without force */
    await execFileAsync("git", ["worktree", "remove", path], { cwd });
  }
  return path;
}

export async function pruneWorktrees(cwd: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", ["worktree", "prune", "-v"], { cwd });
  return stdout || stderr || "pruned";
}

/**
 * Session-shutdown auto-cleanup for pstack-owned worktrees under .pstack-worktrees.
 * Safe prune only: clean trees whose HEAD is already an ancestor of main-repo HEAD
 * (empty or merged). Never force-deletes dirty trees or unmerged unique commits.
 */
export interface CleanupResult {
  removed: string[];
  pruned: string;
  skipped: Array<{ name: string; reason: string }>;
}

async function isSafeToRemovePstackWorktree(
  repoCwd: string,
  wtPath: string,
  branchName: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const status = await execFileAsync("git", ["-C", wtPath, "status", "--porcelain"], {
      cwd: repoCwd,
    });
    if ((status.stdout || "").trim()) {
      return { ok: false, reason: "dirty working tree" };
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  let wtHead: string;
  try {
    wtHead = (
      await execFileAsync("git", ["-C", wtPath, "rev-parse", "HEAD"], { cwd: repoCwd })
    ).stdout.trim();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // Already contained in main HEAD → empty or merged tip
  const ancestor = await execFileAsync("git", ["merge-base", "--is-ancestor", wtHead, "HEAD"], {
    cwd: repoCwd,
  })
    .then(() => true)
    .catch(() => false);
  if (ancestor) return { ok: true };

  // Branch listed as merged into HEAD
  try {
    const merged = await execFileAsync(
      "git",
      ["branch", "--merged", "HEAD", "--list", branchName],
      { cwd: repoCwd },
    );
    if ((merged.stdout || "").includes(branchName)) return { ok: true };
  } catch {
    /* ignore branch check failure */
    return { ok: false, reason: "has commits not merged into HEAD" };
  }
  return { ok: false, reason: "has commits not merged into HEAD" };
}

export async function cleanupPstackWorktreesOnShutdown(
  cwd: string,
): Promise<CleanupResult> {
  const root = worktreeRoot(cwd);
  if (!existsSync(root)) {
    return { removed: [], pruned: await pruneWorktrees(cwd).catch(() => "n/a"), skipped: [] };
  }
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    names = [];
  }

  const results = await Promise.all(
    names.map(async (name) => {
      const path = join(root, name);
      const branch = `pstack/${name}`;
      const verdict = await isSafeToRemovePstackWorktree(cwd, path, branch);
      if (!verdict.ok) {
        return { name, removed: false, reason: verdict.reason };
      }
      try {
        await removeWorktree(cwd, name);
        return { name, removed: true };
      } catch (err) {
        return {
          name,
          removed: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const removed = results.filter((r) => r.removed).map((r) => r.name);
  const skipped = results
    .filter((r) => !r.removed)
    .map((r) => ({ name: r.name, reason: r.reason ?? "unknown" }));
  const pruned = await pruneWorktrees(cwd).catch((e) =>
    e instanceof Error ? e.message : String(e),
  );
  return { removed, pruned, skipped };
}

/**
 * Always isolate writers for swarm/arena (even a single candidate).
 * Unlike ensureWriterIsolation (multi-only), this allocates a worktree whenever
 * cwd is missing or equals the parent — for any N >= 1.
 */
export async function ensureAlwaysIsolated(
  parentCwd: string,
  writers: Array<{ cwd?: string; label: string }>,
): Promise<string[]> {
  if (writers.length === 0) return [];
  const parentResolved = resolve(parentCwd);
  const seen = new Map<string, string>();

  const assigned = await Promise.all(
    writers.map(async (w, i) => {
      let cwd = w.cwd?.trim() || "";
      const needsAuto = !cwd || resolve(cwd) === parentResolved;
      if (needsAuto) {
        const created = await createIsolatedWorktree(
          parentCwd,
          `auto-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        );
        cwd = created.path;
      }
      const resolvedPath = resolve(cwd);
      const prev = seen.get(resolvedPath);
      if (prev) {
        throw new Error(
          `multi-writer isolation: ${w.label} and ${prev} share cwd ${cwd}; pass unique cwd or omit cwd for auto worktree`,
        );
      }
      seen.set(resolvedPath, w.label);
      return cwd;
    }),
  );
  return assigned;
}
