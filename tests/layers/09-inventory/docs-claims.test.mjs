/**
 * Pins the documentation claims corrected in the audit-remediation wave to the
 * code they describe. Each test fails when the doc and the tree disagree, so a
 * future refactor that reverts the code is caught here rather than in review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
    assert.equal(parity.includes(phrase), false, `PARITY.md still asserts an open finding: ${phrase}`);
  }
});

test("the readonly tool_call policy covers every pstack tool PARITY.md names", () => {
  const source = read("extensions/readonly-state/index.ts");
  for (const tool of ["pstack_loop", "pstack_run", "pstack_decision_log", "pstack_benny_wake"]) {
    assert.match(source, new RegExp(`\\b${tool}:`), `readonly policy table is missing ${tool}`);
  }
});

test("the watcher reads the watchArgv exit code", () => {
  const source = read("extensions/heartbeat/state.ts");
  assert.match(source, /code === 0 \? "watcher" : "watcher-error"/);
});

test("capabilities.json statuses agree with the PARITY.md behavioral scorecard", () => {
  const scorecard = scorecardVerdicts(read("PARITY.md"));
  assert.ok(Object.keys(scorecard).length > 0, "no scorecard rows parsed from PARITY.md");
  const capabilities = readJson("compat/capabilities.json").capabilities;
  const conflicts = capabilities.filter(
    (capability) =>
      capability.status === "verified" && (scorecard[capability.id] === "NOT" || scorecard[capability.id] === "PARTIAL"),
  );
  assert.deepEqual(conflicts.map((capability) => capability.id), []);
});

test("capabilities.json states its counting basis per capability", () => {
  const capabilities = readJson("compat/capabilities.json").capabilities;
  for (const capability of capabilities) {
    assert.ok(capability.counts, `capability ${capability.id} has no counts`);
    assert.match(capability.notes, /in-scope row\(s\) verified/);
    assert.match(capability.notes, /PARITY\.md behavioral scorecard/);
  }
  const makeBotUi = capabilities.find((capability) => capability.id === "9");
  assert.deepEqual(makeBotUi.counts, { ledgerRows: 18, inScope: 6, verified: 6, excluded: 12 });
  assert.match(makeBotUi.notes, /12 EXCLUDED row\(s\) excluded from the rollup/);
});

test("REPORT.md does not block hosted rows on services that ship in-tree", () => {
  const report = read("compat/REPORT.md");
  assert.equal(report.includes("until services/worker ships"), false);
  assert.equal(report.includes("until services/benny ships"), false);
});

test("README.md declares the bun prerequisite at the package.json engines version", () => {
  const engines = readJson("package.json").engines ?? {};
  assert.equal(typeof engines.bun, "string", "package.json engines.bun must be a version range");
  const prerequisites = sectionBody(read("README.md"), /prerequisit/i);
  assert.match(prerequisites, /bun/i, "README.md prerequisites must name bun");
  assert.equal(prerequisites.includes(engines.bun), true, `README.md prerequisites must name bun ${engines.bun}`);
  assert.match(read("extensions/heartbeat/coalesce.ts"), /"bun", \["--version"\]/);
});

test("ceiling-06 does not justify the exception with a closed frontmatter schema", () => {
  const row = readJson("compat/parity.json").rows.find((entry) => entry.id === "ceiling-06");
  assert.ok(row, "ceiling-06 row missing from compat/parity.json");
  const text = `${row.behavior ?? ""} ${row.exceptionJustification ?? ""}`;
  assert.equal(/frontmatter schema is\s+"?closed"?/i.test(text), false);
  assert.match(text, /extensions\/lib\/skill-chrome\.ts/);
  const chrome = read("extensions/lib/skill-chrome.ts");
  assert.match(chrome, /reminder/);
  assert.match(chrome, /icon/);
  assert.match(chrome, /color/);
  assert.match(
    read("node_modules/@earendil-works/pi-coding-agent/dist/core/skills.d.ts"),
    /interface SkillFrontmatter\s*\{[^}]*\[key:\s*string\]:/,
  );
});
