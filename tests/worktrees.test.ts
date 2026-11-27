import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { test } from "vitest";

import { busyPaths, parseWorktrees } from "../src/worktrees.ts";
import { type Host, host, sandbox } from "./host.ts";
import { audited, audits, commit, created, git, removed, repo } from "./repo.ts";
import { nth } from "./support.ts";

const worktree = (h: Host, request: object) => h.call("pstack_worktree", request);
const fixture = { name: "fixture", base: "HEAD" };

test("a path stays busy until both overlapping workers finish", async () => {
	const active = busyPaths();
	const path = "/worktree";
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const failed = active.hold(path, () => first.promise);
	const running = active.hold(path, () => second.promise);
	const error = new Error("Worker stopped");
	try {
		first.reject(error);
		await assert.rejects(failed, error);
		assert.equal(active.has(path), true);
	} finally {
		second.resolve();
		await running;
	}
	assert.equal(active.has(path), false);
});

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
	await assert.rejects(() => worktree(h, { action: "remove", ...fixture, base: "--all" }), /Invalid base/);
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
	await assert.rejects(() => worktree(h, { action: "remove", ...fixture }), /Removal not authorized/);
	const prompt = nth(prompts, 0);
	assert.match(prompt, /deletes 12 ignored path\(s\)/);
	assert.equal(logs.filter((log) => prompt.includes(`\n${log}\n`)).length, 10);
	assert.match(prompt, /\.log\n… and 2 more\n/);
	const kept = (await readdir(tree.path)).filter((file) => file.endsWith(".log"));
	assert.deepEqual(kept.toSorted(), logs);
});

test("a truncated Git worktree list is not accepted as complete", async () => {
	const h = host({
		execute: async () => ({ code: 0, truncated: true, stdout: "", stderr: "" }),
	});
	await assert.rejects(() => h.call("pstack_worktree", { action: "audit" }), /git worktree.*truncated/);
});

test("real Git detached worktree audit and approved RPC removal; dirty tree is protected", async () => {
	const cwd = await repo();
	const h = host({ mode: "rpc", confirm: true, cwd, realGit: true });
	const made = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
	const clean = audited(await h.call("pstack_worktree", { action: "audit" }), made.path);
	assert.equal(clean?.merged, true);
	assert.equal(clean.dirty, false);
	const dirty = join(made.path, "dirty.txt");
	await writeFile(dirty, "keep");
	await git(cwd, "config", "status.showUntrackedFiles", "no");
	const changed = audited(await h.call("pstack_worktree", { action: "audit" }), made.path);
	assert.equal(changed?.dirty, true);
	await assert.rejects(
		() => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
		/uncommitted/,
	);
	await unlink(dirty);
	assert.equal(
		removed(await h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" })),
		made.path,
	);
});

test("worktree removal stops if the target ref changes during approval", async () => {
	const cwd = await repo();
	const h = host({
		cwd,
		realGit: true,
		confirm: async () => {
			await commit(cwd, "new target after approval was requested");
			return true;
		},
	});
	const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
	await assert.rejects(
		() => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
		/target ref changed after approval/,
	);
	assert.equal((await git(tree.path, "rev-parse", "HEAD")).trim(), tree.base);
});

test("worktree removal will not delete a tree that is no longer detached", async () => {
	const cwd = await repo();
	const h = host({ cwd, realGit: true, confirm: true });
	const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
	await git(tree.path, "switch", "-c", "keep-this-branch");
	await assert.rejects(
		() => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
		/detached tree/,
	);
	assert.equal((await git(tree.path, "branch", "--show-current")).trim(), "keep-this-branch");
});

test("worktree removal rejects a non-branch target such as the worktree's own commit", async () => {
	const cwd = await repo();
	const h = host({ cwd, realGit: true, confirm: true });
	const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
	await commit(tree.path, "only in the worktree");
	const head = (await git(tree.path, "rev-parse", "HEAD")).trim();
	await git(cwd, "tag", "unique", head);
	const remove = (base: string) => h.call("pstack_worktree", { action: "remove", name: "fixture", base });
	await assert.rejects(() => remove(head), /must be a branch/);
	await assert.rejects(() => remove("unique"), /must be a branch/);
	await assert.rejects(() => remove("HEAD"), /merge-base failed/);
	assert.equal((await git(tree.path, "rev-parse", "HEAD")).trim(), head);
});

test("worktree removal inventories ignored directory contents and rechecks after approval", async () => {
	const cwd = await repo();
	await writeFile(join(cwd, ".gitignore"), ".env*\nbuild/\n");
	await git(cwd, "add", ".gitignore");
	await commit(cwd, "ignore secrets");
	const prompts: string[] = [];
	let approve: (() => boolean | Promise<boolean>) | undefined;
	const h = host({
		cwd,
		realGit: true,
		confirm: (title, message) => {
			prompts.push(`${title}\n${message}`);
			return approve?.() ?? false;
		},
	});
	const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
	const secret = join(tree.path, ".env");
	await mkdir(join(tree.path, "build"));
	await writeFile(join(tree.path, "build", "first.txt"), "first");
	const late = join(tree.path, "build", "second.txt");
	await writeFile(secret, "SECRET");
	const entry = audited(await h.call("pstack_worktree", { action: "audit" }), tree.path);
	assert.equal(entry?.dirty, false);
	assert.equal(entry.ignored, 2);
	const remove = () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" });
	await assert.rejects(remove, /Removal not authorized/);
	const prompt = nth(prompts, 0);
	assert.match(prompt, /ignored files\?/);
	assert.match(prompt, /2 ignored path\(s\)[\s\S]*\.env/);
	assert.match(prompt, /build\/first\.txt/);
	approve = async () => {
		await writeFile(late, "LATE");
		return true;
	};
	await assert.rejects(remove, /changed after approval/);
	assert.equal(await readFile(secret, "utf8"), "SECRET");
	await unlink(late);
	approve = () => true;
	assert.equal(removed(await remove()), tree.path);
	await assert.rejects(() => readFile(secret), { code: "ENOENT" });
});

test("worktree porcelain preserves spaces and locked status", () => {
	assert.deepEqual(
		parseWorktrees(
			"worktree /a b\nHEAD abc\nbranch refs/heads/main\n\nworktree /c\nHEAD def\ndetached\nlocked reason\n",
		),
		[
			{
				path: "/a b",
				head: "abc",
				branch: "refs/heads/main",
				locked: false,
				prunable: false,
				bare: false,
			},
			{ path: "/c", head: "def", branch: undefined, locked: true, prunable: false, bare: false },
		],
	);
});

test("NUL-delimited worktree output preserves newline and trailing space in paths", () => {
	const [tree] = parseWorktrees("worktree /a\nb \0HEAD abc\0detached\0\0");
	assert.equal(tree?.path, "/a\nb ");
	assert.equal(tree.head, "abc");
});

test("bare Git worktree entries have no HEAD", () => {
	const [tree] = parseWorktrees("worktree /bare.git\0bare\0\0");
	assert.equal(tree?.bare, true);
	assert.equal(tree.head, undefined);
});
