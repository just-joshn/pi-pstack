import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { isRecord } from "../src/lib/validation.ts";

const npm = process.env.npm_execpath;
assert.ok(npm, "Run this script through npm run test:package");
const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: { "tarball-out": { type: "string" } },
});
const hostVersions = positionals.length ? positionals : [manifest.devDependencies["@earendil-works/pi-coding-agent"]];
assert(
	hostVersions.every((version) => /^\d+\.\d+\.\d+$/.test(version)),
	"Expected exact Pi versions such as 1.6.1",
);
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
	const filename = `${manifest.name}-${manifest.version}.tgz`;
	assert(isRecord(pack) && pack.filename === filename && Array.isArray(pack.files), "Unexpected npm pack output");
	const tarball = join(temp, filename);
	const files: unknown[] = pack.files;
	for (const file of files) {
		assert(isRecord(file) && typeof file.path === "string", "Expected an npm pack file path");
		assert(!file.path.split("/").includes("node_modules"), "Packed tarball contains a nested dependency install");
		assert(
			!/(^|\/)(?:\.pi\/|\.env(?:\.[^/]*)?$)|\.(?:pem|key|p12|pfx)$/i.test(file.path),
			"Packed tarball contains local credential or Pi state files",
		);
	}
	for (const version of hostVersions) {
		const install = mkdtempSync(join(temp, "pi-"));
		process.stdout.write(`Checking ${filename} with Pi ${version}.\n`);
		writeFileSync(join(install, "package.json"), '{"private":true,"type":"module"}\n', { mode: 0o600 });
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
				`@earendil-works/pi-coding-agent@${version}`,
				tarball,
			],
			{ cwd: install, stdio: "inherit", timeout: 180_000 },
		);
		copyFileSync(resolve(cwd, "scripts/smoke-installed.ts"), join(install, "smoke-installed.ts"));
		execFileSync(process.execPath, [join(install, "smoke-installed.ts"), manifest.name], {
			cwd: install,
			stdio: "inherit",
			timeout: 30_000,
			env: {
				PATH: process.env.PATH,
				HOME: install,
				USERPROFILE: install,
				SystemRoot: process.env.SystemRoot,
				TEMP: install,
				TMP: install,
				PI_OFFLINE: "1",
				PI_CODING_AGENT_DIR: join(install, ".pi-agent"),
			},
		});
	}
	if (values["tarball-out"]) copyFileSync(tarball, values["tarball-out"], constants.COPYFILE_EXCL);
} finally {
	rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
