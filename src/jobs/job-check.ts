import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { srcDir } from "../lib/catalog.ts";
import { isRecord } from "../lib/validation.ts";
import { type Job, readJob } from "./job-input.ts";

const git = promisify(execFile);

/**
 * Fetches `origin/<branch>` into a ref only this caller uses. Runs fetching the same repository at
 * once otherwise collide on the remote-tracking ref and FETCH_HEAD.
 */
export async function fetchBranch(repository: string, branch: string, ref: string) {
  const refspec = `+refs/heads/${branch}:${ref}`;
  const args = ["fetch", "--quiet", "--no-write-fetch-head", "--refmap=", "origin", refspec];
  await git("git", ["-C", repository, ...args]);
}
export const deleteRef = (repository: string, ref: string) =>
  git("git", ["-C", repository, "update-ref", "-d", ref]);

export const sharedSkills = [
  "why",
  "tdd",
  "unslop",
  "principle-separate-before-serializing-shared-state",
  "principle-minimize-reader-load",
  "principle-guard-the-context-window",
  "principle-sequence-verifiable-units",
  "principle-fix-root-causes",
  "principle-prove-it-works",
];
const pack = ".pi/automations/benny";
const packSource = join(srcDir, "automations", "benny");
const packFiles = (await readdir(packSource, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => `${pack}/${relative(packSource, join(entry.parentPath, entry.name))}`);

function requiredFiles(job: Job) {
  const named = job.instructions.match(/\.pi\/[\w./-]*\w/g) ?? [];
  return [...new Set([".pi/settings.json", ...packFiles, ...named])];
}

async function committed(repository: string, ref: string, files: string[]) {
  const checks = await Promise.allSettled(
    files.map((file) => git("git", ["-C", repository, "cat-file", "-e", `${ref}:${file}`])),
  );
  return files.filter((_, i) => checks[i]?.status === "rejected");
}

function jsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

async function skillSources(piBin: string, cwd: string) {
  const child = spawn(piBin, ["--mode", "rpc", "--no-session", "--approve", "--no-extensions"], {
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let failure: unknown;
  child.on("error", (error) => (failure = error));
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout });
  child.stdin.end(`${JSON.stringify({ id: "check", type: "get_commands" })}\n`);
  try {
    for await (const line of lines) {
      const response = jsonLine(line);
      if (!isRecord(response) || response["id"] !== "check") continue;
      const data = response["data"];
      const commands = isRecord(data) && Array.isArray(data["commands"]) ? data["commands"] : [];
      return new Map(
        commands.filter(isRecord).map((c) => {
          const info = isRecord(c["sourceInfo"]) ? c["sourceInfo"] : {};
          return [String(c["name"]), { scope: info["scope"], path: info["path"] }];
        }),
      );
    }
    if (failure) throw failure;
    return new Map<string, { scope: unknown; path: unknown }>();
  } finally {
    child.kill();
    await closed;
  }
}

export async function projectSkills(cwd: string, piBin = process.env["PSTACK_PI_BIN"] ?? "pi") {
  const sources = await skillSources(piBin, cwd);
  const files = new Map<string, string>();
  for (const skill of sharedSkills) {
    const source = sources.get(`skill:${skill}`);
    if (source?.scope === "project" && typeof source.path === "string")
      files.set(skill, source.path);
  }
  return { files, unresolved: sharedSkills.filter((s) => !files.has(s)) };
}

export async function checkJob(path: string, piBin = process.env["PSTACK_PI_BIN"] ?? "pi") {
  const job = await readJob(path, { draft: true });
  if (job.kind === "custom") throw Error("Only Benny jobs are checked");
  const branch = job.config.defaultBranch;
  const ref = `refs/pstack/check/${randomUUID()}`;
  await fetchBranch(job.cwd, branch, ref);
  const checkout = join(await mkdtemp(join(tmpdir(), "pstack-benny-check-")), "checkout");
  try {
    const uncommitted = await committed(job.cwd, ref, requiredFiles(job));
    await git("git", ["-C", job.cwd, "worktree", "add", "--quiet", "--detach", checkout, ref]);
    const { unresolved } = await projectSkills(checkout, piBin);
    return {
      ok: !uncommitted.length && !unresolved.length,
      branch: `origin/${branch}`,
      uncommitted,
      unresolved,
    };
  } finally {
    await rm(join(checkout, ".."), { recursive: true, force: true });
    await git("git", ["-C", job.cwd, "worktree", "prune"]);
    await deleteRef(job.cwd, ref);
  }
}
