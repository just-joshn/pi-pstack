import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintPackage } from "../lint-package.mjs";

const root = path.join(import.meta.dir, "../..");

function withCopy(mutate: (dir: string) => string[]): string[] {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lint-package-"));
  try {
    for (const entry of ["package.json", "skills", "agents", "extensions"]) cpSync(path.join(root, entry), path.join(dir, entry), { recursive: true });
    const shipped = mutate(dir);
    return lintPackage(dir, shipped);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const baseShipped = ["skills/how/SKILL.md", "agents/poteto-agent.md", "extensions/pstack-mode.ts"];

function append(dir: string, file: string, line: string): string[] {
  writeFileSync(path.join(dir, file), `${readFileSync(path.join(dir, file), "utf8")}\n${line}\n`);
  return [...new Set([...baseShipped, file])];
}

test("a clean copy of the package has no findings for the sampled files", () => {
  expect(withCopy(() => baseShipped)).toEqual([]);
});

test.each([
  ["skills/how/SKILL.md", "See `<pstack>/skills/why/SKILL.md`.", "unresolved <pstack> token"],
  ["agents/poteto-agent.md", "Read /Users/alice/code/x.md first.", "absolute home path"],
  ["skills/how/SKILL.md", "Write `$PI_CODING_AGENT_DIR/AGENTS.md`.", "bare $PI_CODING_AGENT_DIR/"],
  ["agents/poteto-agent.md", "Open `~/.pi/agent/skills/why/SKILL.md`.", "package skill referenced at a user install path"],
  ["agents/poteto-agent.md", "Edit `~/.pi/agent/extensions/todo.ts`.", "package extension or agent referenced at a user install path"],
  ["extensions/pstack-mode.ts", "const d = join(homedir(), \".pi\", \"agent\");", "homedir() joined with .pi/agent"],
  ["skills/how/SKILL.md", "Read `~/.pi/agent/AGENTS.md` first.", "agent-dir path ignores PI_CODING_AGENT_DIR"],
])("catches a planted violation in %s: %s", (file, line, message) => {
  const findings = withCopy((dir) => append(dir, file, line));
  expect(findings).toHaveLength(1);
  expect(findings[0]).toContain(message);
});

test("allows the documented user-data and generic user-skill locations", () => {
  const findings = withCopy((dir) => append(dir, "skills/how/SKILL.md",
    "Pi's agent directory (`~/.pi/agent` by default) holds `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md`, `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions/pstack-agents.json`, and user skills in `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills/<name>/`."));
  expect(findings).toEqual([]);
});

test("catches manifest, skill frontmatter, and shipping mistakes", () => {
  const findings = withCopy((dir) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    manifest.pi.extensions.push("./extensions/missing.ts");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
    const skill = path.join(dir, "skills/how/SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace(/^name: how$/m, "name: how-else"));
    return [...baseShipped, "extensions/todo.test.ts"];
  });
  expect(findings).toEqual([
    "package.json: pi.extensions entry ./extensions/missing.ts does not exist",
    "extensions/todo.test.ts: must not ship (extension test, node_modules, or parity tooling)",
    "skills/how/SKILL.md: name how-else does not match its directory",
  ]);
});
