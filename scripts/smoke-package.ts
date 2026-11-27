import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json" with { type: "json" };
import { isRecord } from "../src/lib/validation.ts";

const npm = process.env.npm_execpath;
assert.ok(npm, "Run this script through npm run test:package");
const hostVersion = process.argv[2] ?? manifest.devDependencies["@earendil-works/pi-coding-agent"];
assert(/^\d+\.\d+\.\d+$/.test(hostVersion), "Expected an exact Pi version such as 1.6.1");
const host = `@earendil-works/pi-coding-agent@${hostVersion}`;
const cwd = process.cwd();
const temp = mkdtempSync(join(tmpdir(), "pi-package-"));

try {
	const output = execFileSync(
		process.execPath,
		[npm, "pack", "--json", "--ignore-scripts", "--pack-destination", temp],
		{
			cwd,
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	const packs: unknown = JSON.parse(output);
	assert(Array.isArray(packs) && packs.length === 1, "Expected exactly one packed tarball");
	const pack: unknown = packs[0];
	const tarball = `${manifest.name}-${manifest.version}.tgz`;
	assert(isRecord(pack) && pack.filename === tarball && Array.isArray(pack.files), "Unexpected npm pack output");
	const files: unknown[] = pack.files;
	for (const file of files) {
		assert(isRecord(file) && typeof file.path === "string", "Expected an npm pack file path");
		assert(!file.path.split("/").includes("node_modules"), "Packed tarball contains a nested dependency install");
		assert(
			!/(^|\/)(?:\.pi\/|\.env(?:\.[^/]*)?$)|\.(?:pem|key|p12|pfx)$/i.test(file.path),
			"Packed tarball contains local credential or Pi state files",
		);
	}
	writeFileSync(join(temp, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
	execFileSync(
		process.execPath,
		[
			npm,
			"install",
			"--ignore-scripts",
			"--omit=dev",
			"--no-audit",
			"--no-fund",
			"--save-exact",
			host,
			join(temp, tarball),
		],
		{ cwd: temp, stdio: "inherit", timeout: 180_000 },
	);
	copyFileSync(resolve(cwd, "scripts/smoke-installed.ts"), join(temp, "smoke-installed.ts"));
	execFileSync(process.execPath, [join(temp, "smoke-installed.ts"), manifest.name], {
		cwd: temp,
		stdio: "inherit",
		timeout: 30_000,
		env: {
			PATH: process.env.PATH,
			HOME: temp,
			USERPROFILE: temp,
			SystemRoot: process.env.SystemRoot,
			TEMP: temp,
			TMP: temp,
			PI_OFFLINE: "1",
			PI_CODING_AGENT_DIR: join(temp, ".pi-agent"),
		},
	});
} finally {
	rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
