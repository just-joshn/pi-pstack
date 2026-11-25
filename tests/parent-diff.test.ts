import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onTestFinished, test } from "vitest";

import { saveParentDiff } from "../src/parent-diff.ts";
import { delegated, host, swarm } from "./host.ts";
import { commit, git, repo } from "./repo.ts";
import { double, nth } from "./support.ts";

const ran = (code: number, stdout: string) => ({
  code,
  stdout,
  stderr: "",
  killed: false,
  truncated: false,
});

type Answer = ReturnType<typeof ran>;
interface Checkout {
  /** The diff of the tracked files against HEAD. */
  tracked: Answer;
  /** The NUL-separated untracked files. */
  listed: Answer;
  untracked: (file: string) => Answer;
}
const readable: Checkout = {
  tracked: ran(0, "+tracked\n"),
  listed: ran(0, "new.txt"),
  untracked: () => ran(1, "+new\n"),
};

async function save(checkout: Checkout) {
  const dir = await mkdtemp(join(tmpdir(), "parent-diff-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const pi = double<ExtensionAPI>({
    exec: async (_command, args) => {
      if (args[0] === "rev-parse") return ran(0, dir + "\n");
      if (args[0] === "symbolic-ref") return ran(1, "");
      if (args[0] === "ls-files") return checkout.listed;
      if (!args.includes("--no-index")) return checkout.tracked;
      return checkout.untracked(args.at(-1) ?? "");
    },
  });
  const diff = await saveParentDiff(pi, dir, dir);
  return { diff, written: await readdir(dir) };
}
async function capture(tracked: string, patches: Record<string, string>) {
  const visited: string[] = [];
  const { diff } = await save({
    tracked: ran(0, tracked),
    listed: ran(0, Object.keys(patches).join("\0")),
    untracked: (file) => {
      visited.push(file);
      return ran(1, patches[file] ?? "");
    },
  });
  assert(diff);
  return { bytes: await readFile(diff.path), omitted: diff.omitted, visited };
}

test("the diff budget counts UTF-8 bytes and keeps later whole patches that fit", async () => {
  const text = "界".repeat(350000);
  const { bytes, omitted } = await capture(text, {
    small: "+ok\n",
    oversized: text,
    later: "+end\n",
  });
  assert.deepEqual(omitted, ["oversized"]);
  assert(bytes.equals(Buffer.from(text + "+ok\n+end\n")));
});

test("a full artifact omits the remaining files without reading every patch", async () => {
  const patch = "x".repeat(256 * 1024);
  const files = Array.from({ length: 32 }, (_, i) => `file${i}`);
  const { bytes, omitted, visited } = await capture(
    "",
    Object.fromEntries(files.map((file) => [file, patch])),
  );
  assert.equal(bytes.length, 2 * 1024 * 1024);
  assert.deepEqual(omitted, files.slice(8));
  assert(visited.length < files.length);
});

test("nothing is saved when Git cannot diff the tracked files or list the untracked ones", async () => {
  const failed = ran(128, "");
  assert.deepEqual(await save({ ...readable, tracked: failed }), {
    diff: undefined,
    written: [],
  });
  assert.deepEqual(await save({ ...readable, listed: failed }), { diff: undefined, written: [] });
  const saved = await save(readable);
  assert.deepEqual(saved.written, ["parent.diff"]);
  assert.equal(saved.diff?.base, "HEAD");
});

test("a tracked diff larger than the budget is not saved in part", async () => {
  const oversized = ran(0, "x".repeat(2 * 1024 * 1024 + 1));
  const saved = await save({ ...readable, tracked: oversized });
  assert.deepEqual(saved, { diff: undefined, written: [] });
});

test("an untracked file that Git cannot diff is omitted and the others are kept", async () => {
  const { diff } = await save({
    tracked: ran(0, ""),
    listed: ran(0, ["unstarted", "unreadable", "fine"].join("\0")),
    untracked: (file) => {
      if (file === "unstarted") throw Error("spawn git EAGAIN");
      return file === "unreadable" ? ran(128, "fatal") : ran(1, "+fine\n");
    },
  });
  assert.deepEqual(diff?.omitted, ["unstarted", "unreadable"]);
  assert.equal(await readFile(diff.path, "utf8"), "+fine\n");
});

test("the parent diff includes root-relative tracked and untracked paths from a subdirectory", async () => {
  const cwd = await repo();
  const subdir = join(cwd, "pkg");
  await mkdir(subdir);
  await writeFile(join(subdir, "local.txt"), "old\n");
  await writeFile(join(cwd, "tracked.txt"), "one\n");
  await git(cwd, "add", ".");
  await commit(cwd, "tracked");
  await git(cwd, "config", "diff.relative", "true");
  await writeFile(join(subdir, "local.txt"), "new\n");
  await writeFile(join(cwd, "tracked.txt"), "two\n");
  await writeFile(join(cwd, "fresh.txt"), "brand new\n");
  const prompts: string[] = [];
  const h = host({
    cwd: subdir,
    realGit: true,
    execute: async (_, args) => {
      prompts.push(args.at(-1) ?? "");
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  const output = delegated(await h.call("pstack_delegate", swarm));
  const diff = await readFile(join(output.dir, "parent.diff"), "utf8");
  assert.match(diff, /diff --git a\/pkg\/local\.txt b\/pkg\/local\.txt/);
  assert.match(diff, /\+two/);
  assert.match(diff, /fresh\.txt/);
  assert.match(diff, /\+brand new/);
  assert.match(nth(prompts, 0), /tracked changes and untracked files/);
  assert.doesNotMatch(nth(prompts, 0), /omitted/);
});

test("committed branch work since the default branch reaches reviewers in the parent diff", async () => {
  const cwd = await repo();
  const base = (await git(cwd, "rev-parse", "HEAD")).trim();
  await git(cwd, "update-ref", "refs/remotes/origin/main", base);
  await git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git(cwd, "switch", "-qc", "feature");
  await writeFile(join(cwd, "feature.txt"), "committed work\n");
  await git(cwd, "add", ".");
  await commit(cwd, "feature");
  const prompts: string[] = [];
  const h = host({
    cwd,
    realGit: true,
    execute: async (_, args) => {
      prompts.push(args.at(-1) ?? "");
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  const output = delegated(await h.call("pstack_delegate", swarm));
  const diff = await readFile(join(output.dir, "parent.diff"), "utf8");
  assert.match(diff, /\+committed work/);
  assert.match(nth(prompts, 0), new RegExp(`changes since ${base}`));
});
