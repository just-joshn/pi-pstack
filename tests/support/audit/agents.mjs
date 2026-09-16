/**
 * AGENTS-01..AGENTS-03: the AGENTS.md house rules the conformance checker is
 * supposed to enforce, checked against the checker and against the owned tree.
 */
import { readFileSync } from "node:fs";
import { fail, pass, repoPath, runProcess, verdict } from "./harness.mjs";

const MAX_EXTENSION_LINES = 400;

const MUTATION_CASES = Object.freeze([
  { label: "property assignment", source: "const obj = {};\nexport function f() {\n  obj.prop = 1;\n}\n" },
  { label: "compound assignment", source: "const state = { n: 0 };\nexport function f() {\n  state.n += 1;\n}\n" },
  { label: "Map.set", source: "const m = new Map();\nexport function f(k, v) {\n  m.set(k, v);\n}\n" },
  { label: "Set.add", source: "const s = new Set();\nexport function f(x) {\n  s.add(x);\n}\n" },
  { label: "index assignment", source: "const arr = [0];\nexport function f() {\n  arr[0] = 1;\n}\n" },
]);

const FLOATING_SOURCES = Object.freeze([
  "extensions/subagents/child-runner.ts",
  "extensions/heartbeat/index.ts",
]);

const FLOATING_PATTERN = /void\s+(?:\(async|[A-Za-z_$][\w$.]*\s*\()/g;

async function agentsMutationRules() {
  const rules = await import(new URL("../conformance/rules.mjs", import.meta.url));
  const misses = MUTATION_CASES.filter((testCase) => {
    const violations = rules.auditSource(testCase.source, { owned: true });
    return !violations.some((violation) => violation.rule === "mutation");
  });
  return verdict(
    misses.length === 0,
    `auditSource flags all ${MUTATION_CASES.length} shared-state mutation forms`,
    `auditSource misses ${misses.length}/${MUTATION_CASES.length} mutation forms on module-level shared state: ${misses.map((m) => m.label).join(", ")}`,
  );
}

async function ownedExtensionFiles() {
  const run = await runProcess("git", ["ls-files", "extensions"]);
  return run.stdout
    .split("\n")
    .filter((name) => name.endsWith(".ts") && !name.startsWith("extensions/test/"));
}

async function agentsFileSize() {
  const files = await ownedExtensionFiles();
  if (files.length === 0) return fail("git ls-files listed no owned extension sources");
  const offenders = files
    .map((relative) => ({ relative, lines: readFileSync(repoPath(relative), "utf8").split("\n").length }))
    .filter((entry) => entry.lines > MAX_EXTENSION_LINES)
    .toSorted((a, b) => b.lines - a.lines);
  return verdict(
    offenders.length === 0,
    `all ${files.length} owned extension files are at or under ${MAX_EXTENSION_LINES} lines`,
    `${offenders.length}/${files.length} owned extension files exceed ${MAX_EXTENSION_LINES} lines: ${offenders.map((o) => `${o.relative} (${o.lines})`).join(", ")}`,
  );
}

function floatingPromises(relative) {
  const lines = readFileSync(repoPath(relative), "utf8").split("\n");
  return lines.flatMap((line, index) => {
    FLOATING_PATTERN.lastIndex = 0;
    if (!FLOATING_PATTERN.test(line)) return [];
    const tail = lines.slice(index, index + 60).join("\n");
    const scope = tail.slice(0, tail.indexOf("\n}") + 2 || tail.length);
    return scope.includes(".catch(") ? [] : [`${relative}:${index + 1} ${line.trim()}`];
  });
}

async function agentsFloatingPromises() {
  const offenders = FLOATING_SOURCES.flatMap(floatingPromises);
  if (offenders.length === 0) {
    return pass(`no unhandled floating promise in ${FLOATING_SOURCES.join(", ")}`);
  }
  return fail(
    `${offenders.length} floating promise(s) without an attached .catch(): ${offenders.join(" ; ")}`,
  );
}

export const AGENTS_PREDICATES = Object.freeze([
  { id: "AGENTS-01", description: "conformance auditSource catches broader shared-state mutation", run: agentsMutationRules },
  { id: "AGENTS-02", description: `no owned extension file exceeds ${MAX_EXTENSION_LINES} lines`, run: agentsFileSize },
  { id: "AGENTS-03", description: "child-runner and heartbeat attach .catch() to every floating promise", run: agentsFloatingPromises },
]);
