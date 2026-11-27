import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { delimiter, join, normalize, resolve } from "node:path";

import { test } from "vitest";

import { srcDir } from "../src/lib/catalog.ts";
import { sandbox } from "./host.ts";
import { git, repo } from "./repo.ts";
import { spawned } from "./support.ts";

test("the packaged worktree audit reports detached worktrees with spaces in their paths", async () => {
	const cwd = await repo();
	const path = join(await realpath(sandbox), "two words (detached)");
	await git(cwd, "worktree", "add", "--detach", path, "HEAD");
	const bin = await mkdtemp(join(sandbox, "offline-bin-"));
	await Promise.all(
		["gh", "origin"].map((name) => writeFile(join(bin, name), "#!/bin/sh\nprintf '[]\\n'\n", { mode: 0o700 })),
	);
	const bash =
		process.platform === "win32" ? resolve((await git(cwd, "--exec-path")).trim(), "../../../bin/bash.exe") : "bash";
	const result = await spawned(
		bash,
		[join(srcDir, "skills/poteto-mode/scripts/worktree-audit.sh"), "--base", "HEAD", cwd],
		{
			env: { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(delimiter), PI_CODING_AGENT_DIR: sandbox },
			timeout: 10000,
		},
	);
	assert.equal(result.status, 0, result.stderr);
	const rows = result.stdout.trimEnd().split("\n").slice(2);
	assert.equal(rows.length, 1);
	assert.equal(normalize(rows[0]?.split("\t").at(-1) ?? ""), path);
	assert.deepEqual(rows[0]?.split("\t").slice(2, 5), ["YES", "clean", "detached"]);
});
