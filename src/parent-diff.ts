import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type Git, gitIn } from "./git.ts";

const diffBytes = 2 * 1024 * 1024;
const untrackedLimit = 500;

export interface ParentDiff {
  path: string;
  /** The commit the tracked diff starts from. */
  base: string;
  omitted: string[];
}

/** The merge base with the remote's default branch, so committed branch work is included. */
async function diffBase(git: Git, repo: string) {
  const branch = await git.probe(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repo);
  if (branch?.code !== 0) return "HEAD";
  const base = await git.probe(["merge-base", "HEAD", branch.stdout.trim()], repo);
  return base?.code === 0 ? base.stdout.trim() : "HEAD";
}

async function untrackedPatches(git: Git, repo: string, files: string[], budget: number) {
  let remaining = budget;
  const kept: string[] = [];
  const omitted: string[] = [];
  const limit = Math.min(files.length, untrackedLimit);
  let next = 0;
  while (next < limit && remaining > 0) {
    const batch = files.slice(next, Math.min(next + 8, limit));
    // oxlint-disable-next-line eslint/no-await-in-loop -- Apply the byte budget before fetching another batch.
    const patches = await Promise.allSettled(
      batch.map((file) =>
        git.probe(["diff", "--no-index", "--", "/dev/null", file], repo, remaining),
      ),
    );
    for (const [i, file] of batch.entries()) {
      const patch = patches[i];
      const r = patch?.status === "fulfilled" ? patch.value : undefined;
      if (r && (r.code === 0 || r.code === 1)) {
        const bytes = Buffer.byteLength(r.stdout);
        if (bytes <= remaining) {
          kept.push(r.stdout);
          remaining -= bytes;
          continue;
        }
      }
      omitted.push(file);
    }
    next += batch.length;
  }
  return { kept, omitted: omitted.concat(files.slice(next)) };
}

export async function saveParentDiff(
  pi: ExtensionAPI,
  cwd: string,
  dir: string,
  signal?: AbortSignal,
): Promise<ParentDiff | undefined> {
  const git = gitIn(pi, cwd, signal, diffBytes);
  const top = await git.probe(["rev-parse", "--show-toplevel"]);
  if (top?.code !== 0) return undefined;
  const repo = top.stdout.replace(/\r?\n$/, "");
  const base = await diffBase(git, repo);
  const [tracked, listed] = await Promise.all([
    git.probe(["diff", "--no-relative", base], repo),
    git.probe(["ls-files", "--others", "--exclude-standard", "-z"], repo),
  ]);
  if (tracked?.code !== 0 || listed?.code !== 0) return undefined;
  const remaining = diffBytes - Buffer.byteLength(tracked.stdout);
  if (remaining < 0) return undefined;
  const files = listed.stdout.split("\0").filter(Boolean);
  const { kept, omitted } = await untrackedPatches(git, repo, files, remaining);
  const path = join(dir, "parent.diff");
  await writeFile(path, [tracked.stdout, ...kept].join(""), { mode: 0o600 });
  return { path, base, omitted };
}
