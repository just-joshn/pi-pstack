/**
 * Inventory gate: every in-scope artifact of the pinned upstream tree is covered
 * by a compat/parity.json row (or an aggregate glob), and no row points at an
 * upstream path the tree does not contain. A pin bump that adds an artifact
 * fails here.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isUpstreamPath } from "../../compat/lib/mapping.mjs";
import { matchesAggregateGlob, resolveUpstreamRoot, walkArtifacts } from "../../compat/lib/inventory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PARITY = JSON.parse(readFileSync(join(ROOT, "compat", "parity.json"), "utf8"));
const LOCK = JSON.parse(readFileSync(join(ROOT, "upstream.lock.json"), "utf8"));

const upstream = resolveUpstreamRoot(ROOT, LOCK);

test("pinned upstream tree is resolvable", () => {
  assert.ok(
    upstream,
    "no pinned upstream clone found; run `npm run parity:check` to populate .port-upstream/cursor-plugins-<sha7> or set PORT_UPSTREAM_DIR",
  );
});

test("every in-scope upstream artifact is covered by a parity row", () => {
  assert.ok(upstream, "pinned upstream clone missing; run `npm run parity:check` first");
  const artifacts = walkArtifacts(upstream.root, LOCK.scoped ?? []);
  const covered = new Set(PARITY.rows.map((row) => row.upstreamPath));
  const uncovered = artifacts.filter((rel) => !covered.has(rel) && !matchesAggregateGlob(rel));
  assert.ok(uncovered.length === 0, `uncovered upstream artifacts:\n${uncovered.map((rel) => `  ${rel}`).join("\n")}`);
});

test("every row pointing at an upstream path names a file in the tree", () => {
  assert.ok(upstream, "pinned upstream clone missing; run `npm run parity:check` first");
  const absent = PARITY.rows
    .filter((row) => isUpstreamPath(row.upstreamPath))
    .filter((row) => !existsSync(join(upstream.root, row.upstreamPath)))
    .map((row) => `${row.id} -> ${row.upstreamPath}`);
  assert.ok(absent.length === 0, `rows point at absent upstream paths:\n${absent.map((line) => `  ${line}`).join("\n")}`);
});
