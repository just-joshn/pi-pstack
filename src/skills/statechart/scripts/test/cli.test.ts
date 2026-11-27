import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const ENTRY = path.join(import.meta.dirname, "..", "statechart.ts");

const run = (cwd: string, ...args: string[]) => {
	const { status, stdout, stderr } = spawnSync(process.execPath, [ENTRY, ...args], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
	});
	return { status, stdout, stderr };
};

describe("statechart CLI failures before TLC runs", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "statechart-cli-test-"));
		fs.writeFileSync(path.join(dir, "M.tla"), "---- MODULE M ----\n====\n");
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("exits 2 with usage when no spec is given", () => {
		const { status, stdout, stderr } = run(dir);
		assert.equal(status, 2);
		assert.equal(stdout, "");
		assert.match(stderr, /^Give one SPEC\.tla\.\n\nUsage: statechart SPEC\.tla/);
	});

	test("exits 2 with usage on an unknown flag", () => {
		const { status, stderr } = run(dir, "M.tla", "--bogus");
		assert.equal(status, 2);
		assert.match(stderr, /--bogus/);
		assert.match(stderr, /Usage: statechart/);
	});

	test("exits 2 when the config beside the spec is missing", () => {
		const { status, stderr } = run(dir, "M.tla");
		assert.equal(status, 2);
		assert.equal(stderr, "Cannot find the TLC config M.cfg. Pass --config FILE.\n");
	});

	test("exits 2 and leaves a non-empty output folder alone", () => {
		fs.writeFileSync(path.join(dir, "M.cfg"), "INIT Init\nNEXT Next\n");
		fs.mkdirSync(path.join(dir, "out"));
		fs.writeFileSync(path.join(dir, "out", "keep.txt"), "mine");
		const { status, stderr } = run(dir, "M.tla", "--out", "out");
		assert.equal(status, 2);
		assert.match(stderr, /^out is not empty\. It has keep\.txt\./);
		assert.deepEqual(fs.readdirSync(path.join(dir, "out")), ["keep.txt"]);
	});

	test("exits 2 on a config TLC would refuse and writes nothing", () => {
		fs.writeFileSync(path.join(dir, "M.cfg"), "INIT Init\nINIT Again\n");
		const { status, stdout, stderr } = run(dir, "M.tla");
		assert.equal(status, 2);
		assert.equal(stdout, "");
		assert.equal(stderr, "TLC refuses the config M.cfg at line 2. The keyword INIT appeared twice.\n");
		assert.deepEqual(fs.readdirSync(dir).sort(), ["M.cfg", "M.tla"]);
	});
});
