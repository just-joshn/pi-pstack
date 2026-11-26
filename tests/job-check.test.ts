import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { test } from "vitest";

import { checkJob, projectSkills, sharedSkills } from "../src/jobs/job-check.ts";
import { srcDir } from "../src/lib/catalog.ts";
import { sandbox } from "./host.ts";
import { spawned } from "./support.ts";

const fakePi = `#!/usr/bin/env node
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id } = JSON.parse(line);
  const scope = require("node:fs").existsSync(".pi/settings.json") ? "project" : "user";
  const commands = ${JSON.stringify(sharedSkills)}.map((s) => ({ name: "skill:" + s, sourceInfo: { scope, path: "/pstack/" + s + "/SKILL.md" } }));
  console.log("not json is skipped");
  console.log(JSON.stringify({ type: "response", id: "other", data: {} }));
  console.log(JSON.stringify({ type: "response", id, data: { commands: [...commands, "noise"] } }));
});
setTimeout(() => {}, 60000);
`;
const git = (cwd: string, ...args: string[]) => spawned("git", ["-C", cwd, ...args]);
const pack = ".pi/automations/benny";

async function target(files: string[], instructions = "Read `.pi/benny/configuration.yaml`.") {
  const dir = await mkdtemp(join(sandbox, "job-check-"));
  const origin = join(dir, "origin");
  await git(dir, "init", "--quiet", "--initial-branch=main", origin);
  await Promise.all(
    files.map(async (file) => {
      await mkdir(join(origin, file, ".."), { recursive: true });
      await writeFile(join(origin, file), "x");
    }),
  );
  await git(origin, "add", ".");
  await git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "m");
  const clone = join(dir, "clone");
  await git(dir, "clone", "--quiet", origin, clone);
  const fake = join(dir, "fake-pi");
  await writeFile(fake, fakePi, { mode: 0o700 });
  const job = join(dir, "benny-triage.job.json");
  const config = { sourceChannel: "C1", defaultBranch: "main" };
  const fields = { kind: "benny-triage", cwd: clone, tools: ["mcp__slack__*"], config };
  await writeFile(job, JSON.stringify({ version: 1, enabled: false, instructions, ...fields }));
  return { clone, fake, job };
}
const packFiles = (
  await readdir(join(srcDir, "automations", "benny"), { recursive: true, withFileTypes: true })
)
  .filter((e) => e.isFile())
  .map(
    (e) => `${pack}/${relative(join(srcDir, "automations", "benny"), join(e.parentPath, e.name))}`,
  );
const complete = [".pi/settings.json", ".pi/benny/configuration.yaml", ...packFiles];

test("a committed pack whose checkout gets the shared skills from project scope passes", async () => {
  const { clone, fake, job } = await target(complete);
  const report = await checkJob(job, fake);
  assert.deepEqual(report, { ok: true, branch: "origin/main", uncommitted: [], unresolved: [] });
  const trees = await git(clone, "worktree", "list", "--porcelain");
  assert.equal(trees.stdout.match(/^worktree /gm)?.length, 1, "the check removes its checkout");
});

test("an uncommitted file the job needs, or a skill from outside the project, fails", async () => {
  const { fake, job } = await target(complete.filter((f) => !f.endsWith("configuration.yaml")));
  assert.deepEqual((await checkJob(job, fake)).uncommitted, [".pi/benny/configuration.yaml"]);
  const bare = await target(complete.slice(1));
  const report = await checkJob(bare.job, bare.fake);
  assert.equal(report.ok, false);
  assert.deepEqual(report.uncommitted, [".pi/settings.json"]);
  assert.deepEqual(report.unresolved, sharedSkills);
});

test("the working-tree check reports skills not from project scope", async () => {
  const { clone, fake } = await target([".pi/settings.json"]);
  const found = await projectSkills(clone, fake);
  assert.deepEqual(found.unresolved, []);
  assert.equal(found.files.get("why"), "/pstack/why/SKILL.md");
  assert.deepEqual((await projectSkills(join(clone, ".pi"), fake)).unresolved, sharedSkills);
});

test("only Benny jobs are checked", async () => {
  const { job, fake } = await target(complete);
  const custom = join(job, "..", "custom.json");
  await writeFile(
    custom,
    JSON.stringify({ version: 1, kind: "custom", cwd: "/tmp", tools: ["read"], instructions: "x" }),
  );
  await assert.rejects(checkJob(custom, fake), /Only Benny jobs are checked/);
});

test("a Pi that exits without answering, or answers without commands, resolves nothing", async () => {
  const { clone, fake } = await target([]);
  const silent = join(fake, "..", "silent-pi");
  await writeFile(silent, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.deepEqual((await projectSkills(clone, silent)).unresolved, sharedSkills);
  const empty = join(fake, "..", "empty-pi");
  const answer = JSON.stringify({ type: "response", id: "check", data: null });
  await writeFile(empty, `#!/bin/sh\nread line\necho '${answer}'\n`, { mode: 0o700 });
  assert.deepEqual((await projectSkills(clone, empty)).unresolved, sharedSkills);
});

test("a Pi that cannot start is an error, not an empty skill list", async () => {
  const { clone } = await target([]);
  await assert.rejects(projectSkills(clone, join(clone, "no-such-pi")), { code: "ENOENT" });
});

test("the check requires every file of the pack, such as the control-adapter reference", async () => {
  const adapter = `${pack}/skills/reproduce-and-fix-issues/references/control-adapter.md`;
  const { fake, job } = await target(complete.filter((f) => f !== adapter));
  assert.deepEqual((await checkJob(job, fake)).uncommitted, [adapter]);
});

test("a referenced path with spaces is checked whole, in backticks or on its own line", async () => {
  const instructions = "Read `.pi/benny/my config.json`.\n\n```text\n.pi/benny/route map.md\n```\n";
  const { fake, job } = await target(complete, instructions);
  assert.deepEqual((await checkJob(job, fake)).uncommitted, [
    ".pi/benny/my config.json",
    ".pi/benny/route map.md",
  ]);
});
