/**
 * Pins the documentation claims corrected in the audit-remediation wave to the
 * code they describe. Each test fails when the doc and the tree disagree, so a
 * future refactor that reverts the code is caught here rather than in review.
 */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/repo-root.mjs";

const ROOT = repoRoot(import.meta.url);

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

const SECTION_HEADING = /^#{1,3}\s+(.*)$/;
const SCORECARD_ROW = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|/;

function sectionBody(markdown, headingPattern) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => {
    const match = SECTION_HEADING.exec(line);
    return match ? headingPattern.test(match[1]) : false;
  });
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => SECTION_HEADING.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function scorecardVerdicts(markdown) {
  return markdown.split("\n").reduce((acc, line) => {
    const match = SCORECARD_ROW.exec(line);
    if (!match) return acc;
    const behavioral = match[3];
    if (/\bNOT\b/.test(behavioral)) return { ...acc, [match[1]]: "NOT" };
    if (/\bPARTIAL\b/.test(behavioral)) return { ...acc, [match[1]]: "PARTIAL" };
    if (/\bEQUIVALENT\b/.test(behavioral)) return { ...acc, [match[1]]: "EQUIVALENT" };
    return acc;
  }, {});
}

test("PARITY.md no longer carries corrections for already-fixed findings", () => {
  const parity = read("PARITY.md");
  const stalePhrases = [
    "the tool_call policy omits pstack_loop",
    "wrongly says N is not the concurrency cap",
    "the watcher ignores the child exit code",
  ];
  for (const phrase of stalePhrases) {
    expect(parity.includes(phrase), `PARITY.md still asserts an open finding: ${phrase}`).toBe(false);
  }
});

test("the readonly tool_call policy covers every pstack tool PARITY.md names", () => {
  const source = read("extensions/readonly-state/index.ts");
  for (const tool of ["pstack_loop", "pstack_run", "pstack_decision_log", "pstack_benny_wake"]) {
    expect(source, `readonly policy table is missing ${tool}`).toMatch(new RegExp(`\\b${tool}:`));
  }
});

test("the watcher reads the watchArgv exit code", () => {
  const source = read("extensions/heartbeat/state.ts");
  expect(source).toMatch(/code === 0 \? "watcher" : "watcher-error"/);
});

test("capabilities.json statuses agree with the PARITY.md behavioral scorecard", () => {
  const scorecard = scorecardVerdicts(read("PARITY.md"));
  expect(Object.keys(scorecard).length > 0, "no scorecard rows parsed from PARITY.md").toBeTruthy();
  const capabilities = readJson("compat/capabilities.json").capabilities;
  const conflicts = capabilities.filter(
    (capability) =>
      capability.status === "verified" && (scorecard[capability.id] === "NOT" || scorecard[capability.id] === "PARTIAL"),
  );
  expect(conflicts.map((capability) => capability.id)).toEqual([]);
});

test("capabilities.json states its counting basis per capability", () => {
  const capabilities = readJson("compat/capabilities.json").capabilities;
  for (const capability of capabilities) {
    expect(capability.counts, `capability ${capability.id} has no counts`).toBeTruthy();
    expect(capability.notes).toMatch(/in-scope row\(s\) verified/);
    expect(capability.notes).toMatch(/PARITY\.md behavioral scorecard/);
  }
  const makeBotUi = capabilities.find((capability) => capability.id === "9");
  expect(makeBotUi.counts).toEqual({ ledgerRows: 18, inScope: 6, verified: 6, excluded: 12 });
  expect(makeBotUi.notes).toMatch(/12 EXCLUDED row\(s\) excluded from the rollup/);
});

test("REPORT.md does not block hosted rows on services that ship in-tree", () => {
  const report = read("compat/REPORT.md");
  expect(report.includes("until services/worker ships")).toBe(false);
  expect(report.includes("until services/benny ships")).toBe(false);
});

test("README.md declares the bun prerequisite at the package.json engines version", () => {
  const engines = readJson("package.json").engines ?? {};
  expect(typeof engines.bun, "package.json engines.bun must be a version range").toBe("string");
  const prerequisites = sectionBody(read("README.md"), /prerequisit/i);
  expect(prerequisites, "README.md prerequisites must name bun").toMatch(/bun/i);
  expect(prerequisites.includes(engines.bun), `README.md prerequisites must name bun ${engines.bun}`).toBe(true);
  expect(read("extensions/heartbeat/coalesce.ts")).toMatch(/"bun", \["--version"\]/);
});

test("ceiling-06 does not justify the exception with a closed frontmatter schema", () => {
  const row = readJson("compat/parity.json").rows.find((entry) => entry.id === "ceiling-06");
  expect(row, "ceiling-06 row missing from compat/parity.json").toBeTruthy();
  const text = `${row.behavior ?? ""} ${row.exceptionJustification ?? ""}`;
  expect(/frontmatter schema is\s+"?closed"?/i.test(text)).toBe(false);
  expect(text).toMatch(/extensions\/lib\/skill-chrome\.ts/);
  const chrome = read("extensions/lib/skill-chrome.ts");
  expect(chrome).toMatch(/reminder/);
  expect(chrome).toMatch(/icon/);
  expect(chrome).toMatch(/color/);
  expect(read("node_modules/@earendil-works/pi-coding-agent/dist/core/skills.d.ts")).toMatch(/interface SkillFrontmatter\s*\{[^}]*\[key:\s*string\]:/);
});
