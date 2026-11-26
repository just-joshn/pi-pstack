import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { isRecord } from "../lib/validation.ts";
import { type Job, readJob } from "./job-input.ts";

const git = promisify(execFile);

/** The pstack skills Benny's operational files use, which setup-benny checks resolve from project scope. */
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
const operational = {
  "benny-triage": `${pack}/skills/triage-issue-reports/SKILL.md`,
  "benny-repro": `${pack}/skills/reproduce-and-fix-issues/SKILL.md`,
};

/** The project files a run needs: settings, the pack's entry points, and every `.pi/` path the prompt names. */
function requiredFiles(job: Exclude<Job, { kind: "custom" }>) {
  const named = job.instructions.match(/\.pi\/[\w./-]*\w/g) ?? [];
  return [
    ...new Set([
      ".pi/settings.json",
      `${pack}/FOR_AGENTS.md`,
      `${pack}/skills/setup-benny/SKILL.md`,
      operational[job.kind],
      ...named,
    ]),
  ];
}

async function committed(repository: string, files: string[]) {
  const checks = await Promise.allSettled(
    files.map((file) => git("git", ["-C", repository, "cat-file", "-e", `FETCH_HEAD:${file}`])),
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

/** Each skill command's scope and file in a fresh Pi rooted at `cwd`, as Pi's RPC get_commands reports them. */
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

/**
 * The file of each shared skill that a fresh Pi rooted at `cwd`, trusting the project for one run,
 * gets from project scope, and the shared skills it does not.
 */
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

/**
 * Checks a Benny job before it is enabled: the files its runs read are committed on the default
 * branch, and a fresh Pi in a checkout of that branch gets pstack's shared skills from project scope.
 */
export async function checkJob(path: string, piBin = process.env["PSTACK_PI_BIN"] ?? "pi") {
  const job = await readJob(path, { draft: true });
  if (job.kind === "custom") throw Error("Only Benny jobs are checked");
  const branch = job.config.defaultBranch;
  await git("git", ["-C", job.cwd, "fetch", "--quiet", "origin", branch]);
  const uncommitted = await committed(job.cwd, requiredFiles(job));
  const checkout = join(await mkdtemp(join(tmpdir(), "pstack-benny-check-")), "checkout");
  await git("git", [
    "-C",
    job.cwd,
    "worktree",
    "add",
    "--quiet",
    "--detach",
    checkout,
    "FETCH_HEAD",
  ]);
  try {
    const { unresolved } = await projectSkills(checkout, piBin);
    return {
      ok: !uncommitted.length && !unresolved.length,
      branch: `origin/${branch}`,
      uncommitted,
      unresolved,
    };
  } finally {
    await git("git", ["-C", job.cwd, "worktree", "remove", "--force", checkout]);
    await rm(join(checkout, ".."), { recursive: true, force: true });
  }
}
