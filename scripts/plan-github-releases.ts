import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, parseJson } from "../src/lib/validation.ts";

const name = "pi-pstack-workflow-kit";
const repository = "https://github.com/just-joshn/pi-pstack";
const source = `git+${repository}@refs/heads/main`;
const signer = `URI:${repository}/.github/workflows/stage-npm.yml@refs/heads/main`;
const provenance = "https://slsa.dev/provenance/v1";
const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const firstVersion = "0.5.0";
const batchSize = 10;

interface ReleaseIntent {
	version: string;
	commit: string;
	notes: string;
	latest: boolean;
}

function field(value: unknown, key: string): unknown {
	return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function array(value: unknown): unknown[] {
	assert.ok(Array.isArray(value), "Expected an array");
	return value;
}

function compareVersions(a: string, b: string): number {
	const right = b.split(".").map(BigInt);
	for (const [i, part] of a.split(".").map(BigInt).entries()) {
		const other = right[i];
		assert.ok(other !== undefined);
		if (part !== other) return part > other ? 1 : -1;
	}
	return 0;
}

export function missingReleases(registry: unknown, releases: unknown): { versions: string[]; latest: string } {
	const latest = field(registry, "dist-tags.latest");
	assert.ok(typeof latest === "string", "npm must report a latest tag");
	const released = new Set(
		array(releases)
			.flatMap(array)
			.filter((release) => field(release, "draft") === false)
			.map((release) => field(release, "tag_name")),
	);
	const versions = array(field(registry, "versions")).filter(
		(version): version is string =>
			typeof version === "string" &&
			version.length <= 256 &&
			stableVersion.test(version) &&
			compareVersions(version, firstVersion) >= 0 &&
			!released.has(`v${version}`),
	);
	return { versions: [...new Set(versions)].sort(compareVersions).slice(0, batchSize), latest };
}

export function provenCommit(audit: unknown, version: string): string {
	assert.equal(array(field(audit, "invalid")).length, 0, "npm signature verification failed");
	assert.equal(array(field(audit, "missing")).length, 0, "npm signatures are missing");
	const pkg = array(field(audit, "verified")).find(
		(entry) => field(entry, "name") === name && field(entry, "version") === version,
	);
	assert.ok(pkg, `npm did not verify ${name}@${version}`);
	const [attestation, ...others] = array(field(pkg, "attestationBundles")).filter(
		(entry) => field(entry, "predicateType") === provenance,
	);
	assert.ok(attestation && others.length === 0, "Expected one verified npm provenance attestation");

	const bundle = field(attestation, "bundle");
	const certificate = field(field(field(bundle, "verificationMaterial"), "certificate"), "rawBytes");
	assert.ok(typeof certificate === "string", "Expected a signing certificate");
	assert.equal(
		new X509Certificate(Buffer.from(certificate, "base64")).subjectAltName,
		signer,
		"Unexpected npm signer",
	);

	const payload = field(field(bundle, "dsseEnvelope"), "payload");
	assert.ok(typeof payload === "string", "Expected a signed provenance statement");
	const statement = parseJson(Buffer.from(payload, "base64").toString("utf8"), "npm provenance statement");
	assert.equal(field(statement, "predicateType"), provenance);
	const build = field(field(statement, "predicate"), "buildDefinition");
	const [dependency, ...rest] = array(field(build, "resolvedDependencies")).filter(
		(entry) => field(entry, "uri") === source,
	);
	assert.ok(dependency && rest.length === 0, "Expected one source commit from main");
	const commit = field(field(dependency, "digest"), "gitCommit");
	assert.ok(typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit), "Expected a full source commit SHA");
	return commit;
}

export function releaseNotes(changelog: string, version: string): string {
	const sections = changelog.split(/^## /m).slice(1);
	const section = sections.find((entry) => entry.split(/\s/, 1)[0] === version);
	assert.ok(section, `Missing changelog entry for ${version}`);
	const notes = section.slice(section.indexOf("\n") + 1).trim();
	assert.ok(notes && section.includes("\n"), `Empty changelog entry for ${version}`);
	assert.ok(Buffer.byteLength(notes) <= 8_000, `Changelog entry for ${version} exceeds 8 KB`);
	return `${notes}\n\n[View on npm](https://www.npmjs.com/package/${name}/v/${version})`;
}

function git(args: string[]): string {
	return execFileSync("git", args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
}

function withNpm<T>(use: (npm: (args: string[], cwd?: string) => unknown, root: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), "npm-release-sync-"));
	const { PATH } = process.env;
	try {
		return use((args, cwd = root) => {
			const output = execFileSync("npm", args, {
				cwd,
				env: {
					PATH,
					HOME: root,
					NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"),
					NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
					NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
					NPM_CONFIG_FETCH_RETRIES: "1",
					NPM_CONFIG_UPDATE_NOTIFIER: "false",
					NPM_CONFIG_IGNORE_SCRIPTS: "true",
					NPM_CONFIG_ALLOW_GIT: "none",
					NPM_CONFIG_ALLOW_REMOTE: "none",
					NPM_CONFIG_ALLOW_FILE: "none",
					NPM_CONFIG_ALLOW_DIRECTORY: "none",
				},
				encoding: "utf8",
				timeout: 90_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			return parseJson(output, "npm response");
		}, root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function plan(releases: unknown): ReleaseIntent[] {
	return withNpm((npm, root) => {
		const { versions, latest } = missingReleases(
			npm(["view", name, "versions", "dist-tags.latest", "--json"]),
			releases,
		);
		return versions.map((version) => {
			const cwd = mkdtempSync(join(root, "version-"));
			writeFileSync(join(cwd, "package.json"), '{"private":true}\n');
			npm(
				[
					"install",
					"--json",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--legacy-peer-deps",
					"--save-exact",
					`${name}@${version}`,
				],
				cwd,
			);
			const commit = provenCommit(
				npm(["audit", "signatures", "--json", "--include-attestations", "--legacy-peer-deps"], cwd),
				version,
			);
			git(["merge-base", "--is-ancestor", commit, "HEAD"]);
			const manifest = parseJson(git(["show", `${commit}:package.json`]), `${commit}:package.json`);
			assert.equal(field(manifest, "name"), name);
			assert.equal(field(manifest, "version"), version);
			return {
				version,
				commit,
				notes: releaseNotes(git(["show", `${commit}:CHANGELOG.md`]), version),
				latest: latest === version,
			};
		});
	});
}

if (import.meta.main) {
	const releaseList = process.argv[2];
	assert.ok(releaseList, "Pass the paginated GitHub release list");
	const output = JSON.stringify(plan(parseJson(readFileSync(releaseList, "utf8"), "GitHub releases")));
	assert.ok(Buffer.byteLength(output) <= 100_000, "Release plan exceeds 100 KB");
	process.stdout.write(output);
}
