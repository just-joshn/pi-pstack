import * as fs from "node:fs";
import * as path from "node:path";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { RunId } from "./contracts.ts";

const execFile = promisify(execFileCallback);

export type WorktreeAdmission = {
  repository: string;
  baseRef: string;
  baseCommit: string;
};

export type WorktreeResult = WorktreeAdmission & {
  path: string;
  branch: string;
};

type LockRecord = { pid: number; birth: string };
type PersistedWorktree = { version: 1; repository: string; baseRef: string; baseCommit: string; path: string; branch: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isRawObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

function canonicalRepository(repository: string): string {
  return git(repository, ["rev-parse", "--show-toplevel"]);
}

function remoteBranchName(baseBranch: string): string {
  if (baseBranch.trim() === "" || baseBranch !== baseBranch.trim()) throw new Error("cloud_base_branch must be a named Git branch");
  const name = baseBranch.startsWith("origin/") ? baseBranch.slice("origin/".length) : baseBranch;
  if (name === "" || isRawObjectId(name)) throw new Error("cloud_base_branch must be a named Git branch, not a raw SHA");
  try {
    execFileSync("git", ["check-ref-format", "--branch", name], { stdio: "ignore" });
  } catch {
    throw new Error(`Invalid cloud_base_branch: ${baseBranch}`);
  }
  return name;
}

function fetchOriginBranch(repository: string, baseBranch: string): string {
  const name = remoteBranchName(baseBranch);
  const refspec = `+refs/heads/${name}:refs/remotes/origin/${name}`;
  try {
    execFileSync("git", ["-C", repository, "fetch", "--no-tags", "origin", refspec], { stdio: "ignore" });
  } catch {
    throw new Error(`Could not fetch cloud_base_branch from origin: ${name}`);
  }
  return `origin/${name}`;
}

export function validateNamedBaseRef(repository: string, baseRef: string): WorktreeAdmission {
  const root = canonicalRepository(repository);
  if (baseRef.trim() === "" || baseRef !== baseRef.trim()) throw new Error("cloud_base_branch must be a named Git ref");
  if (isRawObjectId(baseRef)) throw new Error("cloud_base_branch must be a named Git ref, not a raw SHA");

  let validRef = false;
  try {
    execFileSync("git", ["check-ref-format", "--branch", baseRef], { stdio: "ignore" });
    validRef = true;
  } catch {
    try {
      execFileSync("git", ["check-ref-format", baseRef], { stdio: "ignore" });
      validRef = true;
    } catch {
      validRef = false;
    }
  }
  if (!validRef) throw new Error(`Invalid named Git ref: ${baseRef}`);

  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (status !== "") throw new Error(`environment cloud requires a clean source worktree: ${root}`);

  let baseCommit: string;
  try {
    baseCommit = git(root, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]);
  } catch {
    throw new Error(`cloud_base_branch does not resolve to a commit: ${baseRef}`);
  }
  return { repository: root, baseRef, baseCommit };
}

function processBirth(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function readPersistedWorktree(filePath: string): PersistedWorktree | undefined {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.repository !== "string" || typeof value.baseRef !== "string" || typeof value.baseCommit !== "string" || typeof value.path !== "string" || typeof value.branch !== "string") return undefined;
  return { version: 1, repository: value.repository, baseRef: value.baseRef, baseCommit: value.baseCommit, path: value.path, branch: value.branch };
}

function writePersistedWorktree(filePath: string, metadata: PersistedWorktree): void {
  // worktree.json is an explicit writer-scope exception; resume needs the original base.
  const temporary = `${filePath}.tmp-${process.pid}`;
  const descriptor = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
}

function lockIsLive(lockPath: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < 5000;
    } catch {
      return false;
    }
  }
  if (!isRecord(raw) || typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || typeof raw.birth !== "string") return false;
  try {
    process.kill(raw.pid, 0);
  } catch {
    return false;
  }
  const birth = processBirth(raw.pid);
  return raw.birth === "unknown" || birth === undefined || birth === raw.birth;
}

