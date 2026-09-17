/**
 * Port-binding coverage.
 *
 * Pins the rendered output of the amended and added port bindings, and proves
 * the byte-identical set carries no leftover token now that the port checker
 * scans it.
 */
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot } from "../support/repo-root.mjs";
import { leftoverTokens } from "../../port/bindings/index.mjs";
import { resolveUpstreamRoot, walkArtifacts } from "../../compat/lib/inventory.mjs";

const ROOT = repoRoot(import.meta.url);
const LOCK = JSON.parse(readFileSync(join(ROOT, "upstream.lock.json"), "utf8"));
const upstream = resolveUpstreamRoot(ROOT, LOCK);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const TEXT_EXTENSIONS = new Set([".md", ".sh", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".tsv", ".txt", ".lock"]);

function globToRegExp(glob) {
  const segments = glob
    .split("/")
    .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")));
  return new RegExp(`^${segments.join("/")}$`);
}

function scanLeftovers(rel, text) {
  return leftoverTokens.flatMap((token) => {
    if (token.allow?.some((glob) => globToRegExp(glob).test(rel))) return [];
    return text
      .split("\n")
      .flatMap((line, idx) => (token.re.test(line) ? [`${token.id} line ${idx + 1}: ${line.trim()}`] : []));
  });
}

function identicalText(rel) {
  const buf = readFileSync(join(upstream.root, rel));
  const local = readFileSync(join(ROOT, rel));
  if (!local.equals(buf)) return null;
  return TEXT_EXTENSIONS.has(extname(rel).toLowerCase()) ? buf.toString("utf8") : null;
}

test("swarm states the concurrency cap without shrinking N", () => {
  const text = read("skills/swarm/SKILL.md");
  expect(text.includes("N is total workers; the Pi concurrency cap is 8"), "the worker total and the cap stay distinct").toBeTruthy();
  expect(!text.includes("accepts at most 8 per call"), "N is not capped at 8 per call").toBeTruthy();
});

test("why names one spawn tool per subagent config block", () => {
  const text = read("skills/why/SKILL.md");
  const taskRole = text.split("- `role`: `general` via `pstack_task`").length - 1;
  expect(taskRole, "both the investigator and synthesizer stanzas name pstack_task").toBe(2);
  expect(!text.includes("- `role`: `general` via `pstack_spawn`"), "the why stanzas do not name the pstack_spawn alias alongside pstack_task").toBeTruthy();
});

test("worktree-audit scans only this workspace's session directory", () => {
  const text = read("skills/poteto-mode/scripts/worktree-audit.sh");
  expect(text.includes('transcripts="$pi_home/sessions/--$slug--"'), "the transcript path is scoped to the encoded workspace").toBeTruthy();
  expect(text.includes("# Transcripts dir: $HOME/.pi/agent/sessions"), "the comment documents the store root").toBeTruthy();
  const unscoped = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .filter((line) => /\$HOME\/\.pi\/agent\/sessions|~\/\.pi\/agent\/sessions/.test(line));
  expect(unscoped, `unscoped session-store reads: ${unscoped.join(" | ")}`).toEqual([]);
});

test("no byte-identical ported file carries a leftover token", () => {
  expect(upstream, "pinned upstream clone missing; run `npm run parity:check` first").toBeTruthy();
  const scoped = LOCK.scoped ?? [];
  const artifacts = walkArtifacts(upstream.root, scoped).filter((rel) => scoped.some((dir) => rel.startsWith(`${dir}/`)));
  const offenders = artifacts.flatMap((rel) => {
    const text = identicalText(rel);
    return text === null ? [] : scanLeftovers(rel, text).map((hit) => `${rel}: ${hit}`);
  });
  expect(offenders, `leftover tokens survive in byte-identical files:\n${offenders.join("\n")}`).toEqual([]);
});
