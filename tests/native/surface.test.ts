import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../support/repo-root.mjs";

const ROOT = repoRoot(import.meta.url);

describe("native package surface", () => {
  it("registers the three live extensions and the skills tree", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.pi).toEqual({
      extensions: ["./extensions/subagent/index.ts", "./extensions/pstack-slash.ts", "./extensions/todo.ts"],
      skills: ["./skills"],
    });
  });

  it("does not mention pstack_* tools in skills or agents", () => {
    const hits = collectHits(["skills", "agents"], /pstack_(spawn|swarm|arena|loop|babysit|ship|task|jobs)\b/);
    expect(hits).toEqual([]);
  });

  it("points setup-pstack at AGENTS.md rather than pstack-models.json", () => {
    const body = readFileSync(join(ROOT, "skills/setup-pstack/SKILL.md"), "utf8");
    expect(body).toContain("~/.pi/agent/AGENTS.md");
    expect(body).not.toContain("pstack-models.json");
  });
});

function collectHits(roots: string[], pattern: RegExp): string[] {
  return roots.flatMap((root) => walkMd(join(ROOT, root)).filter((file) => pattern.test(readFileSync(file, "utf8"))));
}

function walkMd(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walkMd(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}
