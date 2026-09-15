#!/usr/bin/env node
/**
 * Contract check: every pstack_* tool the ported docs name must be registered
 * by an extension, and every scripts/... path a skill names must exist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
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
    if (!referenced.has(m[0])) referenced.set(m[0], []);
    referenced.get(m[0]).push(rel);
  }
}

const unknown = [...referenced.keys()].filter((t) => !registered.has(t)).sort();
for (const tool of unknown) {
  const files = [...new Set(referenced.get(tool))].slice(0, 4).join(", ");
  console.log(`UNKNOWN TOOL  ${tool} (named in ${files})`);
}

const scriptIndex = new Set(walk(join(ROOT, "skills")).map((p) => `skills/${p}`));
// Example rows in show-me-your-work's TSV sample name a hypothetical script.
const illustrativeRefs = new Set(["scripts/snapshot.sh"]);
const scriptRefs = [];
for (const rel of docFiles) {
  if (!rel.endsWith(".md")) continue;
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const m of text.matchAll(/scripts\/[\w./-]+/g)) {
    const ref = m[0].replace(/[.,)]$/, "");
    if (illustrativeRefs.has(ref)) continue;
    if (![...scriptIndex].some((p) => p.endsWith(`/${ref}`) || p.endsWith(ref))) scriptRefs.push(`${ref} (named in ${rel})`);
  }
}
for (const ref of scriptRefs) console.log(`MISSING SCRIPT  ${ref}`);

console.log(`${registered.size} registered tools, ${referenced.size} named in docs, ${unknown.length} unknown; ${scriptRefs.length} missing script paths`);
if (unknown.length || scriptRefs.length) process.exitCode = 1;
