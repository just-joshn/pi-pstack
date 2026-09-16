import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditSource } from "../../support/conformance/rules.mjs";
import { collectViolations } from "../../support/conformance/collect.mjs";
import { scanFrames, sanitize } from "../../support/conformance/scan.mjs";
import { repoRoot } from "../../support/repo-root.mjs";

const TESTS_DIR = join(repoRoot(import.meta.url), "tests");

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
  expect(named.map((frame) => [frame.name, frame.startLine, frame.endLine])).toEqual([
      ["alpha", 1, 3],
      ["beta", 5, 7],
      ["gamma", 10, 12],
    ]);
});

test("scanFrames spans typed and generic signatures", () => {
  const source = [
    "function typed(): string {",
    "  return \"a\";",
    "}",
    "",
    "async function generic<T>(value: T): Promise<T> {",
    "  return value;",
    "}",
    "",
    "const obj = {",
    "  async run(input: string): Promise<number> {",
    "    return input.length;",
    "  },",
    "};",
    "",
    "function bad(): void {",
    "  const filler = 1;",
    "}",
  ].join("\n");
  const named = scanFrames(source).frames.filter((frame) => frame.kind !== "block");
  expect(named.map((frame) => [frame.name, frame.startLine, frame.endLine])).toEqual([
      ["typed", 1, 3],
      ["generic", 5, 7],
      ["run", 10, 12],
      ["bad", 15, 17],
    ]);
});

test("auditSource flags a typed function body longer than 50 lines", () => {
  const body = "  const x = 1;\n".repeat(51);
  const hits = auditSource(`function big(): Promise<void> {\n${body}}\n`).filter(
    (violation) => violation.rule === "function>50",
  );
  expect(hits.map((hit) => hit.detail)).toEqual(["big spans 53 lines"]);
});

test("sanitize masks strings, templates, comments, and regex without shifting lines", () => {
  const source = ['const a = "push(" + `splice(`;', "// console.log(x)", "const b = /delete\\s+/;", "const c = 1;"].join(
    "\n",
  );
  const clean = sanitize(source);
  expect(clean.split("\n").length).toBe(source.split("\n").length);
  expect(clean.includes("push(")).toBe(false);
  expect(clean.includes("splice(")).toBe(false);
  expect(clean.includes("console.log")).toBe(false);
  expect(clean.includes("delete")).toBe(false);
  expect(clean.includes("const c = 1;")).toBe(true);
});

test("auditSource flags secrets inside string and template literals", () => {
  const key = ["sk", "a".repeat(24)].join("-");
  const source = [`const fromString = "${key}";`, `const fromTemplate = \`${key}\`;`].join("\n");
  expect(auditSource(source).map((violation) => `${violation.rule}:${violation.line}`)).toEqual(["secret:1", "secret:2"]);
});

test("auditSource flags scoped OpenAI key formats", () => {
  const key = ["sk", "proj", "b".repeat(40)].join("-");
  expect(auditSource(`const apiKey = "${key}";`).map((violation) => `${violation.rule}:${violation.line}`)).toEqual(["secret:1"]);
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
  expect(auditSource(source).map((violation) => `${violation.rule}:${violation.line}`)).toEqual(["mutation:2", "increment:4", "empty-catch:5", "delete:6", "console.log:7"]);
});

const SHARED_STATE_WRITES = [
  { label: "property assignment", source: "const obj = {};\nexport function f() {\n  obj.prop = 1;\n}\n" },
  { label: "compound assignment", source: "const state = { n: 0 };\nexport function f() {\n  state.n += 1;\n}\n" },
  { label: "Map.set", source: "const m = new Map();\nexport function f(k, v) {\n  m.set(k, v);\n}\n" },
  { label: "Set.add", source: "const s = new Set();\nexport function f(x) {\n  s.add(x);\n}\n" },
  { label: "index assignment", source: "const arr = [0];\nexport function f() {\n  arr[0] = 1;\n}\n" },
];

test("auditSource flags every shared-state write form at its own line", () => {
  for (const { label, source } of SHARED_STATE_WRITES) {
    const hits = auditSource(source).filter((violation) => violation.rule === "mutation");
    expect(hits.length, `${label} is reported once`).toBe(1);
    expect(hits[0].line, `${label} reports the write line`).toBe(3);
    expect(hits[0].scope, `${label} is classified as module scope`).toBe("module");
    expect(hits[0].detail, `${label} names the receiver`).toMatch(/module-level/);
  }
});

