import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { gitIn } from "./git.ts";

const diffBytes = 2 * 1024 * 1024;
const untrackedLimit = 500;

export interface ParentDiff {
  path: string;
  omitted: string[];
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
  const [tracked, listed] = await Promise.all([
    git.probe(["diff", "--no-relative", "HEAD"], repo),
    git.probe(["ls-files", "--others", "--exclude-standard", "-z"], repo),
  ]);
  if (tracked?.code !== 0 || listed?.code !== 0) return undefined;
  const files = listed.stdout.split("\0").filter(Boolean);
  let remaining = diffBytes - Buffer.byteLength(tracked.stdout);
  if (remaining < 0) return undefined;
  const kept = [tracked.stdout];
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
    for (const [i, patch] of patches.entries()) {
      const r = patch.status === "fulfilled" ? patch.value : undefined;
      if (r && (r.code === 0 || r.code === 1)) {
        const bytes = Buffer.byteLength(r.stdout);
        if (bytes <= remaining) {
          kept.push(r.stdout);
          remaining -= bytes;
          continue;
        }
      }
      omitted.push(batch[i]);
    }
    next += batch.length;
  }
  const path = join(dir, "parent.diff");
  await writeFile(path, kept.join(""), { mode: 0o600 });
  return { path, omitted: omitted.concat(files.slice(next)) };
}
