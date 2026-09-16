#!/usr/bin/env node
/**
 * Upstream drift report.
 *
 * This project pins one commit of cursor/plugins pstack/ (upstream.lock.json,
 * mirrored into port/upstream.json for port.mjs). Newer upstream commits are
 * drift, never silently absorbed. This script reports what changed under
 * pstack/ between the pin and a target ref (default origin/main) so a human
 * can decide whether to advance the pin. It never mutates the pin itself.
 *
 *   node port/drift.mjs report [--ref origin/main] [--upstream <dir>]
 *
 * Exit code is always 0: this is a report, not a gate. Pin-consistency
 * (upstream.lock.json vs port/upstream.json) is the one thing it fails on,
 * since that is a repo bug rather than upstream drift.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lock from "../upstream.lock.json" with { type: "json" };
import pinned from "./upstream.json" with { type: "json" };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const ref = valueOf("--ref") ?? "origin/main";
const upstreamDir =
  valueOf("--upstream") ?? process.env.PORT_UPSTREAM_DIR ?? join(ROOT, ".port-upstream", `cursor-plugins-${pinned.commit.slice(0, 7)}`);

function out(line) {
  process.stdout.write(String(line) + "\n");
}

function git(dir, cmdArgs) {
  return execFileSync("git", ["-C", dir, ...cmdArgs], { encoding: "utf8" }).trim();
}

if (lock.commit.sha !== pinned.commit) {
  out(`PIN MISMATCH  upstream.lock.json.commit.sha=${lock.commit.sha} port/upstream.json.commit=${pinned.commit}`);
  out("These must name the same commit. Fix before trusting any drift report.");
  process.exitCode = 1;
  process.exit();
}

const pin = lock.commit.sha;
out(`pinned commit: ${pin} (pstack ${lock.pluginVersion}, captured ${lock.capturedAt})`);

if (!existsSync(upstreamDir)) {
  out(`no cached clone at ${upstreamDir}; run npm run parity:check first to populate it`);
  process.exit();
}

try {
  execFileSync("git", ["-C", upstreamDir, "fetch", "--quiet", "origin"], { stdio: "pipe", timeout: 20000 });
} catch (err) {
  out(`drift check skipped: could not fetch ${ref} (${err.message.split("\n")[0]})`);
  out("This is informational only; it does not fail the run.");
  process.exit();
}

let targetSha;
try {
  targetSha = git(upstreamDir, ["rev-parse", ref]);
} catch (err) {
  out(`drift check skipped: could not resolve ref ${ref}`);
  process.exit();
}

if (targetSha === pin) {
  out(`no drift: ${ref} is at the pinned commit`);
  process.exit();
}

let isAncestor = true;
try {
  execFileSync("git", ["-C", upstreamDir, "merge-base", "--is-ancestor", pin, targetSha]);
} catch {
  isAncestor = false;
}
if (!isAncestor) {
  out(`WARNING: ${ref} (${targetSha}) is not a descendant of the pin; history may have been rewritten`);
}

const commits = git(upstreamDir, ["log", "--oneline", `${pin}..${targetSha}`, "--", "pstack/"])
  .split("\n")
  .filter(Boolean);

if (commits.length === 0) {
  out(`no drift: 0 commits touch pstack/ between the pin and ${ref} (${targetSha})`);
  const pinTree = git(upstreamDir, ["rev-parse", `${pin}:pstack`]);
  const targetTree = git(upstreamDir, ["rev-parse", `${targetSha}:pstack`]);
  out(`pstack/ tree sha unchanged: ${pinTree === targetTree}`);
  process.exit();
}

out(`DRIFT: ${commits.length} commit(s) touch pstack/ between the pin and ${ref} (${targetSha})`);
for (const line of commits) out(`  ${line}`);

const nameStatus = git(upstreamDir, ["diff", "--name-status", `${pin}..${targetSha}`, "--", "pstack/"])
  .split("\n")
  .filter(Boolean);
out(`file-level changes:`);
for (const line of nameStatus) out(`  ${line}`);

out("");
out("These commits are drift against the pinned compatibility cycle. They are not");
out("incorporated automatically. Advancing the pin requires updating upstream.lock.json");
out("and port/upstream.json together, re-running npm run parity:sync, re-classifying");
out("any new/removed/changed inventory rows in spec/contracts/, and recording the");
out("decision in CHANGELOG.md.");
