#!/usr/bin/env node
/**
 * Contract check: every pstack_* tool the ported docs name must be registered
 * by an extension, and every scripts/... path a skill names must exist.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import upstream from "./upstream.json" with { type: "json" };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function out(line) {
  process.stdout.write(String(line) + "\n");
}

function valueOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Resolve the pinned upstream tree the same way port.mjs does, without cloning. */
function resolveUpstreamRoot() {
  const upstreamDir =
    valueOf("--upstream") ??
    process.env.PORT_UPSTREAM_DIR ??
    join(ROOT, ".port-upstream", `cursor-plugins-${upstream.commit.slice(0, 7)}`);
  const root = join(upstreamDir, upstream.subdir);
  if (!existsSync(root)) return null;
  try {
    const head = execFileSync("git", ["-C", upstreamDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== upstream.commit) return null;
  } catch {
    return null;
  }
  return root;
}

function walk(dir, base = dir) {
  return readdirSync(dir).reduce((acc, name) => {
    if (name === ".DS_Store") return acc;
    const p = join(dir, name);
    return statSync(p).isDirectory() ? acc.concat(walk(p, base)) : acc.concat([relative(base, p)]);
  }, []);
}

const extensionFiles = walk(join(ROOT, "extensions")).filter((f) => f.endsWith(".ts"));
const registered = new Set();
for (const rel of extensionFiles) {
  const text = readFileSync(join(ROOT, "extensions", rel), "utf8");
  for (const m of text.matchAll(/name:\s*"(pstack_[a-z_]+)"/g)) registered.add(m[1]);
}

const docDirs = ["skills", "agents", "automations", "docs"];
const docFiles = docDirs.flatMap((d) => (existsSync(join(ROOT, d)) ? walk(join(ROOT, d), ROOT) : []));
const referenced = new Map();
for (const rel of docFiles) {
  if (!/\.(md|sh)$/.test(rel)) continue;
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const m of text.matchAll(/\bpstack_[a-z_]+/g)) {
    const prev = referenced.get(m[0]) ?? [];
    referenced.set(m[0], [...prev, rel]);
  }
}

const unknown = [...referenced.keys()].filter((t) => !registered.has(t)).toSorted();
for (const tool of unknown) {
  const files = [...new Set(referenced.get(tool))].slice(0, 4).join(", ");
  out(`UNKNOWN TOOL  ${tool} (named in ${files})`);
}

const scriptIndex = new Set(walk(join(ROOT, "skills")).map((p) => `skills/${p}`));
// Example rows in show-me-your-work's TSV sample name a hypothetical script.
const illustrativeRefs = new Set(["scripts/snapshot.sh"]);
const scriptRefs = docFiles
  .filter((rel) => rel.endsWith(".md"))
  .flatMap((rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    return [...text.matchAll(/scripts\/[\w./-]+/g)].flatMap((m) => {
      const ref = m[0].replace(/[.,)]$/, "");
      if (illustrativeRefs.has(ref)) return [];
      const exists = [...scriptIndex].some((p) => p.endsWith(`/${ref}`) || p.endsWith(ref));
      return exists ? [] : [`${ref} (named in ${rel})`];
    });
  });
for (const ref of scriptRefs) out(`MISSING SCRIPT  ${ref}`);

const upstreamRoot = resolveUpstreamRoot();
let modeDrift = 0;
if (!upstreamRoot) {
  out("MODE PARITY FAIL  no upstream tree resolvable (set PORT_UPSTREAM_DIR/--upstream or run port.mjs check first to seed the cache)");
  modeDrift = 1;
} else {
  for (const rel of [...scriptIndex]) {
    const localPath = join(ROOT, rel);
    const upstreamPath = join(upstreamRoot, rel);
    if (!existsSync(upstreamPath)) continue;
    const localExec = (statSync(localPath).mode & 0o111) !== 0;
    const upstreamExec = (statSync(upstreamPath).mode & 0o111) !== 0;
    if (localExec !== upstreamExec) {
      out(`MODE DRIFT  ${rel} (local ${localExec ? "+x" : "-x"}, upstream ${upstreamExec ? "+x" : "-x"})`);
      modeDrift = modeDrift + 1;
    }
  }
}

out(
  `${registered.size} registered tools, ${referenced.size} named in docs, ${unknown.length} unknown; ${scriptRefs.length} missing script paths; ${modeDrift} mode drift`,
);
if (unknown.length || scriptRefs.length || modeDrift) process.exitCode = 1;
