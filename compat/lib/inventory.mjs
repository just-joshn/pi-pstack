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

function inventoryRow(lock, rel) {
  const deferred = DEFERRED_ROOT.has(rel);
  const scoped = rel.startsWith("skills/") || rel.startsWith("agents/") || rel.startsWith("automations/") || rel.startsWith("docs/");
  return {
    id: `inv-${slugify(rel)}`,
    category: inventoryCategory(rel),
    upstreamRevision: lock.commit.sha,
    upstreamPath: rel,
    behavior: scoped
      ? `The pinned upstream artifact ${rel} is byte-equal to the declared bindings applied to the pin and covered by the parity matrix.`
      : `The root artifact ${rel} ships in the package and is covered by the parity matrix.`,
    observableContract: scoped ? ["gate@parity:check"] : ["content manifest"],
    classification: deferred ? "APPROVED-EXCEPTION" : "EXACT-CONTRACT",
    piMechanism: scoped ? ["port/port.mjs"] : ["package.json"],
    prerequisites: [],
    tests: [],
    normalization: [],
    status: deferred ? "blocked" : scoped ? "verified" : "implemented",
    evidence: scoped ? ["port/port.mjs"] : ["package.json"],
    divergences: [],
    exceptionJustification: deferred
      ? "Cursor's .cursor-plugin loader has no Pi equivalent; the Pi package manifest replaces it and the content surface is the twin."
      : null,
  };
}

export function buildInventoryRows(lock, artifacts) {
  return artifacts.filter((rel) => !matchesAggregateGlob(rel)).map((rel) => inventoryRow(lock, rel));
}
