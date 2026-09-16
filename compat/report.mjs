#!/usr/bin/env node
/**
 * Render compat/REPORT.md from the compat artifacts.
 *
 * The report is a deterministic projection of compat/parity.json,
 * compat/capabilities.json, compat/dependencies.json, upstream.lock.json,
 * spec/differential-results.json, and package.json. It never executes a test;
 * it reports the committed differential summary and names the scripts.
 *
 *   node compat/report.mjs            # write compat/REPORT.md
 *   node compat/report.mjs --check    # exit 1 when the committed report is stale
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLASSIFICATIONS, STATUSES } from "./lib/mapping.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "compat", "REPORT.md");

const SCOPED_PREFIXES = ["skills/", "agents/", "automations/", "docs/"];
const ROOT_ARTIFACT_NAMES = ["README.md", "LICENSE", ".gitignore", "assets/logo.png", ".cursor-plugin/plugin.json"];

const VERIFY_SCRIPTS = [
  "compat:gate",
  "compat:check",
  "compat:report",
  "spec:check",
  "test:differential",
  "test:hosted",
  "conformance",
  "parity:check",
];

const EXTENSION_RESPONSIBILITIES = {
  agents: "pstack_task policy-complete entrypoint, the eight-axis policy compiler, and the child policy guard",
  benny: "pstack_benny_wake, /setup-benny, /benny-triage, and /benny-repro over the wake file",
  commands: "generated /skill:<name> and /<name> command shims",
  companions: "pstack_deslop, pstack_control_cli, and pstack_control_ui",
  "decision-log": "pstack_decision_log TSV rows under the cwd .pi allowlist",
  gates: "/pstack-gates fail-closed pre-ship check",
  heartbeat: "the pstack_loop timer and its settle/watch coalescing",
  hosted: "the services/worker client for environment=hosted runs",
  integrations: "the integration capability registry and pstack_integrations coverage reporting",
  loop: "the durable /loop run record and the DEFINE_PREDICATE..COMPLETE/BLOCKED reducer",
  models: "/setup-pstack config, budget labels, and role model resolution",
  orchestration: "pstack_swarm and pstack_arena parallel fan-out",
  "poteto-state": "sticky poteto-mode state and the todo store",
  "readonly-state": "session readonly policy and tool coercion",
  sessions: "pstack_sessions list, grep, current, and recall ranking",
  shipping: "pstack_babysit, pstack_ship, and the shared merge gate evaluator",
  subagents: "pstack_spawn, pstack_jobs, and the child runner",
  test: "test-only peer-dependency shims and extension harness entrypoints",
  worktree: "pstack_worktree create, list, remove, prune, and shutdown cleanup",
};

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

function readOptionalJson(rel) {
  const path = join(ROOT, rel);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function countBy(items, key) {
  return Object.fromEntries(STATUSES.map((value) => [value, items.filter((item) => item[key] === value).length]));
}

function isScopedPath(rel) {
  return SCOPED_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function section1(lock) {
  return [
    "## 1. Pinned upstream revision",
    "",
    `- Repository: ${lock.repository?.url ?? "unknown"}`,
    `- Path in repository: ${lock.path ?? "unknown"}`,
    `- Commit: ${lock.commit?.sha ?? "unknown"}`,
    `- Upstream plugin version: ${lock.pluginVersion ?? "unknown"}`,
    `- Captured at: ${lock.capturedAt ?? "unknown"}`,
    `- Manifest digest: ${lock.manifestDigest?.algorithm ?? "unknown"} ${lock.manifestDigest?.value ?? "unknown"}`,
    `- Scoped directories: ${(lock.scoped ?? []).join(", ")}`,
    "- Normative pin: `upstream.lock.json` is the compatibility-cycle authority. `port/upstream.json` is the machine-consumed copy and must carry the same commit.",
    ...(lock.notes ?? []).map((note) => `- Note: ${note}`),
  ];
}

function section2() {
  return [
    "## 2. Architecture before and after",
    "",
    "Before the refactor the tree held the byte-pinned upstream content (`port/`, `skills/`, `agents/`, `automations/`, `docs/`) over a behavioral ledger (`spec/`), with runtime extensions reproducing Cursor host semantics, a layered test runner, and docs. The mandate's machine-readable matrix, task policy, integration registry, loop FSM, hosted worker, and benny service did not exist (`.pi/refactor/RECON.md` section 1).",
    "",
    "The current tree adds `compat/` (the generated parity matrix, capabilities, authored dependency dispositions, and this report), `extensions/agents/` policy, `extensions/integrations/`, `extensions/loop/`, `services/worker/` with `extensions/hosted/`, and `services/benny/`. The ledger in `spec/contracts/*.tsv` stays the single source of truth, and `npm run compat:gate` proves the closed program.",
  ];
}

function extensionDirs() {
  const dir = join(ROOT, "extensions");
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .toSorted();
}

function section3() {
  const rows = extensionDirs().map((name) => [
    `\`extensions/${name}\``,
    EXTENSION_RESPONSIBILITIES[name] ?? "no responsibility recorded",
  ]);
  return [
    "## 3. Extensions and their responsibilities",
    "",
    "One row per directory under `extensions/`.",
    "",
    ...table(["Directory", "Responsibility"], rows),
    "",
    "The composition files `extensions/index.ts`, `extensions/effects.ts`, and the `sticky-*.ts` modules sit at the root rather than in a directory.",
  ];
}

function section4(parity) {
  const inventory = parity.rows.filter((row) => row.id.startsWith("inv-"));
  const scoped = inventory.filter((row) => isScopedPath(row.upstreamPath));
  const root = inventory.filter((row) => !isScopedPath(row.upstreamPath));
  const status = countBy(inventory, "status");
  return [
    "## 4. Upstream inventory totals",
    "",
    "Inventory rows are the `inv-*` rows in `compat/parity.json`, one per in-scope artifact of the pinned tree plus the root artifacts.",
    "",
    `- Inventory rows: ${inventory.length}`,
    `- Scoped artifacts (skills/, agents/, automations/, docs/): ${scoped.length}`,
    `- Root artifacts: ${root.length} (${ROOT_ARTIFACT_NAMES.join(", ")})`,
    `- By status: ${STATUSES.map((name) => `${name}=${status[name]}`).join(", ")}`,
  ];
}

function section5(parity) {
  const counts = parity.totals?.byClassification ?? {};
  const rows = CLASSIFICATIONS.map((name) => [`\`${name}\``, String(counts[name] ?? 0)]);
  return [
    "## 5. Parity totals by classification",
    "",
    "Totals over every row in `compat/parity.json` (ledger rows plus inventory rows).",
    "",
    ...table(["Classification", "Rows"], rows),
  ];
}

function section6(parity, capabilities) {
  const counts = parity.totals?.byStatus ?? {};
  const caps = capabilities.capabilities ?? [];
  const hosted = caps.filter((cap) => cap.hostedRequired).length;
  return [
    "## 6. Parity totals by verification status",
    "",
    `- ${STATUSES.map((name) => `${name}=${counts[name] ?? 0}`).join(", ")}`,
    "",
    `Capability rollup (\`compat/capabilities.json\`): ${caps.length} capabilities, ${caps.filter((cap) => cap.status === "verified").length} verified, ${hosted} hosted-required.`,
  ];
}

function section7(parity, dependencies) {
  const hosted = parity.rows.filter((row) => row.classification === "HOSTED-CAPABILITY-REQUIRED");
  const prerequisites = [...new Set(parity.rows.flatMap((row) => row.prerequisites ?? []))].toSorted();
  const hostedDeps = (dependencies.dependencies ?? []).filter((entry) => entry.disposition === "hosted");
  return [
    "## 7. Hosted prerequisites",
    "",
    "Rows classified `HOSTED-CAPABILITY-REQUIRED` need a service that does not run locally.",
    "",
    ...table(
      ["Row", "Upstream path", "Prerequisites"],
      hosted.map((row) => [`\`${row.id}\``, `\`${row.upstreamPath}\``, (row.prerequisites ?? []).join("; ") || "(none)"]),
    ),
    "",
    "**Every prerequisite named in rows**",
    "",
    ...prerequisites.map((name) => `- ${name}`),
    "",
    "**Authored hosted dispositions (`compat/dependencies.json`)**",
    "",
    ...table(
      ["Mechanism", "piMechanism", "Verification"],
      hostedDeps.map((entry) => [`\`${entry.id}\``, entry.piMechanism, `\`${entry.verification}\``]),
    ),
  ];
}

function section8(parity) {
  const exceptions = parity.rows.filter((row) => row.classification === "APPROVED-EXCEPTION");
  return [
    "## 8. Approved exceptions",
    "",
    "Every `APPROVED-EXCEPTION` row carries a non-null `exceptionJustification`.",
    "",
    ...table(
      ["Row", "Upstream path", "Justification"],
      exceptions.map((row) => [`\`${row.id}\``, `\`${row.upstreamPath}\``, row.exceptionJustification ?? "(none)"]),
    ),
  ];
}

function section9(differential) {
  if (!differential) {
    return ["## 9. Differential and conformance test results", "", "`spec/differential-results.json` is missing."];
  }
  const summary = differential.summary ?? {};
  const cases = differential.cases ?? [];
  const equal = cases.filter((entry) => entry.equal).length;
  return [
    "## 9. Differential and conformance test results",
    "",
    "Committed summary from `spec/differential-results.json`. This report never executes tests and reports only the stable fields; the runner stamps its own `generatedAt`.",
    "",
    `- Upstream commit: ${differential.upstreamCommit}`,
    `- Cases: ${summary.cases ?? cases.length}, equal: ${summary.equal ?? equal}, differ: ${summary.differ ?? cases.length - equal}`,
    "",
    "Named scripts: `npm run test:differential` executes the differential fixtures, `npm run conformance` runs the AGENTS.md conformance layer, and `npm test` runs the full layered suite.",
  ];
}

function section10(parity) {
  const unresolved = parity.rows.filter((row) => row.status === "blocked" || row.status === "unimplemented");
  const blocked = unresolved.filter((row) => row.status === "blocked").length;
  const unimplemented = unresolved.filter((row) => row.status === "unimplemented").length;
  const rows = unresolved.map((row) => [`\`${row.id}\``, `\`${row.upstreamPath}\``, row.classification, row.status]);
  return [
    "## 10. Unresolved parity defects",
    "",
    "Rows with status `blocked` or `unimplemented` in `compat/parity.json`. These are declared non-parity states, not silent gaps.",
    "",
    ...table(["Row", "Upstream path", "Classification", "Status"], rows),
    "",
    `Grouped by reason: ${unimplemented} unimplemented hosted ceiling row(s) wait on a hosted service, and ${blocked} blocked approved-exception row(s) stand in for absent host chrome or a Cursor-only loader.`,
  ];
}

function section11() {
  return [
    "## 11. Migration instructions",
    "",
    "Install the Pi package from a checkout.",
    "",
    "```bash",
    "pi install /absolute/path/to/pi-pstack",
    "```",
    "",
    "Regenerate the derived artifacts after any ledger or root-artifact change.",
    "",
    "```bash",
    "npm run compat:generate   # compat/parity.json and compat/capabilities.json",
    "npm run compat:report     # compat/REPORT.md",
    "```",
    "",
    "`npm run compat:check` fails when either generated JSON is stale, and `node compat/report.mjs --check` fails when this report is stale.",
  ];
}

function section12(scripts) {
  const missing = VERIFY_SCRIPTS.filter((name) => !scripts[name]);
  const missingLines = missing.length > 0 ? ["", `Missing package.json scripts: ${missing.join(", ")}`] : [];
  return [
    "## 12. Exact commands",
    "",
    "```bash",
    "pi install /absolute/path/to/pi-pstack",
    "npm run compat:gate",
    ...VERIFY_SCRIPTS.filter((name) => name !== "compat:gate").map((name) => `npm run ${name}`),
    "```",
    ...missingLines,
  ];
}

function renderReport({ lock, parity, capabilities, dependencies, differential, pkg }) {
  return [
    "# pstack-pi compatibility report",
    "",
    "Generated by `node compat/report.mjs` (`npm run compat:report`). Do not edit by hand. `npm run compat:gate` fails when this file is stale.",
    "",
    ...section1(lock),
    "",
    ...section2(),
    "",
    ...section3(),
    "",
    ...section4(parity),
    "",
    ...section5(parity),
    "",
    ...section6(parity, capabilities),
    "",
    ...section7(parity, dependencies),
    "",
    ...section8(parity),
    "",
    ...section9(differential),
    "",
    ...section10(parity),
    "",
    ...section11(),
    "",
    ...section12(pkg.scripts ?? {}),
    "",
  ].join("\n");
}

function checkReport(rendered) {
  if (!existsSync(REPORT_PATH)) {
    process.stderr.write("compat:report: compat/REPORT.md is missing; run `npm run compat:report`\n");
    process.exitCode = 1;
    return;
  }
  if (readFileSync(REPORT_PATH, "utf8") !== rendered) {
    process.stderr.write("compat:report: compat/REPORT.md is stale; run `npm run compat:report`\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("compat:report: compat/REPORT.md is current\n");
}

function main() {
  const check = process.argv.slice(2).includes("--check");
  const rendered = renderReport({
    lock: readJson("upstream.lock.json"),
    parity: readJson("compat/parity.json"),
    capabilities: readJson("compat/capabilities.json"),
    dependencies: readJson("compat/dependencies.json"),
    differential: readOptionalJson("spec/differential-results.json"),
    pkg: readJson("package.json"),
  });
  if (check) {
    checkReport(rendered);
    return;
  }
  writeFileSync(REPORT_PATH, rendered);
  process.stdout.write(`compat:report: wrote compat/REPORT.md (${rendered.length} bytes)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
