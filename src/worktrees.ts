import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { pool } from "../lib/pool.ts";
import { type Git, gitIn } from "./git.ts";
import { artifacts, fail, hasErrorCode, result, stringEnum } from "./support.ts";

export interface Worktree {
  path: string;
  head?: string | undefined;
  branch?: string | undefined;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
}
export function parseWorktrees(porcelain: string): Worktree[] {
  const separator = porcelain.includes("\0") ? "\0" : "\n";
  return porcelain
    .split(separator.repeat(2))
    .filter(Boolean)
    .map((block) => {
      const fields = new Map(
        block
          .split(separator)
          .filter(Boolean)
          .map((line): [string, string] => {
            const i = line.indexOf(" ");
            return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
          }),
      );
      return {
        path: fields.get("worktree") ?? "",
        head: fields.get("HEAD"),
        branch: fields.get("branch"),
        locked: fields.has("locked"),
        prunable: fields.has("prunable"),
        bare: fields.has("bare"),
      };
    });
}

function ancestry(exitCode: number | undefined) {
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  return null;
}

const validName = (name: string) => /^[a-z0-9][a-z0-9-]{0,48}$/.test(name);

async function commit(git: Git, ref: string) {
  if (ref.startsWith("-")) fail("Invalid base ref");
  return (await git.run(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}
async function targetBranch(git: Git, ref: string) {
  if (ref.startsWith("-")) fail("Invalid base ref");
  const name = (await git.run(["rev-parse", "--verify", "--symbolic-full-name", ref])).trim();
  if (!/^refs\/(heads|remotes)\//.test(name)) fail("Merged target must be a branch");
  return name;
}
const list = async (git: Git) =>
  parseWorktrees(await git.run(["worktree", "list", "--porcelain", "-z"]));
const status = (git: Git, tree: string) =>
  git.run(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], tree);
async function ignoredPaths(git: Git, tree: string) {
  const args = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"];
  return (await git.run(args, tree)).split("\0").filter(Boolean);
}

export async function createWorktree(git: Git, ctx: ExtensionContext, name: string, ref = "HEAD") {
  if (!validName(name)) fail("Invalid worktree name");
  const base = await commit(git, ref);
  const requested = join(artifacts(ctx), "worktrees", name);
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  const path = join(await realpath(dirname(requested)), name);
  await git.run(["worktree", "add", "--detach", path, base]);
  return { path, base };
}

async function audit(git: Git, ref: string, active: ReadonlySet<string>) {
  const trees = await list(git);
  const base = await commit(git, ref);
  return pool(trees, 4, async (tree) => {
    const inspectable = !tree.bare && !tree.prunable;
    const dirty = inspectable ? !!(await status(git, tree.path)) : null;
    const ignored = inspectable ? (await ignoredPaths(git, tree.path)).length : null;
    const ancestor = tree.head
      ? await git.probe(["merge-base", "--is-ancestor", tree.head, base])
      : undefined;
    return {
      ...tree,
      dirty,
      ignored,
      merged: ancestry(ancestor?.code),
      activeWorker: active.has(tree.path),
      base,
      ownership: "Confirm active or pinned Pi sessions before removal",
    };
  });
}

function assertRemovable(
  tree: Worktree | undefined,
  path: string,
  active: ReadonlySet<string>,
): asserts tree is Worktree & { head: string } {
  if (!tree?.head || tree.branch || tree.locked || tree.prunable || tree.bare || active.has(path)) {
    fail("Not a removable inactive package-owned detached tree");
  }
}

function removalPrompt(ignored: string[]) {
  if (!ignored.length) return { title: "Remove clean merged worktree?", loss: "" };
  const shown = ignored.slice(0, 10).join("\n");
  const more = ignored.length > 10 ? `\n… and ${ignored.length - 10} more` : "";
  return {
    title: "Remove merged worktree and its ignored files?",
    loss: `\nThis permanently deletes ${ignored.length} ignored path(s) Git does not track:\n${shown}${more}`,
  };
}

async function removeWorktree(
  git: Git,
  ctx: ExtensionContext,
  name: string,
  ref: string | undefined,
  active: ReadonlySet<string>,
) {
  if (!validName(name)) fail("Invalid name");
  if (!ctx.hasUI) fail("Removal not authorized without an interactive Pi UI");
  if (!ref) fail("Specify merged target ref");
  const directory = await realpath(join(artifacts(ctx), "worktrees")).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) fail("No package-owned worktrees in this session");
    throw error;
  });
  const path = join(directory, name);
  async function inspect() {
    const tree = (await list(git)).find((entry) => entry.path === path);
    assertRemovable(tree, path, active);
    if (await status(git, path)) fail("Worktree has uncommitted changes");
    return { head: tree.head, ignored: await ignoredPaths(git, path) };
  }
  const target = await targetBranch(git, ref);
  const base = await commit(git, target);
  const { head, ignored } = await inspect();
  await git.run(["merge-base", "--is-ancestor", head, base]);
  const { title, loss } = removalPrompt(ignored);
  const approved = await ctx.ui.confirm(
    title,
    `${path}\nHEAD ${head} is merged into ${target} (${base}).${loss}\nConfirm no active or pinned session uses this path.`,
  );
  if (!approved) fail("Removal not authorized");
  const after = await inspect();
  if (
    after.head !== head ||
    after.ignored.join("\0") !== ignored.join("\0") ||
    (await commit(git, target)) !== base ||
    active.has(path)
  ) {
    fail("Worktree or target ref changed after approval");
  }
  await git.run(["worktree", "remove", path]);
  return { removed: path };
}

export function registerWorktrees(pi: ExtensionAPI, active: ReadonlySet<string>) {
  pi.registerTool({
    name: "pstack_worktree",
    label: "Pstack worktree",
    description:
      "Audit Git worktrees or create a new detached isolated worktree from HEAD. Audit reports ignored paths. Removal requires explicit user approval and a clean package-owned detached tree merged into a branch; the approval lists ignored files that would be deleted.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: stringEnum(["audit", "create", "remove"]),
      name: Type.Optional(Type.String()),
      base: Type.Optional(Type.String()),
    }),
    async execute(_id, p, signal, _update, ctx) {
      const git = gitIn(pi, ctx.cwd, signal);
      if (p.action === "create")
        return result(await createWorktree(git, ctx, p.name ?? "", p.base));
      if (p.action === "audit") return result(await audit(git, p.base ?? "HEAD", active));
      return result(await removeWorktree(git, ctx, p.name ?? "", p.base, active));
    },
  });
}
