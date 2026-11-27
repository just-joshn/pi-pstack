import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missingReleases, provenCommit, releaseNotes } from "../scripts/plan-github-releases.ts";

const name = "pi-pstack-workflow-kit";
const predicateType = "https://slsa.dev/provenance/v1";
const source = "git+https://github.com/just-joshn/pi-pstack@refs/heads/main";
const commit = "5514a519ecb11b8acb4e5fabc6194dff21940bc4";
const certificate = new X509Certificate(
	readFileSync(new URL("./fixtures/npm-release-certificate.txt", import.meta.url)),
);

function npmAudit(version = "0.5.0", uri = source, gitCommit = commit) {
	const resolvedDependencies = [{ uri, digest: { gitCommit } }];
	const payload = Buffer.from(
		JSON.stringify({
			predicateType,
			predicate: { buildDefinition: { resolvedDependencies } },
		}),
	).toString("base64");
	return {
		invalid: [],
		missing: [],
		verified: [
			{
				name,
				version,
				attestationBundles: [
					{
						predicateType,
						bundle: {
							verificationMaterial: { certificate: { rawBytes: certificate.raw.toString("base64") } },
							dsseEnvelope: { payload },
						},
					},
				],
			},
		],
	};
}

describe("plan GitHub releases from npm", () => {
	it("plans approved stable releases missing from GitHub, oldest first", () => {
		const registry = {
			"dist-tags.latest": "0.10.0",
			versions: ["0.10.0", "0.0.0-stage", "0.4.1", "0.5.1", "1.0.0-beta", "0.5.0", "0.5.1"],
		};
		const releases = [[{ tag_name: "v0.5.0", draft: false }], [{ tag_name: "v0.10.0", draft: true }]];
		expect(missingReleases(registry, releases)).toEqual({ latest: "0.10.0", versions: ["0.5.1", "0.10.0"] });
	});

	it("keeps the next sync a no-op when the release exists", () => {
		expect(
			missingReleases({ "dist-tags.latest": "0.5.0", versions: ["0.1.0", "0.5.0"] }, [
				[{ tag_name: "v0.5.0", draft: false }],
			]).versions,
		).toEqual([]);
	});

	it("uses only the commit from the verified version and main workflow", () => {
		expect(provenCommit(npmAudit(), "0.5.0")).toBe(commit);
		expect(() => provenCommit(npmAudit(), "0.5.1")).toThrow();
		expect(() => provenCommit(npmAudit("0.5.0", source.replace("/main", "/feature")), "0.5.0")).toThrow();
		expect(() => provenCommit(npmAudit("0.5.0", source, "--not-a-commit"), "0.5.0")).toThrow();
	});

	it("refuses incomplete or failed signature verification", () => {
		const verified = npmAudit();
		expect(() => provenCommit({ ...verified, invalid: ["bad signature"] }, "0.5.0")).toThrow();
		expect(() => provenCommit({ ...verified, verified: [{ name, version: "0.5.0" }] }, "0.5.0")).toThrow();
	});

	it("refuses a certificate from another signer", () => {
		const audit = npmAudit();
		const [verified] = audit.verified;
		const [attestation] = verified?.attestationBundles ?? [];
		expect(attestation).toBeDefined();
		if (!attestation) throw new Error("Missing test attestation");
		const der = Buffer.from(certificate.raw);
		const workflow = der.indexOf("stage-npm.yml");
		expect(workflow).toBeGreaterThanOrEqual(0);
		der.write("other-npm.yml", workflow);
		attestation.bundle.verificationMaterial.certificate.rawBytes = der.toString("base64");
		expect(() => provenCommit(audit, "0.5.0")).toThrow("Unexpected npm signer");
	});

	it("takes just the planned version's notes", () => {
		const changelog =
			"# Changelog\n\n## 0.5.10 (Unreleased)\n\nWrong\n\n## 0.5.0 (Unreleased)\n\n### Fixed\n\n- Change\n\n## 0.1.0\n\nOlder\n";
		expect(releaseNotes(changelog, "0.5.0")).toBe(
			"### Fixed\n\n- Change\n\n[View on npm](https://www.npmjs.com/package/pi-pstack-workflow-kit/v/0.5.0)",
		);
		expect(() => releaseNotes(changelog, "0.5.1")).toThrow("Missing changelog entry");
	});
});
