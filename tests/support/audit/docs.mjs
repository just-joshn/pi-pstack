/**
 * DOC-01..DOC-05: documentation that must agree with the code it describes.
 * Stale corrections and over-claimed statuses are audit findings in their own right.
 */
import { existsSync, readFileSync } from "node:fs";
import { fail, pass, repoPath, verdict } from "./harness.mjs";

const FRONTMATTER_TYPE = "node_modules/@earendil-works/pi-coding-agent/dist/core/skills.d.ts";
const INDEX_SIGNATURE = /interface SkillFrontmatter\s*\{[^}]*\[key:\s*string\]:/;

const STALE_CORRECTIONS = Object.freeze([
  "the tool_call policy omits pstack_loop",
  "wrongly says N is not the concurrency cap",
  "the watcher ignores the child exit code",
]);

const SCORECARD_ROW = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|/;
const SERVICES_SHIP = /adds\s+`?compat\/`?[\s\S]{0,400}?`services\/worker\/`/;
const SERVICES_BLOCKED = /until\s+services\/worker\s+ships/;
const SECTION_HEADING = /^#{1,3}\s+(.*)$/;
const PREREQ_HEADING = /prerequisit|requirement|install|getting started/i;

function parityText() {
  return readFileSync(repoPath("PARITY.md"), "utf8");
}

async function docNoStaleCorrections() {
  const text = parityText();
  const present = STALE_CORRECTIONS.filter((phrase) => text.includes(phrase));
  return verdict(
    present.length === 0,
    `PARITY.md carries no correction claiming an already-fixed finding is open (checked ${STALE_CORRECTIONS.length})`,
    `${present.length}/${STALE_CORRECTIONS.length} PARITY.md corrections still assert a finding is open: ${present.map((p) => `"${p}"`).join(", ")}`,
  );
}

function scorecardVerdicts(text) {
  return text.split("\n").reduce((acc, line) => {
    const match = SCORECARD_ROW.exec(line);
    if (!match) return acc;
    const behavioral = match[3];
    const level = /\bNOT\b/.test(behavioral)
      ? "NOT"
      : /\bPARTIAL\b/.test(behavioral)
        ? "PARTIAL"
        : /\bEQUIVALENT\b/.test(behavioral)
          ? "EQUIVALENT"
          : null;
    return level ? { ...acc, [match[1]]: level } : acc;
  }, {});
}

async function docCapabilitiesAgree() {
  const rows = scorecardVerdicts(parityText());
  const capabilities = JSON.parse(readFileSync(repoPath("compat/capabilities.json"), "utf8")).capabilities;
  if (Object.keys(rows).length === 0) return fail("no scorecard rows parsed from PARITY.md");
  const conflicts = capabilities.filter(
    (capability) =>
      capability.status === "verified" &&
      (rows[capability.id] === "NOT" || rows[capability.id] === "PARTIAL"),
  );
  return verdict(
    conflicts.length === 0,
    `all ${capabilities.length} capability statuses agree with the PARITY.md scorecard`,
    `${conflicts.length} capabilities claim "verified" while PARITY.md scores them lower: ${conflicts.map((c) => `${c.id}=${rows[c.id]} (${c.title})`).join(", ")}`,
  );
}

async function docReportSelfConsistent() {
  const text = readFileSync(repoPath("compat/REPORT.md"), "utf8");
  const ships = SERVICES_SHIP.test(text);
  const blocked = SERVICES_BLOCKED.test(text);
  const blockedRows = text.split("\n").filter((line) => SERVICES_BLOCKED.test(line)).length;
  return verdict(
    !(ships && blocked),
    ships ? "REPORT.md says the services ship and no row is blocked on them" : "REPORT.md does not claim the services ship",
    `REPORT.md says the tree adds services/worker/ and still blocks ${blockedRows} row(s) "until services/worker ships"`,
  );
}

function sectionBody(lines, index) {
  const rest = lines.slice(index + 1);
  const end = rest.findIndex((line) => SECTION_HEADING.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

async function docReadmeBunPrerequisite() {
  const lines = readFileSync(repoPath("README.md"), "utf8").split("\n");
  const sections = lines.flatMap((line, index) => {
    const match = SECTION_HEADING.exec(line);
    if (!match || !PREREQ_HEADING.test(match[1])) return [];
    return [{ title: match[1], body: sectionBody(lines, index) }];
  });
  if (sections.length === 0) return fail("README.md has no prerequisites, requirements, or install section");
  const declaring = sections.filter((section) => /\bbun\b/i.test(section.body));
  if (declaring.length > 0) return pass(`README.md declares bun under "${declaring[0].title}"`);
  return fail(
    `README.md sections ${sections.map((s) => `"${s.title}"`).join(", ")} never mention bun, though package.json engines requires bun and the pstack_babysit recipes run under it`,
  );
}

async function docCeilingJustification() {
  const parity = JSON.parse(readFileSync(repoPath("compat/parity.json"), "utf8"));
  const row = parity.rows.find((entry) => entry.id === "ceiling-06");
  if (!row) return fail("compat/parity.json has no ceiling-06 row");
  const text = `${row.behavior ?? ""} ${row.exceptionJustification ?? ""}`;
  const claimsClosed = /frontmatter schema is\s+"?closed"?/i.test(text);
  if (!claimsClosed) return pass("ceiling-06 does not describe Pi's frontmatter schema as closed");
  const typePath = repoPath(FRONTMATTER_TYPE);
  if (!existsSync(typePath)) {
    return fail(`ceiling-06 claims the frontmatter schema is closed and ${FRONTMATTER_TYPE} is absent, so the claim is unverifiable`);
  }
  const open = INDEX_SIGNATURE.test(readFileSync(typePath, "utf8"));
  return fail(
    `ceiling-06 justifies the exception with "Pi's frontmatter schema is closed"; SkillFrontmatter in ${FRONTMATTER_TYPE} has an index signature: ${open}`,
  );
}

export const DOC_PREDICATES = Object.freeze([
  { id: "DOC-01", description: "PARITY.md carries no correction for an already-fixed finding", run: docNoStaleCorrections },
  { id: "DOC-02", description: "compat/capabilities.json statuses agree with the PARITY.md scorecard", run: docCapabilitiesAgree },
  { id: "DOC-03", description: "compat/REPORT.md is self-consistent about whether the services ship", run: docReportSelfConsistent },
  { id: "DOC-04", description: "README.md declares the bun prerequisite", run: docReadmeBunPrerequisite },
  { id: "DOC-05", description: "compat/parity.json ceiling-06 does not claim Pi's frontmatter schema is closed", run: docCeilingJustification },
]);
