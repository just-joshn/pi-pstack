import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { pool } from "../lib/pool.ts";
import { gitIn, type Git } from "./git.ts";
import { fail } from "./support.ts";

const diffBytes = 2 * 1024 * 1024;
const untrackedLimit = 500;

export interface ParentDiff {
  path: string;
  omitted: string[];
}

async function untrackedFiles(git: Git) {
  const top = await git.probe(["rev-parse", "--show-toplevel"]);
  if (top?.code !== 0) return undefined;
  const repo = top.stdout.trim();
  const listed = await git.probe(["ls-files", "--others", "--exclude-standard", "-z"], repo);
  if (listed?.code !== 0) return undefined;
  return { repo, files: listed.stdout.split("\0").filter(Boolean) };
}

async function collect(git: Git) {
  const tracked = await git.probe(["diff", "HEAD"]);
  const untracked = await untrackedFiles(git);
  if (tracked?.code !== 0 || !untracked) return undefined;
  const { repo, files } = untracked;
  const patches = await pool(files.slice(0, untrackedLimit), 8, async (file) => {
    const r = await git.probe(["diff", "--no-index", "--", "/dev/null", file], repo);
    if (!r || r.code > 1) fail(`unreadable ${file}`);
    return r.stdout;
  });
  let diff = tracked.stdout;
  const omitted = files.slice(untrackedLimit);
  patches.forEach((patch, i) => {
    if (patch.status === "fulfilled" && diff.length + patch.value.length <= diffBytes)
      diff += patch.value;
    else omitted.push(files[i]);
  });
  return { diff, omitted };
}

export async function saveParentDiff(
  pi: ExtensionAPI,
  cwd: string,
  dir: string,
  signal?: AbortSignal,
): Promise<ParentDiff | undefined> {
  const collected = await collect(gitIn(pi, cwd, signal, diffBytes));
  if (!collected) return undefined;
  const path = join(dir, "parent.diff");
  await writeFile(path, collected.diff, { mode: 0o600 });
  return { path, omitted: collected.omitted };
}