async function withWorktreeLock<T>(repository: string, operation: () => Promise<T>): Promise<T> {
  const gitDirectory = git(repository, ["rev-parse", "--git-common-dir"]);
  const lockPath = path.resolve(repository, gitDirectory, "pstack-agents-worktree.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let descriptor: number | undefined;
  for (let attempt = 0; descriptor === undefined; attempt++) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!fs.existsSync(lockPath)) throw error;
      if (!lockIsLive(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      if (attempt >= 600) throw new Error(`Timed out waiting for Git worktree lock: ${lockPath}`);
      await delay(50);
    }
  }

  const lockInode = fs.fstatSync(descriptor).ino;
  try {
    const birth = processBirth(process.pid) ?? "unknown";
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, birth } satisfies LockRecord));
    fs.fsyncSync(descriptor);
    return await operation();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (fs.statSync(lockPath).ino === lockInode) fs.rmSync(lockPath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

export async function createWorktree(options: {
  repository: string;
  baseRef: string;
  runId: RunId;
  runDirectory: string;
  expectedBaseCommit?: string;
}): Promise<WorktreeResult> {
  const root = canonicalRepository(options.repository);
  const cleanStatus = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (cleanStatus !== "") throw new Error(`environment cloud requires a clean source worktree: ${root}`);
  const admission = validateNamedBaseRef(root, fetchOriginBranch(root, options.baseRef));
  return withWorktreeLock(admission.repository, async () => {
    const ref = fetchOriginBranch(admission.repository, options.baseRef);
    const rechecked = validateNamedBaseRef(admission.repository, ref);
    const branch = `pstack-agents/${options.runId}`;
    fs.mkdirSync(options.runDirectory, { recursive: true, mode: 0o700 });
    const worktreePath = path.join(fs.realpathSync(options.runDirectory), "worktree");

    if (fs.existsSync(worktreePath)) {
      const existingRoot = canonicalRepository(worktreePath);
      const existingBranch = git(worktreePath, ["branch", "--show-current"]);
      if (existingRoot === worktreePath && existingBranch === branch) {
        const metadataPath = path.join(options.runDirectory, "worktree.json");
        const persisted = readPersistedWorktree(metadataPath);
        const existingHead = git(worktreePath, ["rev-parse", "HEAD"]);
        const baseCommit = persisted?.baseCommit ?? options.expectedBaseCommit ?? rechecked.baseCommit;
        if (persisted && (persisted.repository !== rechecked.repository || persisted.baseRef !== rechecked.baseRef || persisted.path !== worktreePath || persisted.branch !== branch)) {
          throw new Error(`Existing worktree belongs to a different base or run: ${worktreePath}`);
        }
        if (options.expectedBaseCommit && options.expectedBaseCommit !== baseCommit) throw new Error(`Existing worktree base does not match its original run: ${worktreePath}`);
        if (!persisted && !options.expectedBaseCommit && existingHead !== rechecked.baseCommit) throw new Error(`Existing worktree has no base metadata and differs from the requested base: ${worktreePath}`);
        try {
          execFileSync("git", ["-C", worktreePath, "merge-base", "--is-ancestor", baseCommit, "HEAD"], { stdio: "ignore" });
        } catch {
          throw new Error(`Existing worktree no longer contains its original base commit: ${worktreePath}`);
        }
        const result = { ...rechecked, baseCommit, path: worktreePath, branch };
        if (!persisted) writePersistedWorktree(metadataPath, { version: 1, repository: result.repository, baseRef: result.baseRef, baseCommit, path: worktreePath, branch });
        return result;
      }
      throw new Error(`Worktree path already exists for another run: ${worktreePath}`);
    }

    await execFile("git", ["-C", admission.repository, "worktree", "add", "-b", branch, "--no-track", worktreePath, rechecked.baseRef]);
    const result = { ...rechecked, path: worktreePath, branch };
    writePersistedWorktree(path.join(options.runDirectory, "worktree.json"), { version: 1, repository: result.repository, baseRef: result.baseRef, baseCommit: result.baseCommit, path: worktreePath, branch });
    return result;
  });
}
