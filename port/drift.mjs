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
 *   node port/drift.mjs report [--ref origin/main] [--upstream <dir>] [--strict]
 *
 * Exit codes:
 *   0  no drift, or an indeterminate check without --strict
 *   1  PIN MISMATCH between upstream.lock.json and port/upstream.json (a repo bug)
 *   2  DRIFT: upstream commits touch pstack/ past the pin, or history diverged
 *   3  UNKNOWN under --strict: the check could not be performed
 *
 * A report that announces drift and exits 0 tells its caller "success", so the
 * drift verdict carries an exit code. An indeterminate check (no cached clone,
 * unresolvable ref) is not a pass: it prints UNKNOWN, and --strict turns it into
 * a failure for CI, while a local run without network stays exit 0.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lock from "../upstream.lock.json" with { type: "json" };
import pinned from "./upstream.json" with { type: "json" };

const EXIT = Object.freeze({ clean: 0, pinMismatch: 1, drift: 2, unknown: 3 });
const FETCH_TIMEOUT_MS = 20000;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const ref = valueOf("--ref") ?? "origin/main";
const strict = args.includes("--strict");
const upstreamDir =
  valueOf("--upstream") ?? process.env.PORT_UPSTREAM_DIR ?? join(ROOT, ".port-upstream", `cursor-plugins-${pinned.commit.slice(0, 7)}`);

function out(line) {
  process.stdout.write(String(line) + "\n");
}

function git(dir, cmdArgs) {
  return execFileSync("git", ["-C", dir, ...cmdArgs], { encoding: "utf8" }).trim();
}

function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

function unknown(reason, hint) {
  out(`UNKNOWN: ${reason}`);
  if (hint !== undefined) out(hint);
  out(
    strict
      ? "--strict: an unverifiable drift check is a failure, not a pass."
      : "Not a failure without --strict; rerun with --strict where the check must be conclusive.",
  );
  return strict ? EXIT.unknown : EXIT.clean;
}

function checkPin() {
  if (lock.commit.sha === pinned.commit) return null;
  out(`PIN MISMATCH  upstream.lock.json.commit.sha=${lock.commit.sha} port/upstream.json.commit=${pinned.commit}`);
  out("These must name the same commit. Fix before trusting any drift report.");
  return EXIT.pinMismatch;
}

function fetchUpstream() {
  try {
    execFileSync("git", ["-C", upstreamDir, "fetch", "--quiet", "origin"], { stdio: "pipe", timeout: FETCH_TIMEOUT_MS });
    return null;
  } catch (err) {
    return firstLine(err);
  }
}

function resolveTarget() {
  try {
    return { sha: git(upstreamDir, ["rev-parse", ref]) };
  } catch (err) {
    return { error: firstLine(err) };
  }
}

function pinIsAncestorOf(pin, targetSha) {
  try {
    execFileSync("git", ["-C", upstreamDir, "merge-base", "--is-ancestor", pin, targetSha], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function reportAdvice() {
  out("");
  out("These commits are drift against the pinned compatibility cycle. They are not");
  out("incorporated automatically. Advancing the pin requires updating upstream.lock.json");
  out("and port/upstream.json together, re-running npm run parity:sync, re-classifying");
  out("any new/removed/changed inventory rows in spec/contracts/, and recording the");
  out("decision in CHANGELOG.md.");
}

function reportCommits(pin, targetSha) {
  const commits = git(upstreamDir, ["log", "--oneline", `${pin}..${targetSha}`, "--", "pstack/"])
    .split("\n")
    .filter(Boolean);

  if (commits.length === 0) {
    out(`no drift: 0 commits touch pstack/ between the pin and ${ref} (${targetSha})`);
    const pinTree = git(upstreamDir, ["rev-parse", `${pin}:pstack`]);
    const targetTree = git(upstreamDir, ["rev-parse", `${targetSha}:pstack`]);
    out(`pstack/ tree sha unchanged: ${pinTree === targetTree}`);
    return EXIT.clean;
  }

  out(`DRIFT: ${commits.length} commit(s) touch pstack/ between the pin and ${ref} (${targetSha})`);
  for (const line of commits) out(`  ${line}`);

  const nameStatus = git(upstreamDir, ["diff", "--name-status", `${pin}..${targetSha}`, "--", "pstack/"])
    .split("\n")
    .filter(Boolean);
  out(`file-level changes:`);
  for (const line of nameStatus) out(`  ${line}`);

  reportAdvice();
  return EXIT.drift;
}

function compare(pin, targetSha) {
  if (!pinIsAncestorOf(pin, targetSha)) {
    out(`WARNING: ${ref} (${targetSha}) is not a descendant of the pin; history may have been rewritten`);
    reportCommits(pin, targetSha);
    out("History divergence is itself drift: the pinned commit is not in the target history.");
    return EXIT.drift;
  }
  return reportCommits(pin, targetSha);
}

function main() {
  const mismatch = checkPin();
  if (mismatch !== null) return mismatch;

  const pin = lock.commit.sha;
  out(`pinned commit: ${pin} (pstack ${lock.pluginVersion}, captured ${lock.capturedAt})`);

  if (!existsSync(upstreamDir)) {
    return unknown(`no cached clone at ${upstreamDir}`, "Run npm run parity:check first to populate it.");
  }

  const fetchError = fetchUpstream();
  if (fetchError !== null) {
    out(`warning: could not fetch origin (${fetchError}); comparing against the cached refs instead`);
  }

  const target = resolveTarget();
  if (target.sha === undefined) {
    return unknown(`could not resolve ref ${ref} (${target.error})`, fetchError === null ? undefined : `The fetch failed first: ${fetchError}`);
  }
  if (target.sha === pin) {
    out(`no drift: ${ref} is at the pinned commit`);
    return EXIT.clean;
  }
  return compare(pin, target.sha);
}

try {
  process.exitCode = main();
} catch (err) {
  out(`drift report failed: ${firstLine(err)}`);
  process.exitCode = EXIT.unknown;
}
