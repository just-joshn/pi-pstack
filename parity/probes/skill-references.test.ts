import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSkillReference } from "../skill-references.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pstack-skill-references-"));
	temporaryRoots.push(root);
	const skillsRoot = join(root, "skills");
	const referringFile = join(skillsRoot, "alpha/playbooks/nested.md");
	mkdirSync(join(skillsRoot, "alpha/playbooks"), { recursive: true });
	mkdirSync(join(skillsRoot, "alpha/references"), { recursive: true });
	mkdirSync(join(skillsRoot, "beta"), { recursive: true });
	writeFileSync(referringFile, "nested playbook");
	writeFileSync(join(skillsRoot, "alpha/references/check.md"), "same skill");
	writeFileSync(join(skillsRoot, "beta/SKILL.md"), "sibling skill");
	return { skillsRoot, referringFile };
}

test("same-skill references resolve from the skill root, not the nested playbook directory", () => {
	const { skillsRoot, referringFile } = fixture();

	expect(resolveSkillReference(skillsRoot, referringFile, "references/check.md")).toBe(
		join(skillsRoot, "alpha/references/check.md"),
	);
});

test("sibling-skill references resolve from the referring skill root", () => {
	const { skillsRoot, referringFile } = fixture();
	const target = resolveSkillReference(skillsRoot, referringFile, "../beta/SKILL.md");

	expect(target).toBe(join(skillsRoot, "beta/SKILL.md"));
	expect(existsSync(target)).toBe(true);
});

test("missing skill-relative targets stay rooted at the referring skill", () => {
	const { skillsRoot, referringFile } = fixture();
	const target = resolveSkillReference(skillsRoot, referringFile, "scripts/missing.sh");

	expect(target).toBe(join(skillsRoot, "alpha/scripts/missing.sh"));
	expect(existsSync(target)).toBe(false);
});
