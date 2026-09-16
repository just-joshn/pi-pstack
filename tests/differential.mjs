#!/usr/bin/env node
/**
 * Differential conformance against the pinned upstream reference.
 *
 * Executes the pinned upstream file and the ported twin with identical argv, env,
 * and cwd, then compares exit code and output. Only volatile tokens are
 * normalized: the tree roots, durations, and nothing else. A remaining difference
 * fails the run. Writes spec/differential-results.json for the release record.
 *
 * The upstream scripts tree ships no installed dependencies. Its package.json and
 * bun.lock are identical to the ported twin's (the port gate holds them
 * byte-exact), so the upstream CLI runs against a symlink of the ported
 * node_modules. That is recorded as the case's normalization note.
 *
 * Exit codes: 0 all cases equal, 1 a case differs, 2 harness error.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = "skills/poteto-mode/scripts";
const ENTRY = `${SCRIPTS}/watch-pr/watch-pr`;
const PIN = JSON.parse(readFileSync(join(ROOT, "port", "upstream.json"), "utf8"));

function resolveUpstream() {
  const override = process.env.PORT_UPSTREAM_DIR;
  const bases = override ? [override] : [join(ROOT, ".port-upstream", `cursor-plugins-${PIN.commit.slice(0, 7)}`)];
  for (const base of bases) {
    const candidate = join(base, PIN.subdir);
    if (existsSync(join(candidate, SCRIPTS))) return candidate;
  }
  return null;
}

function ensureDeps(upstreamRoot) {
  const target = join(upstreamRoot, SCRIPTS, "node_modules");
  if (existsSync(target)) return "upstream dependencies present";
  const source = join(ROOT, SCRIPTS, "node_modules");
  if (!existsSync(source)) return null;
  symlinkSync(source, target, "dir");
  return "upstream node_modules linked from the ported tree (identical lockfile)";
}

function displayPath(target) {
  const rel = relative(ROOT, target);
  return rel.startsWith("..") ? target : rel;
}

function normalize(text, roots) {
  return String(text ?? "")
    .split("\n")
    .map((line) => roots.reduce((acc, root) => acc.split(root).join("<root>"), line))
    .map((line) => line.replace(/\d+\.\d+m?s\b/g, "<duration>"))
    .join("\n")
    .trim();
}

function run(cmd, args, opts) {
  const result = spawnSync(cmd, args, { encoding: "utf8", timeout: 90000, ...opts });
  return {
    rc: result.status ?? 1,
    out: result.stdout ?? "",
    err: result.stderr ?? "",
    error: result.error ? String(result.error.message) : null,
  };
}

function cliCase(id, args) {
  return async (upstreamRoot) => {
    const upstream = run("bun", [join(upstreamRoot, ENTRY), ...args], { cwd: upstreamRoot });
    const ported = run("bun", [join(ROOT, ENTRY), ...args], { cwd: ROOT });
    const roots = [upstreamRoot, ROOT];
    const upstreamText = normalize(upstream.out + upstream.err, roots);
    const portedText = normalize(ported.out + ported.err, roots);
    const observed = upstreamText.length > 0 && portedText.length > 0;
    return {
      id,
      upstreamRc: upstream.rc,
      portedRc: ported.rc,
      bytes: `${upstreamText.length}/${portedText.length}`,
      equal: observed && upstream.rc === ported.rc && upstreamText === portedText,
      detail: `${args.join(" ")} -> rc ${upstream.rc}/${ported.rc}, ${upstreamText.length}/${portedText.length} bytes`,
      diff:
        !observed
          ? "one side produced no observable output, so equality is not evidence"
          : upstreamText === portedText
            ? null
            : `upstream:\n${upstreamText}\nported:\n${portedText}`,
    };
  };
}

function initFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pstack-diff-"));
  const home = join(dir, "home");
  const repo = join(dir, "repo");
  const tree = join(dir, "feature-wt");
  mkdirSync(join(home, ".pi", "agent", "sessions"), { recursive: true });
  const slug = repo.replace(/^\//, "").split("/").join("-");
  mkdirSync(join(home, ".cursor", "projects", slug, "agent-transcripts"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "gh"), '#!/bin/sh\necho "[]"\n');
  spawnSync("chmod", ["755", join(dir, "bin", "gh")]);
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "file.txt"), "one\n");
  git("add", "file.txt");
  git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", "feature/x", tree);
  const stamp = Math.floor(Date.now() / 1000) - 86400;
  for (const path of [
    join(home, ".pi", "agent", "sessions", "s1.jsonl"),
    join(home, ".cursor", "projects", slug, "agent-transcripts", "t1.jsonl"),
  ]) {
    writeFileSync(path, JSON.stringify({ text: `worked in ${tree}/ on the feature` }) + "\n");
    utimesSync(path, stamp, stamp);
  }
  return { dir, home, repo, tree };
}

function worktreeAuditCase(upstreamRoot) {
  const fixture = initFixture();
  try {
    const script = `${SCRIPTS}/worktree-audit.sh`;
    const env = {
      HOME: fixture.home,
      PATH: `${join(fixture.dir, "bin")}:${process.env.PATH}`,
    };
    const upstream = run("bash", [join(upstreamRoot, script), fixture.repo], { cwd: fixture.repo, env });
    const ported = run("bash", [join(ROOT, script), fixture.repo], { cwd: fixture.repo, env });
    const roots = [fixture.dir, fixture.home, fixture.repo, upstreamRoot, ROOT];
    const upstreamText = normalize(upstream.out, roots);
    const portedText = normalize(ported.out, roots);
    return {
      id: "worktree-audit",
      upstreamRc: upstream.rc,
      portedRc: ported.rc,
      equal: upstream.rc === ported.rc && upstreamText === portedText,
      detail: `repo fixture with one feature worktree -> ${upstreamText.split("\n").length}/${portedText.split("\n").length} lines`,
      bytes: `${upstreamText.length}/${portedText.length}`,
      diff: upstreamText === portedText ? null : `upstream:\n${upstreamText}\nported:\n${portedText}`,
    };
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

async function main() {
  const upstreamRoot = resolveUpstream();
  if (!upstreamRoot) {
    process.stdout.write(`differential: SKIPPED (upstream tree unavailable for ${PIN.commit.slice(0, 7)})\n`);
    return 0;
  }
  if (!existsSync(join(ROOT, SCRIPTS, "node_modules"))) {
    process.stdout.write("differential: SKIPPED (bun unavailable or ported scripts uninstalled)\n");
    return 0;
  }
  const depNote = ensureDeps(upstreamRoot);
  const cases = [
    cliCase("watch-pr-help", ["--help"]),
    cliCase("watch-pr-stack-prs-without-queued-stack", ["--stack-prs", "1,2"]),
    cliCase("watch-pr-invalid-interval", ["--owner", "o", "--repo", "r", "--pr", "1", "--interval", "nope"]),
  ];
  const cliResults = await Promise.all(
    cases.map(async (testCase) => ({ ...(await testCase(upstreamRoot)), normalization: depNote })),
  );
  const results = [
    ...cliResults,
    {
      ...worktreeAuditCase(upstreamRoot),
      normalization: "tree roots, HOME, and durations normalized; gh shimmed to an empty list",
    },
  ];
  for (const r of results) {
    process.stdout.write(`case=${r.id} upstream_rc=${r.upstreamRc} ported_rc=${r.portedRc} ${r.equal ? "equal" : "differs"}\n`);
  }
  const differ = results.filter((r) => !r.equal).length;
  process.stdout.write(`differential: cases=${results.length} equal=${results.length - differ} differ=${differ}\n`);
  const artifact = {
    generatedAt: new Date().toISOString(),
    upstreamDir: displayPath(upstreamRoot),
    upstreamCommit: PIN.commit,
    cases: results.map((r) => ({
      id: r.id,
      equal: r.equal,
      upstreamRc: r.upstreamRc,
      portedRc: r.portedRc,
      detail: r.detail,
      bytes: r.bytes,
      normalization: r.normalization,
    })),
    summary: { cases: results.length, equal: results.length - differ, differ },
  };
  writeFileSync(join(ROOT, "spec", "differential-results.json"), JSON.stringify(artifact, null, 2) + "\n");
  for (const r of results.filter((x) => x.diff)) process.stdout.write(`${r.id} diff:\n${r.diff}\n`);
  return differ === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    process.stdout.write(`differential: harness error: ${e && e.message ? e.message : String(e)}\n`);
    process.exitCode = 2;
  });
