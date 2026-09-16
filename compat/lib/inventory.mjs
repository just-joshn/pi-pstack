/** Enumerate the in-scope artifacts of the pinned upstream tree. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Aggregate coverage declarations: artifacts matched here must not get their own row. */
export const AGGREGATE_GLOBS = ["docs/guide/images/*"];

export const ROOT_ARTIFACTS = [
  "README.md",
  "LICENSE",
  ".gitignore",
  "assets/logo.png",
  ".cursor-plugin/plugin.json",
];

const DEFERRED_ROOT = new Set([".cursor-plugin/plugin.json"]);

const SCOPED_PREFIXES = ["skills/", "agents/", "automations/", "docs/"];

/**
 * Ground truth for root artifacts that are not a byte-equal copy of upstream.
 * Each row states the real relationship and points at the test that proves it.
 */
export const ROOT_ARTIFACT_META = {
  "assets/logo.png": {
    behavior: "The root artifact assets/logo.png is byte-identical to the pinned upstream asset.",
    classification: "EXACT-CONTRACT",
    piMechanism: ["package.json"],
    status: "verified",
    evidence: ["tests/inventory/root-artifacts.test.mjs"],
    divergences: [],
  },
  LICENSE: {
    behavior: "The root artifact LICENSE keeps the upstream MIT text and adds a second copyright line for the Pi port contributors.",
    classification: "ADAPTED-EQUIVALENT",
    piMechanism: ["package.json"],
    status: "verified",
    evidence: ["tests/inventory/root-artifacts.test.mjs"],
    divergences: [
      "Upstream line 3 `Copyright (c) 2026 Lauren Tan` becomes two lines: `Copyright (c) 2026 Lauren Tan (original pstack)` and `Copyright (c) 2026 Pi port contributors`.",
    ],
  },
  ".gitignore": {
    behavior: "The root artifact .gitignore keeps every non-empty upstream line and adds the Pi-port entries .pi/, .port-upstream/, and .pstack-worktrees/.",
    classification: "ADAPTED-EQUIVALENT",
    piMechanism: ["package.json"],
    status: "verified",
    evidence: ["tests/inventory/root-artifacts.test.mjs"],
    divergences: [
      "Line-wise superset of upstream: node_modules/, .DS_Store, and *.log are retained; .pi/, .port-upstream/, and .pstack-worktrees/ are added.",
    ],
  },
  "README.md": {
    behavior: "The root artifact README.md is the Pi package README, not the Cursor plugin README.",
    classification: "ADAPTED-EQUIVALENT",
    piMechanism: ["package.json"],
    status: "verified",
    evidence: ["tests/inventory/root-artifacts.test.mjs"],
    divergences: ["Pi rewrite; upstream README describes the Cursor plugin install."],
  },
};

export function resolveUpstreamRoot(repoRoot, lock) {
  const commit = String(lock.commit?.sha ?? "");
  const cloneDir = process.env.PORT_UPSTREAM_DIR ?? join(repoRoot, ".port-upstream", `cursor-plugins-${commit.slice(0, 7)}`);
  const root = join(cloneDir, lock.path ?? "pstack");
  return existsSync(root) ? { cloneDir, root } : null;
}

function walk(dir, base, acc) {
  if (!existsSync(dir)) return acc;
  return readdirSync(dir).reduce((next, name) => {
    if (name === ".DS_Store" || name === "node_modules") return next;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full, base, next);
    return [...next, full.slice(base.length + 1)];
  }, acc);
}

export function walkArtifacts(root, scoped) {
  const scopedFiles = scoped.flatMap((dir) => walk(join(root, dir), root, []));
  const rootFiles = ROOT_ARTIFACTS.filter((name) => existsSync(join(root, name)));
  return [...scopedFiles, ...rootFiles].toSorted();
}

function globToRegExp(glob) {
  const segments = glob
    .split("/")
    .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")));
  return new RegExp(`^${segments.join("/")}$`);
}

export function matchesAggregateGlob(rel) {
  return AGGREGATE_GLOBS.some((glob) => globToRegExp(glob).test(rel));
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function inventoryCategory(rel) {
  if (rel.startsWith("agents/")) return "agent";
  if (rel.startsWith("automations/")) return "integration";
  if (rel.includes("playbooks/")) return "playbook";
  if (rel.startsWith("skills/") && rel.includes("/scripts/")) return "dependency";
  if (rel.startsWith("skills/") || rel.startsWith("docs/")) return "skill";
  if (/\.(sh|ts|mjs|js|cjs)$/.test(rel)) return "dependency";
  return "config";
}

function isScoped(rel) {
  return SCOPED_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function baseRow(lock, rel) {
  return {
    id: `inv-${slugify(rel)}`,
    category: inventoryCategory(rel),
    upstreamRevision: lock.commit.sha,
    upstreamPath: rel,
    observableContract: ["content manifest"],
    prerequisites: [],
    tests: [],
    normalization: [],
    divergences: [],
    exceptionJustification: null,
  };
}

function scopedRow(lock, rel) {
  return {
    ...baseRow(lock, rel),
    behavior: `The pinned upstream artifact ${rel} is byte-equal to the declared bindings applied to the pin and covered by the parity matrix.`,
    classification: "EXACT-CONTRACT",
    piMechanism: ["port/port.mjs"],
    status: "verified",
    evidence: ["port/port.mjs"],
  };
}

function deferredRootRow(lock, rel) {
  return {
    ...baseRow(lock, rel),
    behavior: `The root artifact ${rel} ships in the package and is covered by the parity matrix.`,
    classification: "APPROVED-EXCEPTION",
    piMechanism: ["package.json"],
    status: "blocked",
    evidence: ["package.json"],
    exceptionJustification:
      "Cursor's .cursor-plugin loader has no Pi equivalent; the Pi package manifest replaces it and the content surface is the twin.",
  };
}

function metaRootRow(lock, rel, meta) {
  return {
    ...baseRow(lock, rel),
    behavior: meta.behavior,
    classification: meta.classification,
    piMechanism: meta.piMechanism,
    status: meta.status,
    evidence: meta.evidence,
    divergences: meta.divergences,
  };
}

function genericRootRow(lock, rel) {
  return {
    ...baseRow(lock, rel),
    behavior: `The root artifact ${rel} ships in the package and is covered by the parity matrix.`,
    classification: "EXACT-CONTRACT",
    piMechanism: ["package.json"],
    status: "implemented",
    evidence: ["package.json"],
  };
}

function inventoryRow(lock, rel) {
  if (DEFERRED_ROOT.has(rel)) return deferredRootRow(lock, rel);
  const meta = ROOT_ARTIFACT_META[rel];
  if (meta) return metaRootRow(lock, rel, meta);
  return isScoped(rel) ? scopedRow(lock, rel) : genericRootRow(lock, rel);
}

export function buildInventoryRows(lock, artifacts) {
  return artifacts.filter((rel) => !matchesAggregateGlob(rel)).map((rel) => inventoryRow(lock, rel));
}
