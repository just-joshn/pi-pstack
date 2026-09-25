import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintPackage } from "../lint-package.mjs";

const temporaryRoots: string[] = [];
const AGENT_DIRECTORY_PHRASE = "Pi's agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`)";

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "pstack-package-lint-"));
	temporaryRoots.push(root);
	for (const directory of ["skills/example", "agents", "extensions"]) mkdirSync(join(root, directory), { recursive: true });
	writeFileSync(join(root, "skills/example/SKILL.md"), "A portable skill.\n");
	writeFileSync(join(root, "agents/example.md"), "A portable agent.\n");
	writeFileSync(join(root, "extensions/example.ts"), "export {};\n");
	return root;
}

test("lintPackage accepts documented agent-directory defaults and reports no findings", () => {
	const root = fixture();
	const skillPath = join(root, "skills/example/SKILL.md");
	const skillText = `Use ${AGENT_DIRECTORY_PHRASE}.\n`;
	writeFileSync(skillPath, skillText);

	expect(lintPackage(root)).toEqual([]);
	expect(readFileSync(skillPath, "utf8")).toBe(skillText);
});

test("lintPackage reports missing and empty required roots", () => {
	const root = mkdtempSync(join(tmpdir(), "pstack-package-lint-"));
	temporaryRoots.push(root);
	mkdirSync(join(root, "skills"));
	writeFileSync(join(root, "skills/example.md"), "Portable skill.\n");
	mkdirSync(join(root, "agents"));

	const findings = lintPackage(root);
	expect(findings).toContain("agents: empty required directory");
	expect(findings).toContain("extensions: missing required directory");
});

test("lintPackage reports package tokens and agent paths without editing owned files", () => {
	const root = fixture();
	const skillPath = join(root, "skills/example/SKILL.md");
	const agentPath = join(root, "agents/example.md");
	const extensionPath = join(root, "extensions/example.ts");
	const skillText = "Read ~/.pi/agent/AGENTS.md and <pstack>/skills/example/SKILL.md.\n";
	const agentText = "Read ~/.pi/agent/skills/example/SKILL.md and <pstack>/skills/example/SKILL.md.\n";
	const extensionText = 'import { homedir } from "node:os";\nconst root = join(homedir(), ".pi/agent"); // <pstack>\nconst legacy = resolve(homedir(), ".pi", "agent");\n';
	writeFileSync(skillPath, skillText);
	writeFileSync(agentPath, agentText);
	writeFileSync(extensionPath, extensionText);

	const findings = lintPackage(root);
	expect(findings).toContain("skills/example/SKILL.md:1: unresolved <pstack> token");
	expect(findings).toContain("skills/example/SKILL.md: expected the Pi agent-directory default phrase once, found 0");
	expect(findings).toContain("skills/example/SKILL.md:1: agent-directory path appears outside the documented default phrase");
	expect(findings).toContain("agents/example.md:1: unresolved <pstack> token");
	expect(findings).toContain("agents/example.md:1: hard-coded Pi agent-directory path");
	expect(findings).toContain("extensions/example.ts:2: unresolved <pstack> token");
	expect(findings).toContain("extensions/example.ts:2: homedir() joined with .pi/agent");
	expect(findings).toContain("extensions/example.ts:3: homedir() joined with .pi/agent");
	expect(readFileSync(skillPath, "utf8")).toBe(skillText);
	expect(readFileSync(agentPath, "utf8")).toBe(agentText);
	expect(readFileSync(extensionPath, "utf8")).toBe(extensionText);
});
