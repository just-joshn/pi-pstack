import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, test } from "vitest";

import { type Host, host, sandbox } from "./host.ts";
import { audited, audits, commit, created, git, repo } from "./repo.ts";
import { nth } from "./support.ts";

const worktree = (h: Host, request: object) => h.call("pstack_worktree", request);
const fixture = { name: "fixture", base: "HEAD" };

describe("worktrees", () => {
  test("names and refs that Git could read as options or paths are refused before Git runs", async () => {
    const h = host({ confirm: true });
    const create = (request: object) => worktree(h, { action: "create", ...request });
    const remove = (request: object) => worktree(h, { action: "remove", ...request });
    await assert.rejects(() => create({ name: "../escape" }), /Invalid worktree name/);
    await assert.rejects(() => create({}), /Invalid worktree name/);
    await assert.rejects(() => create({ ...fixture, base: "--upload-pack=sh" }), /Invalid base/);
    await assert.rejects(() => remove({ ...fixture, name: "-rf" }), /Invalid name/);
    await assert.rejects(() => remove({ base: "HEAD" }), /Invalid name/);
    await assert.rejects(() => remove({ name: "fixture" }), /Specify merged target ref/);
    assert.equal(h.executions.length, 0);
  });

  test("removal is refused in a session that has created no worktree", async () => {
    const h = host({ confirm: true });
    await assert.rejects(
      () => worktree(h, { action: "remove", ...fixture }),
      /No package-owned worktrees in this session/,
    );
    assert.equal(h.executions.length, 0);
  });

  test("an option-like ref is refused as an audit base and as a removal target", async () => {
    const cwd = await repo();
    const h = host({ cwd, realGit: true, confirm: true });
    const tree = created(await worktree(h, { action: "create", name: "fixture" }));
    await assert.rejects(() => worktree(h, { action: "audit", base: "--all" }), /Invalid base/);
    await assert.rejects(
      () => worktree(h, { action: "remove", ...fixture, base: "--all" }),
      /Invalid base/,
    );
    assert.equal((await git(tree.path, "rev-parse", "HEAD")).trim(), tree.base);
  });

  test("an audit tells an unmerged tree from a merged one and reports a missing one as uninspected", async () => {
    const cwd = await repo();
    const h = host({ cwd, realGit: true });
    const ahead = created(await worktree(h, { action: "create", name: "ahead" }));
    await commit(ahead.path, "only in the worktree");
    const gone = created(await worktree(h, { action: "create", name: "gone" }));
    await rm(gone.path, { recursive: true });
    const audit = await worktree(h, { action: "audit" });
    assert.equal(audited(audit, ahead.path)?.merged, false);
    const missing = audited(audit, gone.path);
    assert.equal(missing?.prunable, true);
    assert.equal(missing.merged, true);
    assert.equal(missing.dirty, null);
    assert.equal(missing.ignored, null);
  });

  test("a bare repository is listed in an audit without being inspected", async () => {
    const source = await repo();
    const bare = await mkdtemp(join(sandbox, "bare-"));
    await git(source, "clone", "-q", "--bare", source, bare);
    const h = host({ cwd: bare, realGit: true });
    const entries = audits(await worktree(h, { action: "audit" }));
    assert.equal(entries.length, 1);
    const entry = nth(entries, 0);
    assert.equal(entry.bare, true);
    assert.equal(entry.merged, null);
    assert.equal(entry.dirty, null);
    assert.equal(entry.ignored, null);
  });

  test("the removal prompt names ten ignored paths and counts the rest", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, ".gitignore"), "*.log\n");
    await git(cwd, "add", ".gitignore");
    await commit(cwd, "ignore logs");
    const prompts: string[] = [];
    const h = host({
      cwd,
      realGit: true,
      confirm: (_title, message) => {
        prompts.push(message);
        return false;
      },
    });
    const tree = created(await worktree(h, { action: "create", name: "fixture" }));
    const logs = Array.from({ length: 12 }, (_, i) => `run-${String(i).padStart(2, "0")}.log`);
    await Promise.all(logs.map((log) => writeFile(join(tree.path, log), "")));
    await assert.rejects(
      () => worktree(h, { action: "remove", ...fixture }),
      /Removal not authorized/,
    );
    const prompt = nth(prompts, 0);
    assert.match(prompt, /deletes 12 ignored path\(s\)/);
    assert.equal(logs.filter((log) => prompt.includes(`\n${log}\n`)).length, 10);
    assert.match(prompt, /\.log\n… and 2 more\n/);
    const kept = (await readdir(tree.path)).filter((file) => file.endsWith(".log"));
    assert.deepEqual(kept.toSorted(), logs);
  });
});
