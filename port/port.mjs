#!/usr/bin/env node
/**
 * pi-pstack port checker.
 *
 * The ported tree (skills/, agents/, automations/, docs/) is a pure function of
 * upstream pstack plus the bindings declared in bindings. This tool proves it:
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
import { bindings, overrides, leftoverTokens, extras } from "./bindings/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("-")) ?? "check";
const fileFlag = valueOf("--file");
const upstreamDir =
  valueOf("--upstream") ?? process.env.PORT_UPSTREAM_DIR ?? join(ROOT, ".port-upstream", `cursor-plugins-${upstream.commit.slice(0, 7)}`);

const TEXT_EXTENSIONS = new Set([".md", ".sh", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".tsv", ".txt", ".lock"]);
const isText = (rel, buf) => TEXT_EXTENSIONS.has(extname(rel).toLowerCase()) || (extname(rel) === "" && !buf.includes(0));

function out(line) {
  process.stdout.write(String(line) + "\n");
}

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

function walk(dir, base = dir) {
  return readdirSync(dir).reduce((acc, name) => {
    if (name === ".DS_Store" || name === "node_modules") return acc;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return acc.concat(walk(p, base));
    return acc.concat([relative(base, p)]);
  }, []);
}

function globToRegExp(glob) {
  const segments = glob
    .split("/")
    .map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")));
  return new RegExp(`^${segments.join("/")}$`);
}

function fileMatches(rule, rel) {
  return !rule.files || rule.files.some((g) => globToRegExp(g).test(rel));
}

function applyBindings(rel, text) {
  return bindings.reduce(
    (acc, rule) => {
      if (!fileMatches(rule, rel)) return acc;
      const before = acc.text;
      const after = rule.re
        ? acc.text.replace(rule.re, rule.replace)
        : before.includes(rule.find)
        ? before.split(rule.find).join(rule.replace ?? "")
        : before;
      return after !== before ? { text: after, applied: [...acc.applied, rule.id] } : acc;
    },
    { text, applied: [] },
  );
}

function scanLeftovers(rel, text) {
  return leftoverTokens.flatMap((token) => {
    if (token.allow?.some((g) => fileMatches({ files: [g] }, rel))) return [];
    return text.split("\n").flatMap((line, idx) => (token.re.test(line) ? [`${token.id} line ${idx + 1}: ${line.trim()}`] : []));
  });
}

function showDiff(rel, generatedText, localText) {
  const dir = join(ROOT, ".port-upstream");
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "generated.tmp");
  const b = join(dir, "local.tmp");
  writeFileSync(a, generatedText);
  writeFileSync(b, localText);
  try {
    return execFileSync("diff", ["-u", "--label", `${rel} (upstream+bindings)`, "--label", `${rel} (local)`, a, b], {
      encoding: "utf8",
    });
  } catch (err) {
    return err.stdout ?? "";
  }
}

const root = resolveUpstream();
const files = upstream.scoped.flatMap((d) => walk(join(root, d), root)).toSorted();
const upstreamSet = new Set(files);
const localSet = new Set(upstream.scoped.flatMap((d) => (existsSync(join(ROOT, d)) ? walk(join(ROOT, d), ROOT) : [])));

const bump = (s, key, next = s[key] + 1) => ({ ...s, [key]: next });
let stats = { identical: 0, bound: 0, override: 0, drift: 0, missing: 0, loose: 0, unused: 0, localOnly: 0, undeclared: 0 };
const firedRules = new Set();

for (const rel of files) {
  if (fileFlag && rel !== fileFlag) continue;
  const localPath = join(ROOT, rel);
  if (!existsSync(localPath)) {
    out(`MISSING  ${rel}`);
    stats = bump(stats, "missing");
    continue;
  }
  const upstreamBuf = readFileSync(join(root, rel));
  const localBuf = readFileSync(localPath);

  const override = overrides[rel];
  if (override) {
    stats = bump(stats, "override");
    const localText = localBuf.toString("utf8");
    const missingMust = (override.must ?? []).filter((s) => !localText.includes(s));
    const hits = scanLeftovers(rel, localText);
    if (missingMust.length || hits.length) {
      out(`OVERRIDE FAIL  ${rel}`);
      for (const m of missingMust) out(`  missing upstream content: ${m.slice(0, 100)}`);
      for (const h of hits) out(`  leftover ${h}`);
      stats = bump(stats, "drift");
    }
    continue;
  }

  // Byte-identical files need no decode and no binding pass.
  if (localBuf.equals(upstreamBuf)) {
    stats = bump(stats, "identical");
    continue;
  }
  if (!isText(rel, localBuf)) {
    out("BINARY DRIFT  " + rel);
    stats = bump(stats, "drift");
    continue;
  }

  const upstreamText = upstreamBuf.toString("utf8");
  const localText = localBuf.toString("utf8");
  const { text: generated, applied } = applyBindings(rel, upstreamText);
  for (const id of applied) firedRules.add(id);
  const loose = scanLeftovers(rel, generated);
  if (loose.length) {
    out(`LOOSE  ${rel}`);
    for (const h of loose) out(`  ${h}`);
    stats = bump(stats, "loose");
  }
  if (Buffer.from(generated, "utf8").equals(localBuf)) {
    stats = applied.length ? bump(stats, "bound") : bump(stats, "identical");
    continue;
  }
  stats = bump(stats, "drift");
  const label = generated === localText ? "BYTE DRIFT" : "DRIFT";
  if (cmd === "diff" || cmd === "sync") {
    out(`${label}  ${rel} (applied: ${applied.join(", ") || "none"})`);
    if (cmd === "diff") out(showDiff(rel, generated, localText));
    continue;
  }
  out(`${label}  ${rel} (applied: ${applied.join(", ") || "none"})`);
}

if (cmd === "sync") {
  let written = 0;
  for (const rel of files) {
    if (overrides[rel]) continue;
    const upstreamBuf = readFileSync(join(root, rel));
    const localPath = join(ROOT, rel);
    const localBuf = existsSync(localPath) ? readFileSync(localPath) : null;
    if (!isText(rel, upstreamBuf)) {
      if (!localBuf || !localBuf.equals(upstreamBuf)) {
        out(`REFUSING to sync binary ${rel}`);
        process.exitCode = 1;
      }
      continue;
    }
    const generated = applyBindings(rel, upstreamBuf.toString("utf8")).text;
    const generatedBuf = Buffer.from(generated, "utf8");
    if (localBuf && generatedBuf.equals(localBuf)) continue;
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, generatedBuf);
    written = written + 1;
  }
  out(`sync: wrote ${written} file(s)`);
}

if (cmd === "rules") {
  for (const rule of bindings) out(`${firedRules.has(rule.id) ? "used  " : "UNUSED"}  ${rule.id}`);
  process.exitCode = firedRules.size === bindings.length ? 0 : 1;
}

const unusedRules = fileFlag ? [] : bindings.filter((r) => !firedRules.has(r.id));
for (const rule of unusedRules) out(`UNUSED RULE  ${rule.id}`);
stats = { ...stats, unused: unusedRules.length };

const extrasList = [...localSet].filter((f) => !upstreamSet.has(f)).toSorted();
for (const rel of extrasList) {
  if (extras[rel]) out(`EXTRA  ${rel} (declared local-only)`);
  else {
    out(`EXTRA  ${rel} (undeclared local-only)`);
    stats = bump(stats, "undeclared");
  }
  stats = bump(stats, "localOnly");
}

out(
  `\n${files.length} upstream files: ${stats.identical} identical, ${stats.bound} bound, ${stats.override} override, ${stats.drift} drift, ${stats.loose} loose, ${stats.missing} missing; ${bindings.length - stats.unused}/${bindings.length} rules fired; local-only ${stats.localOnly} (${stats.undeclared} undeclared)`,
);
if ((stats.drift || stats.missing || stats.loose || stats.unused || stats.undeclared) && cmd === "check") process.exitCode = 1;