test("auditSource follows a property chain to its module-level root", () => {
  const source = "const config = { db: { timeout: 1 } };\nexport function f() {\n  config.db.timeout = 5;\n}\n";
  const hits = auditSource(source).filter((violation) => violation.rule === "mutation");
  expect(hits.map((hit) => [hit.line, hit.scope])).toEqual([[3, "module"]]);
});

test("auditSource leaves a local array push to the container-call rule", () => {
  const violations = auditSource("export function f() {\n  const acc = [];\n  acc.push(1);\n}\n");
  expect(violations.map((violation) => violation.rule), "the unconditional container-call rule still fires").toEqual(["mutation"]);
  expect(violations.filter((violation) => violation.scope === "module"), "a function-local accumulator is not shared state").toEqual([]);
});

test("auditSource does not report a parameter or a read-only module object", () => {
  const parameter = "export function f(state) {\n  state.n = 1;\n}\n";
  const readOnly = "const config = { timeout: 1 };\nexport function f() {\n  return config.timeout;\n}\n";
  expect(auditSource(parameter)).toEqual([]);
  expect(auditSource(readOnly)).toEqual([]);
});

test("auditSource ignores module-initiation writes, this.x, and a regex cursor", () => {
  const atInit = "const seen = [0];\nfor (const step of [1]) {\n  seen[0] = step;\n}\n";
  const ownField = "export function f() {\n  this.x = 1;\n}\n";
  const cursor = "const re = /a/g;\nexport function f() {\n  re.lastIndex = 0;\n}\n";
  expect(auditSource(atInit)).toEqual([]);
  expect(auditSource(ownField)).toEqual([]);
  expect(auditSource(cursor)).toEqual([]);
});

test("auditSource flags a function body longer than 50 lines", () => {
  const body = "  const x = 1;\n".repeat(51);
  const source = `function big() {\n${body}}\n`;
  const hits = auditSource(source).filter((violation) => violation.rule === "function>50");
  expect(hits.map((hit) => hit.detail)).toEqual(["big spans 53 lines"]);
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
  expect(auditSource(source).map((violation) => violation.rule)).toEqual(["nesting>4"]);
});

test("auditSource flags a file longer than 800 lines and passes the boundary", () => {
  const atLimit = "const x = 1;\n".repeat(799) + "const y = 2;";
  const overLimit = `${atLimit}\nconst z = 3;`;
  expect(auditSource(atLimit).length).toBe(0);
  expect(auditSource(overLimit).map((violation) => violation.rule)).toEqual(["file>800"]);
});

test("auditSource returns no violations for clean source and rejects non-strings", () => {
  expect(auditSource("export const add = (a, b) => a + b;\n")).toEqual([]);
  expect(() => auditSource(null)).toThrow(/expects source text/);
  expect(() => auditSource(undefined)).toThrow(/expects source text/);
});

test("the checker's own modules pass its rules", () => {
  const files = [
    join(TESTS_DIR, "conformance.mjs"),
    join(TESTS_DIR, "support", "conformance", "scan.mjs"),
    join(TESTS_DIR, "support", "conformance", "rules.mjs"),
    join(TESTS_DIR, "support", "conformance", "collect.mjs"),
  ];
  for (const file of files) {
    expect(auditSource(readFileSync(file, "utf8")), `${file} must be conformant`).toEqual([]);
  }
});

test("collectViolations walks roots, keeps only offenders, and partitions severity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-pstack-conformance-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "extensions"));
  mkdirSync(join(dir, "skills"));
  writeFileSync(join(dir, "extensions", "bad.ts"), "export function f(items) {\n  items.push(1);\n}\n");
  writeFileSync(join(dir, "skills", "bad.ts"), "export function f(items) {\n  items.push(1);\n}\n");
  writeFileSync(join(dir, "extensions", "clean.ts"), "export const add = (a, b) => a + b;\n");

  const owned = collectViolations({ base: dir, roots: ["extensions"] });
  expect(owned.map((entry) => [entry.file, entry.violations[0].rule, entry.violations[0].severity])).toEqual([["extensions/bad.ts", "mutation", "error"]]);
  const ported = collectViolations({ base: dir, roots: ["skills"], owned: false });
  expect(ported.map((entry) => [entry.file, entry.violations[0].severity])).toEqual([["skills/bad.ts", "warn"]]);
});
