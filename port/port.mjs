#!/usr/bin/env node
/**
 * pi-pstack port checker.
 *
 * The ported tree (skills/, agents/, automations/, docs/) is a pure function of
 * upstream pstack plus the bindings declared in bindings.mjs. This tool proves it:
 *
 *   node port/port.mjs check   exit 1 on drift, missing file, or leftover Cursor token
 *   node port/port.mjs diff    unified diff of generated vs local (one file per --file)
 *   node port/port.mjs sync    regenerate the ported tree from upstream + bindings
 *
 * Upstream source: PORT_UPSTREAM_DIR, --upstream <dir>, or a cached clone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import upstream from "./upstream.json" with { type: "json" };
import { bindings, overrides, leftoverTokens, extras } from "./bindings.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("-")) ?? "check";
const fileFlag = valueOf("--file");
const upstreamDir = valueOf("--upstream") ?? process.env.PORT_UPSTREAM_DIR ?? join(ROOT, ".port-upstream", `cursor-plugins-${upstream.commit.slice(0, 7)}`);

const TEXT_EXTENSIONS = new Set([".md", ".sh", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".tsv", ".txt"]);
const isText = (rel) => TEXT_EXTENSIONS.has(extname(rel).toLowerCase());

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function resolveUpstream() {
  const root = join(upstreamDir, upstream.subdir);
  if (existsSync(root)) {
    const head = execFileSync("git", ["-C", upstreamDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head === upstream.commit) return root;
  }
  rmSync(upstreamDir, { recursive: true, force: true });
  mkdirSync(dirname(upstreamDir), { recursive: true });
  execFileSync("git", ["clone", "--quiet", upstream.repo, upstreamDir], { stdio: "inherit" });
  execFileSync("git", ["-C", upstreamDir, "checkout", "--quiet", upstream.commit]);
  return root;
}

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".DS_Store") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

function globToRegExp(glob) {
  const segments = glob.split("/").map((seg) =>
    seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
  );
  return new RegExp(`^${segments.join("/")}$`);
}

function fileMatches(rule, rel) {
  return !rule.files || rule.files.some((g) => globToRegExp(g).test(rel));
}

function applyBindings(rel, text) {
  const applied = [];
  for (const rule of bindings) {
    if (!fileMatches(rule, rel)) continue;
    const before = text;
    if (rule.re) text = text.replace(rule.re, rule.replace);
    else if (text.includes(rule.find)) text = text.split(rule.find).join(rule.replace ?? "");
    if (text !== before) applied.push(rule.id);
  }
  return { text, applied };
}

function scanLeftovers(rel, text) {
  const hits = [];
  for (const token of leftoverTokens) {
    if (token.allow?.some((g) => fileMatches({ files: [g] }, rel))) continue;
    for (const [i, line] of text.split("\n").entries()) {
      if (token.re.test(line)) hits.push(`${token.id} line ${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

function showDiff(rel, generatedText, localText) {
  const dir = join(ROOT, ".port-upstream");
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "generated.tmp");
  const b = join(dir, "local.tmp");
  writeFileSync(a, generatedText);
  writeFileSync(b, localText);
  try {
    return execFileSync("diff", ["-u", "--label", `${rel} (upstream+bindings)`, "--label", `${rel} (local)`, a, b], { encoding: "utf8" });
  } catch (err) {
    return err.stdout ?? "";
  }
}

const root = resolveUpstream();
const files = upstream.scoped.flatMap((d) => walk(join(root, d), root)).sort();
const upstreamSet = new Set(files);
const localSet = new Set(upstream.scoped.flatMap((d) => (existsSync(join(ROOT, d)) ? walk(join(ROOT, d), ROOT) : [])));

const stats = { identical: 0, bound: 0, override: 0, drift: 0, missing: 0, loose: 0, unused: 0, localOnly: 0, undeclared: 0 };
const firedRules = new Set();

for (const rel of files) {
  if (fileFlag && rel !== fileFlag) continue;
  const localPath = join(ROOT, rel);
  if (!existsSync(localPath)) {
    console.log(`MISSING  ${rel}`);
    stats.missing++;
    continue;
  }
  const upstreamBuf = readFileSync(join(root, rel));
  const localBuf = readFileSync(localPath);

  const override = overrides[rel];
  if (override) {
    stats.override++;
    const localText = localBuf.toString("utf8");
    const missingMust = (override.must ?? []).filter((s) => !localText.includes(s));
    const hits = scanLeftovers(rel, localText);
    if (missingMust.length || hits.length) {
      console.log(`OVERRIDE FAIL  ${rel}`);
      for (const m of missingMust) console.log(`  missing upstream content: ${m.slice(0, 100)}`);
      for (const h of hits) console.log(`  leftover ${h}`);
      stats.drift++;
    }
    continue;
  }

  // Byte-identical files need no decode and no binding pass.
  if (localBuf.equals(upstreamBuf)) {
    stats.identical++;
    continue;
  }
  if (!isText(rel)) {
    console.log("BINARY DRIFT  " + rel);
    stats.drift++;
    continue;
  }

  const upstreamText = upstreamBuf.toString("utf8");
  const localText = localBuf.toString("utf8");
  const { text: generated, applied } = applyBindings(rel, upstreamText);
  for (const id of applied) firedRules.add(id);
  const loose = scanLeftovers(rel, generated);
  if (loose.length) {
    console.log(`LOOSE  ${rel}`);
    for (const h of loose) console.log(`  ${h}`);
    stats.loose++;
  }
  if (Buffer.from(generated, "utf8").equals(localBuf)) {
    if (applied.length) stats.bound++;
    else stats.identical++;
    continue;
  }
  stats.drift++;
  const label = generated === localText ? "BYTE DRIFT" : "DRIFT";
  if (cmd === "diff" || cmd === "sync") {
    console.log(`${label}  ${rel} (applied: ${applied.join(", ") || "none"})`);
    if (cmd === "diff") console.log(showDiff(rel, generated, localText));
    continue;
  }
  console.log(`${label}  ${rel} (applied: ${applied.join(", ") || "none"})`);
}

if (cmd === "sync") {
  let written = 0;
  for (const rel of files) {
    if (overrides[rel]) continue;
    const upstreamBuf = readFileSync(join(root, rel));
    const localPath = join(ROOT, rel);
    const localBuf = existsSync(localPath) ? readFileSync(localPath) : null;
    if (!isText(rel)) {
      if (!localBuf || !localBuf.equals(upstreamBuf)) {
        console.log(`REFUSING to sync binary ${rel}`);
        process.exitCode = 1;
      }
      continue;
    }
    const generated = applyBindings(rel, upstreamBuf.toString("utf8")).text;
    const generatedBuf = Buffer.from(generated, "utf8");
    if (localBuf && generatedBuf.equals(localBuf)) continue;
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, generatedBuf);
    written++;
  }
  console.log(`sync: wrote ${written} file(s)`);
}

if (cmd === "rules") {
  for (const rule of bindings) console.log(`${firedRules.has(rule.id) ? "used  " : "UNUSED"}  ${rule.id}`);
  process.exitCode = firedRules.size === bindings.length ? 0 : 1;
}

const unusedRules = fileFlag ? [] : bindings.filter((r) => !firedRules.has(r.id));
for (const rule of unusedRules) console.log(`UNUSED RULE  ${rule.id}`);
stats.unused = unusedRules.length;

const extrasList = [...localSet].filter((f) => !upstreamSet.has(f)).sort();
for (const rel of extrasList) {
  if (extras[rel]) console.log(`EXTRA  ${rel} (declared local-only)`);
  else {
    console.log(`EXTRA  ${rel} (undeclared local-only)`);
    stats.undeclared++;
  }
  stats.localOnly++;
}

console.log(
  `\n${files.length} upstream files: ${stats.identical} identical, ${stats.bound} bound, ${stats.override} override, ${stats.drift} drift, ${stats.loose} loose, ${stats.missing} missing; ${bindings.length - stats.unused}/${bindings.length} rules fired; local-only ${stats.localOnly} (${stats.undeclared} undeclared)`,
);
if ((stats.drift || stats.missing || stats.loose || stats.unused || stats.undeclared) && cmd === "check") process.exitCode = 1;
