import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { auditSource } from "../../support/conformance/rules.mjs";
import { collectViolations } from "../../support/conformance/collect.mjs";
import { scanFrames, sanitize } from "../../support/conformance/scan.mjs";

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("scanFrames reports declaration, arrow, and method spans", () => {
  const source = [
    "function alpha() {",
    "  return 1;",
    "}",
    "",
    "const beta = () => {",
    "  return 2;",
    "};",
    "",
    "const obj = {",
    "  gamma() {",
    "    return 3;",
    "  },",
    "};",
  ].join("\n");
  const named = scanFrames(source).frames.filter((frame) => frame.kind !== "block");
  assert.deepEqual(
    named.map((frame) => [frame.name, frame.startLine, frame.endLine]),
    [
      ["alpha", 1, 3],
      ["beta", 5, 7],
      ["gamma", 10, 12],
    ],
  );
});

test("sanitize masks strings, templates, comments, and regex without shifting lines", () => {
  const source = ['const a = "push(" + `splice(`;', "// console.log(x)", "const b = /delete\\s+/;", "const c = 1;"].join(
    "\n",
  );
  const clean = sanitize(source);
  assert.equal(clean.split("\n").length, source.split("\n").length);
  assert.equal(clean.includes("push("), false);
  assert.equal(clean.includes("splice("), false);
  assert.equal(clean.includes("console.log"), false);
  assert.equal(clean.includes("delete"), false);
  assert.equal(clean.includes("const c = 1;"), true);
});

test("auditSource flags each banned construct with its line number", () => {
  const source = [
    "function f(items) {",
    "  items.push(1);",
    "  let i = 0;",
    "  i++;",
    "  try { g(); } catch {}",
    "  delete items.x;",
    "  console.log(i);",
    "}",
  ].join("\n");
  assert.deepEqual(
    auditSource(source).map((violation) => `${violation.rule}:${violation.line}`),
    ["mutation:2", "increment:4", "empty-catch:5", "delete:6", "console.log:7"],
  );
});

test("auditSource flags a function body longer than 50 lines", () => {
  const body = "  const x = 1;\n".repeat(51);
  const source = `function big() {\n${body}}\n`;
  const hits = auditSource(source).filter((violation) => violation.rule === "function>50");
  assert.deepEqual(hits.map((hit) => hit.detail), ["big spans 53 lines"]);
});

test("auditSource flags control nesting beyond four levels", () => {
  const source = [
    "function f() {",
    "  if (a) {",
    "    for (;;) {",
    "      while (b) {",
    "        switch (c) {",
    "          case 1:",
    "            if (d) { x(); }",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
  assert.deepEqual(
    auditSource(source).map((violation) => violation.rule),
    ["nesting>4"],
  );
});

test("auditSource flags a file longer than 800 lines and passes the boundary", () => {
  const atLimit = "const x = 1;\n".repeat(799) + "const y = 2;";
  const overLimit = `${atLimit}\nconst z = 3;`;
  assert.equal(auditSource(atLimit).length, 0);
  assert.deepEqual(
    auditSource(overLimit).map((violation) => violation.rule),
    ["file>800"],
  );
});

test("auditSource returns no violations for clean source and rejects non-strings", () => {
  assert.deepEqual(auditSource("export const add = (a, b) => a + b;\n"), []);
  assert.throws(() => auditSource(null), /expects source text/);
  assert.throws(() => auditSource(undefined), /expects source text/);
});

test("the checker's own modules pass its rules", () => {
  const files = [
    join(TESTS_DIR, "conformance.mjs"),
    join(TESTS_DIR, "support", "conformance", "scan.mjs"),
    join(TESTS_DIR, "support", "conformance", "rules.mjs"),
    join(TESTS_DIR, "support", "conformance", "collect.mjs"),
  ];
  for (const file of files) {
    assert.deepEqual(auditSource(readFileSync(file, "utf8")), [], `${file} must be conformant`);
  }
});

test("collectViolations walks roots, keeps only offenders, and partitions severity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-pstack-conformance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "extensions"));
  mkdirSync(join(dir, "skills"));
  writeFileSync(join(dir, "extensions", "bad.ts"), "export function f(items) {\n  items.push(1);\n}\n");
  writeFileSync(join(dir, "skills", "bad.ts"), "export function f(items) {\n  items.push(1);\n}\n");
  writeFileSync(join(dir, "extensions", "clean.ts"), "export const add = (a, b) => a + b;\n");

  const owned = collectViolations({ base: dir, roots: ["extensions"] });
  assert.deepEqual(
    owned.map((entry) => [entry.file, entry.violations[0].rule, entry.violations[0].severity]),
    [["extensions/bad.ts", "mutation", "error"]],
  );
  const ported = collectViolations({ base: dir, roots: ["skills"], owned: false });
  assert.deepEqual(
    ported.map((entry) => [entry.file, entry.violations[0].severity]),
    [["skills/bad.ts", "warn"]],
  );
});
