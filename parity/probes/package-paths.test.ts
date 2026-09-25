import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { packagePaths, packagePathsAt } from "../package-paths.mjs";
import { walk } from "../sync-check.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("packagePathsAt builds a frozen path record from an absolute package root", () => {
	const root = mkdtempSync(join(tmpdir(), "pstack-package-paths-"));
	temporaryRoots.push(root);
	const paths = packagePathsAt(root);

	expect(paths).toEqual({
		packageRoot: root,
		parityRoot: join(root, "parity"),
		skillsRoot: join(root, "skills"),
		agentsRoot: join(root, "agents"),
		extensionsRoot: join(root, "extensions"),
		upstreamRoot: join(root, "parity/upstream"),
		upstreamPreviousRoot: join(root, "parity/upstream/0.15.5"),
		upstreamCurrentRoot: join(root, "parity/upstream/current"),
		additionsFile: join(root, "parity/pi-additions.tsv"),
	});
	expect(Object.isFrozen(paths)).toBe(true);
	expect(isAbsolute(paths.packageRoot)).toBe(true);
});

test("packagePathsAt rejects a relative package root", () => {
	expect(() => packagePathsAt("package")).toThrow("package root must be absolute: package");
});

test("walk rejects an absent required root instead of returning an empty comparison", () => {
	const root = mkdtempSync(join(tmpdir(), "pstack-missing-input-"));
	temporaryRoots.push(root);
	const missingRoot = join(root, "missing-upstream");

	expect(() => walk(missingRoot)).toThrow(`missing required input: ${relative(packagePaths.packageRoot, missingRoot)}`);
});
