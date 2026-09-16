/**
 * Root-artifact honesty gate.
 *
 * The inventory rows for README.md, LICENSE, .gitignore, and assets/logo.png
 * must state the real relationship to upstream, not just assert package
 * presence. These tests prove each claim against the pinned clone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot } from "../support/repo-root.mjs";
import { resolveUpstreamRoot } from "../../compat/lib/inventory.mjs";

const ROOT = repoRoot(import.meta.url);
const LOCK = JSON.parse(readFileSync(join(ROOT, "upstream.lock.json"), "utf8"));
const upstream = resolveUpstreamRoot(ROOT, LOCK);

const localFile = (rel) => readFileSync(join(ROOT, rel));
const upstreamFile = (rel) => readFileSync(join(upstream.root, rel));

const LICENSE_COPYRIGHT_LINE = "Copyright (c) 2026 Lauren Tan";
const PORT_COPYRIGHT_LINE = "Copyright (c) 2026 Pi port contributors";

test("assets/logo.png is byte-identical to the pinned upstream asset", () => {
  expect(upstream, "pinned upstream clone missing; run `npm run parity:check` first").toBeTruthy();
  expect(localFile("assets/logo.png").equals(upstreamFile("assets/logo.png")), "assets/logo.png differs from the pinned upstream asset").toBeTruthy();
});

test("LICENSE equals upstream except the two-line copyright replacement", () => {
  expect(upstream, "pinned upstream clone missing; run `npm run parity:check` first").toBeTruthy();
  const upstreamLines = upstreamFile("LICENSE").toString("utf8").split("\n");
  const expected = upstreamLines.flatMap((line) =>
    line === LICENSE_COPYRIGHT_LINE ? [`${LICENSE_COPYRIGHT_LINE} (original pstack)`, PORT_COPYRIGHT_LINE] : [line],
  );
  expect(localFile("LICENSE").toString("utf8")).toBe(expected.join("\n"));
});

test(".gitignore contains every non-empty upstream line", () => {
  expect(upstream, "pinned upstream clone missing; run `npm run parity:check` first").toBeTruthy();
  const upstreamLines = upstreamFile(".gitignore")
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const localLines = new Set(localFile(".gitignore").toString("utf8").split("\n"));
  const missing = upstreamLines.filter((line) => !localLines.has(line));
  expect(missing, `local .gitignore is missing upstream lines: ${missing.join(", ")}`).toEqual([]);
});

test("README.md is the Pi rewrite with install and pointers", () => {
  expect(upstream, "pinned upstream clone missing; run `npm run parity:check` first").toBeTruthy();
  const local = localFile("README.md").toString("utf8");
  expect(local, "README.md must not be byte-equal to upstream").not.toBe(upstreamFile("README.md").toString("utf8"));
  expect(local.includes("pi install"), "README.md must document the Pi package install command").toBeTruthy();
  expect(local.includes("compat/REPORT.md"), "README.md must point at compat/REPORT.md").toBeTruthy();
  expect(local.includes("docs/HOSTED.md"), "README.md must point at docs/HOSTED.md").toBeTruthy();
});
