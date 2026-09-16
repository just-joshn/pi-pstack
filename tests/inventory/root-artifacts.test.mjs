/**
 * Root-artifact honesty gate.
 *
 * The inventory rows for README.md, LICENSE, .gitignore, and assets/logo.png
 * must state the real relationship to upstream, not just assert package
 * presence. These tests prove each claim against the pinned clone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveUpstreamRoot } from "../../compat/lib/inventory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK = JSON.parse(readFileSync(join(ROOT, "upstream.lock.json"), "utf8"));
const upstream = resolveUpstreamRoot(ROOT, LOCK);

const localFile = (rel) => readFileSync(join(ROOT, rel));
const upstreamFile = (rel) => readFileSync(join(upstream.root, rel));

const LICENSE_COPYRIGHT_LINE = "Copyright (c) 2026 Lauren Tan";
const PORT_COPYRIGHT_LINE = "Copyright (c) 2026 Pi port contributors";

test("assets/logo.png is byte-identical to the pinned upstream asset", () => {
  assert.ok(upstream, "pinned upstream clone missing; run `npm run parity:check` first");
  assert.ok(
    localFile("assets/logo.png").equals(upstreamFile("assets/logo.png")),
    "assets/logo.png differs from the pinned upstream asset",
  );
});

test("LICENSE equals upstream except the two-line copyright replacement", () => {
  assert.ok(upstream, "pinned upstream clone missing; run `npm run parity:check` first");
  const upstreamLines = upstreamFile("LICENSE").toString("utf8").split("\n");
  const expected = upstreamLines.flatMap((line) =>
    line === LICENSE_COPYRIGHT_LINE ? [`${LICENSE_COPYRIGHT_LINE} (original pstack)`, PORT_COPYRIGHT_LINE] : [line],
  );
  assert.equal(localFile("LICENSE").toString("utf8"), expected.join("\n"));
});

test(".gitignore contains every non-empty upstream line", () => {
  assert.ok(upstream, "pinned upstream clone missing; run `npm run parity:check` first");
  const upstreamLines = upstreamFile(".gitignore")
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const localLines = new Set(localFile(".gitignore").toString("utf8").split("\n"));
  const missing = upstreamLines.filter((line) => !localLines.has(line));
  assert.deepEqual(missing, [], `local .gitignore is missing upstream lines: ${missing.join(", ")}`);
});

test("README.md is the Pi rewrite with install and pointers", () => {
  assert.ok(upstream, "pinned upstream clone missing; run `npm run parity:check` first");
  const local = localFile("README.md").toString("utf8");
  assert.notEqual(local, upstreamFile("README.md").toString("utf8"), "README.md must not be byte-equal to upstream");
  assert.ok(local.includes("pi install"), "README.md must document the Pi package install command");
  assert.ok(local.includes("compat/REPORT.md"), "README.md must point at compat/REPORT.md");
  assert.ok(local.includes("docs/HOSTED.md"), "README.md must point at docs/HOSTED.md");
});
