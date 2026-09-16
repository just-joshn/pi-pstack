#!/usr/bin/env node
/**
 * Differential conformance. Runs the same fixture against the pinned upstream
 * pstack tree and this repo's ported twin, then compares exit code plus
 * normalized output. The per-case rewrites are named on each case; the run
 * ledger lands in spec/differential-results.json.
 *
 *   node tests/differential.mjs [--upstream <dir>] [--dump] [--keep-scratch]
 *
 * --dump prints the normalized text both trees produced, which is how the suite
 * is audited for substance. exit 0 all cases equal (or a printed skip), 1 a case
 * differs, 2 harness error.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_REL = "skills/poteto-mode/scripts";
const RESULTS_PATH = join(ROOT, "spec/differential-results.json");
const UPSTREAM_JSON = join(ROOT, "port/upstream.json");
const DIFF_LINE_LIMIT = 24;
const AUDIT_COLUMNS = { 0: "<size>", 1: "<age>", 6: "<date>" };

// Upstream executable -> case ids that exercise it. assertCoverage fails the run
// when a synced-in executable appears with no case, so the suite cannot silently
// shrink as upstream drifts.
const COVERAGE = {
  "watch-pr/watch-pr": [
    "watch-pr-help",
    "watch-pr-badflag",
    "watch-pr-stack-prs-without-queued-stack",
    "watch-pr-invalid-interval",
    "watch-pr-fixture-status",
    "watch-pr-fixture-pretty",
    "watch-pr-fixture-gh-error",
  ],
  "worktree-audit.sh": ["worktree-audit"],
  "check-plan.mjs": ["check-plan-usage-error", "check-plan-fixture"],
  "orch/orch.ts": ["orch-usage-error", "orch-store-roundtrip"],
};

// Interactive or network-bound executables are declared here, never run.
const NOT_RUNNABLE = {};

const GIT_ISOLATION = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

const FIXTURE_GH = [
  "#!/bin/sh",
  "printf '%s\\n' \"$*\" >> \"$GH_LOG\"",
  'case "$*" in',
  '  *"pr checks"*) cat "$FIXTURE/checks.json" ;;',
  '  *"pr view"*) cat "$FIXTURE/pr.json" ;;',
  '  *ReviewThreads*) cat "$FIXTURE/threads.json" ;;',
  '  *PrCommitStatuses*) cat "$FIXTURE/commits.json" ;;',
  '  *"pr list"*) cat "$FIXTURE/open-prs.json" ;;',
  '  *) printf \'fixture gh: unhandled argv\\n\' >&2; exit 3 ;;',
  "esac",
  "",
].join("\n");

const FAILING_GH = [
  "#!/bin/sh",
  "printf '%s\\n' \"$*\" >> \"$GH_LOG\"",
  "printf 'gh: could not resolve to a PullRequest in this repository\\n' >&2",
  "exit 1",
  "",
].join("\n");

function writeLine(text) {
  process.stdout.write(`${text}\n`);
}

function skip(reason) {
  process.stdout.write(`differential: SKIPPED (${reason})\n`);
  process.exit(0);
}

function harnessError(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`differential: harness error (${message})\n`);
  process.exit(2);
}

function upstreamMeta() {
  return JSON.parse(readFileSync(UPSTREAM_JSON, "utf8"));
}

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function upstreamRootDir(meta) {
  const flag = flagValue("--upstream");
  if (flag !== undefined) return flag;
  if (process.env.PORT_UPSTREAM_DIR !== undefined) return process.env.PORT_UPSTREAM_DIR;
  return join(ROOT, ".port-upstream", `cursor-plugins-${meta.commit.slice(0, 7)}`);
}

function gitHead(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function resolveUpstream(meta) {
  const dir = upstreamRootDir(meta);
  const nested = join(dir, meta.subdir);
  const root = existsSync(nested) ? nested : existsSync(join(dir, SCRIPTS_REL)) ? dir : null;
  if (root === null) return { ok: false, path: nested };
  return gitHead(dir) === meta.commit ? { ok: true, root, commit: meta.commit } : { ok: false, path: root };
}

function runChild(argv, options) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    rc: result.status ?? (result.error === undefined ? -1 : 127),
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

function toolDir(name) {
  const parts = (process.env.PATH ?? "").split(":");
  return parts.find((dir) => dir !== "" && existsSync(join(dir, name))) ?? "/usr/bin";
}

// /bin and /usr/bin stay ahead of the user PATH so the BSD userland the
// worktree-audit script is written against wins over any GNU shim.
function systemPath() {
  return ["/bin", "/usr/bin", toolDir("rg"), toolDir("jq"), toolDir("bun")]
    .filter((dir, index, all) => all.indexOf(dir) === index)
    .join(":");
}

function childEnv(ctx, binDir, extra) {
  const path = binDir === undefined || binDir === null ? ctx.pathBase : `${binDir}:${ctx.pathBase}`;
  return {
    PATH: path,
    HOME: ctx.cliHome,
    TMPDIR: ctx.tmp,
    LC_ALL: "C",
    LANG: "C",
    NO_COLOR: "1",
    ...GIT_ISOLATION,
    ...(extra ?? {}),
  };
}

function gitEnv(ctx) {
  return {
    ...childEnv(ctx, null),
    GIT_AUTHOR_NAME: "differential",
    GIT_AUTHOR_EMAIL: "differential@example.test",
    GIT_COMMITTER_NAME: "differential",
    GIT_COMMITTER_EMAIL: "differential@example.test",
    GIT_AUTHOR_DATE: ctx.commitDate,
    GIT_COMMITTER_DATE: ctx.commitDate,
  };
}

function gitRun(cwd, args, env) {
  const result = runChild(["git", ...args], { cwd, env });
  if (result.rc !== 0) throw new Error(`git ${args.join(" ")} exited ${result.rc}: ${result.stderr.trim()}`);
  return result.stdout;
}

function writeExecutable(path, text) {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function treeExecutables(root) {
  const scripts = join(root, SCRIPTS_REL);
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules") return [];
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      const isCode = [".sh", ".ts", ".mjs", ".js"].includes(extname(entry.name));
      return isCode && (statSync(full).mode & 0o111) !== 0 ? [relative(scripts, full)] : [];
    });
  return walk(scripts).toSorted();
}

function applyRules(text, rules) {
  return rules.reduce((acc, rule) => acc.replace(rule.re, rule.out), text);
}

function tmpPathRule(ctx) {
  return { re: new RegExp(ctx.tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), out: "<tmp>" };
}

function normalizeAudit(text, ctx) {
  const rows = text.split("\n").map((line) => {
    const cells = line.split("\t");
    if (cells.length !== 9) return line;
    return cells.map((cell, index) => AUDIT_COLUMNS[index] ?? cell).join("\t");
  });
  return applyRules(rows.join("\n"), [tmpPathRule(ctx)]);
}

function normalizeCases(ctx) {
  const plain = { names: "tmp-path", apply: (text) => applyRules(text, [tmpPathRule(ctx)]) };
  const fixture = {
    names: "stdout + gh-argv-log; rewrites tmp-path, timestamp, retryInSeconds, 40-hex-sha",
    apply: (text) =>
      applyRules(text, [
        tmpPathRule(ctx),
        { re: /"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g, out: '"<timestamp>"' },
        { re: /"retryInSeconds":\d+(?:\.\d+)?/g, out: '"retryInSeconds":<duration>' },
        { re: /[0-9a-f]{40}/g, out: "<sha40>" },
      ]),
  };
  const audit = {
    names: "tmp-path, size, age, last-chat date; rows compared per worktree",
    apply: (text) => normalizeAudit(text, ctx),
  };
  const steps = {
    names: "tmp-path, per-variant store segment, per-step rc markers",
    apply: (text) => applyRules(text, [tmpPathRule(ctx), { re: /orch-store\/(?:upstream|ported)/g, out: "orch-store/<tree>" }]),
  };
  return { plain, fixture, audit, steps };
}

function buildContext(resolution, pathBase) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pi-pstack-differential-")));
  const ctx = {
    tmp,
    upstreamDir: resolution.root,
    upstreamCommit: resolution.commit,
    pathBase,
    cliHome: join(tmp, "home-cli"),
    commitDate: "2026-01-02T03:04:05Z",
    trees: {},
    fixtures: {},
  };
  mkdirSync(ctx.cliHome, { recursive: true });
  mkdirSync(join(tmp, "logs"), { recursive: true });
  ctx.trees.upstream = copyTree(ctx, resolution.root, "upstream");
  ctx.trees.ported = copyTree(ctx, ROOT, "ported");
  seedModules(ctx);
  ctx.fixtures.gh = buildGhFixture(ctx);
  ctx.fixtures.worktree = buildWorktreeFixture(ctx);
  ctx.fixtures.plan = buildPlanFixture(ctx);
  return ctx;
}

function copyTree(ctx, root, name) {
  const scripts = join(ctx.tmp, name, "scripts");
  cpSync(join(root, SCRIPTS_REL), scripts, { recursive: true });
  rmSync(join(scripts, "node_modules"), { recursive: true, force: true });
  return { name, root, scripts };
}

// node_modules is copied once into the scratch tree and shared by both copies.
// Running the CLIs from a copy keeps bun's self-bootstrap from writing into the
// pinned upstream checkout.
function seedModules(ctx) {
  const modules = join(ctx.tmp, "node_modules");
  const sources = [join(ROOT, SCRIPTS_REL, "node_modules"), join(ctx.upstreamDir, SCRIPTS_REL, "node_modules")];
  const origin = sources.find((dir) => existsSync(dir));
  if (origin === undefined) return;
  cpSync(origin, modules, { recursive: true });
  for (const tree of Object.values(ctx.trees)) symlinkSync(modules, join(tree.scripts, "node_modules"), "dir");
}

function prFixture() {
  return {
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    headRefOid: "a".repeat(40),
    headRefName: "feature/x",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  };
}

function checksFixture() {
  return [
    { name: "build", state: "SUCCESS", description: "ok", link: "https://example.test/build", workflow: "ci", bucket: "pass" },
    { name: "unit (1)", state: "FAILURE", description: "boom", link: "https://example.test/unit", workflow: "ci", bucket: "fail" },
  ];
}

function threadsFixture() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "T1",
                isResolved: false,
                comments: {
                  nodes: [
                    { body: "please fix the nit", createdAt: "2024-01-01T00:00:00Z", path: "lib/a.ts", line: 12, author: { login: "bot" } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
}

function commitsFixture() {
  return {
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              { commit: { oid: "b".repeat(40), statusCheckRollup: { state: "SUCCESS" } } },
              { commit: { oid: "a".repeat(40), statusCheckRollup: { state: "FAILURE" } } },
            ],
          },
        },
      },
    },
  };
}

function ghFixturePayloads() {
  return {
    "pr.json": prFixture(),
    "checks.json": checksFixture(),
    "threads.json": threadsFixture(),
    "commits.json": commitsFixture(),
    "open-prs.json": [],
  };
}

function buildGhFixture(ctx) {
  const dir = join(ctx.tmp, "gh-fixture");
  const bin = join(ctx.tmp, "bin-fixture");
  const failBin = join(ctx.tmp, "bin-fail");
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(failBin, { recursive: true });
  for (const [name, value] of Object.entries(ghFixturePayloads())) writeJson(join(dir, name), value);
  writeExecutable(join(bin, "gh"), FIXTURE_GH);
  writeExecutable(join(failBin, "gh"), FAILING_GH);
  return { dir, bin, failBin };
}

function createMergedWorktree(repo, base, env) {
  const path = join(base, "wt-merged");
  gitRun(repo, ["worktree", "add", "-q", "-b", "feat/merged", path], env);
  writeFileSync(join(path, "b.txt"), "two\n");
  writeFileSync(join(path, "pad.bin"), "x".repeat(60000));
  gitRun(path, ["add", "b.txt", "pad.bin"], env);
  gitRun(path, ["commit", "-qm", "merged work"], env);
  return realpathSync(path);
}

function createWipWorktree(repo, base, env) {
  const path = join(base, "wt-wip");
  gitRun(repo, ["worktree", "add", "-q", "-b", "feat/wip", path], env);
  writeFileSync(join(path, "c.txt"), "three\n");
  gitRun(path, ["add", "c.txt"], env);
  gitRun(path, ["commit", "-qm", "wip work"], env);
  return realpathSync(path);
}

// Each variant reads its own store layout: upstream scans the Cursor transcript
// slug directory, the port reads the Pi session store. Both stores get the same
// worktree references and mtimes so the classification stays comparable.
function writeTranscriptStores(home, repo, worktrees) {
  const slug = repo.replace(/^\//, "").replace(/\//g, "-");
  const cursor = join(home, ".cursor", "projects", slug, "agent-transcripts");
  const pi = join(home, ".pi", "agent", "sessions", "differential");
  mkdirSync(cursor, { recursive: true });
  mkdirSync(pi, { recursive: true });
  const now = Date.now() / 1000;
  const entries = [
    { worktree: worktrees[0], name: "merged", age: now - 3 * 86400 },
    { worktree: worktrees[1], name: "wip", age: now - 10 * 86400 },
  ];
  for (const entry of entries) {
    const body = `${JSON.stringify({ cwd: `${entry.worktree}/` })}\n`;
    for (const dir of [cursor, pi]) {
      const file = join(dir, `${entry.name}.jsonl`);
      writeFileSync(file, body);
      utimesSync(file, entry.age, entry.age);
    }
  }
}

function buildWorktreeFixture(ctx) {
  const base = join(ctx.tmp, "worktree");
  const repo = join(base, "repo");
  const home = join(base, "home");
  const bin = join(base, "bin");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const env = gitEnv(ctx);
  gitRun(repo, ["init", "-q", "-b", "main", "."], env);
  writeFileSync(join(repo, "a.txt"), "one\n");
  gitRun(repo, ["add", "a.txt"], env);
  gitRun(repo, ["commit", "-qm", "init"], env);
  const merged = createMergedWorktree(repo, base, env);
  const wip = createWipWorktree(repo, base, env);
  gitRun(repo, ["merge", "-q", "--ff-only", "feat/merged"], env);
  const rev = (ref) => gitRun(repo, ["rev-parse", ref], env).trim();
  gitRun(repo, ["update-ref", "refs/remotes/origin/main", rev("HEAD")], env);
  gitRun(repo, ["update-ref", "refs/remotes/origin/feat/merged", rev("feat/merged")], env);
  gitRun(repo, ["update-ref", "refs/remotes/origin/feat/wip", rev("feat/wip~1")], env);
  writeFileSync(join(wip, "a.txt"), "one\nedited\n");
  writeExecutable(join(bin, "gh"), ['#!/bin/sh', 'printf \'[{"number":77,"state":"OPEN","headRefName":"feat/wip"}]\\n\'', ""].join("\n"));
  writeTranscriptStores(home, repo, [merged, wip]);
  return { repo, home, bin };
}

// The artifact records a repo-relative upstream path so a committed run does not
// carry a machine-specific home directory.
function displayPath(target) {
  const rel = relative(ROOT, target);
  return rel.startsWith("..") ? target : rel;
}

function buildPlanFixture(ctx) {
  const file = join(ctx.tmp, "plan-fixture.md");
  writeFileSync(file, PLAN_FIXTURE_LINES.join("\n"));
  return { file };
}

const PLAN_FIXTURE_LINES = [
  "# Fixture plan",
  "",
  "Intro line one.",
  "Intro line two.",
  "",
  "## How to read this",
  "",
  "One box is one unit of work.",
  "Read the names evidence.",
  "Check a box only when its evidence exists.",
  "See playbooks/ for detail.",
  "",
  "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.",
  "",
  "## Program checklist",
  "",
  "### Arm the program",
  "",
  "/goal marker present.",
  "",
  "### Spawn owners",
  "",
  "Ten lanes at the PR head. 30-minute cadence.",
  "",
  "### PR mechanics",
  "",
  "status message",
  "",
  "### Verdict and merge",
  "",
  "nothing here",
  "",
  "### Boot recipe",
  "",
  "nothing here",
  "",
  "## PR one: add the thing",
  "",
  "**Depends on.** nothing",
  "",
  "**Files.** no boxes",
  "",
  "**Build.**",
  "",
  "**You see.**",
  "",
  "**Verify, unit.** wrong opener",
  "",
  "**Verify, live.**",
  "",
  "**Verify, perf.**",
  "",
  "**Review gate.**",
  "",
  "**Merge.**",
  "",
  "## Close the program",
  "",
  "done",
  "",
  ];

function runtimeFor(file) {
  if (file.endsWith(".sh")) return ["/bin/bash"];
  // .mjs ships with a node shebang; the extensionless and TypeScript CLIs
  // declare bun as their runtime.
  if ([".mjs", ".js"].includes(extname(file))) return [process.execPath];
  return ["bun", "run"];
}

function runCli(ctx, tree, options) {
  const argv = [...runtimeFor(options.file), join(tree.scripts, options.file), ...(options.args ?? [])];
  const result = runChild(argv, { cwd: options.cwd, env: childEnv(ctx, options.bin, options.env) });
  return { rc: result.rc, stdout: result.stdout, stderr: result.stderr };
}

function runWatchPr(ctx, tree, options) {
  const log = join(ctx.tmp, "logs", `${options.id}-${tree.name}.log`);
  writeFileSync(log, "");
  const result = runCli(ctx, tree, {
    file: "watch-pr/watch-pr",
    args: options.args,
    cwd: ctx.tmp,
    bin: options.bin,
    env: { GH_LOG: log, FIXTURE: ctx.fixtures.gh.dir },
  });
  const calls = options.calls === true ? `\n[gh-calls]\n${readFileSync(log, "utf8")}` : "";
  return { rc: result.rc, stdout: `${result.stdout}${calls}`, stderr: result.stderr };
}

function runOrchStore(ctx, tree) {
  const env = childEnv(ctx, null, { ORCH_STORE: join(ctx.tmp, "orch-store", tree.name) });
  const file = join(tree.scripts, "orch/orch.ts");
  const steps = [["init"], ["unit", "add", "U-1", "--track", "t1"], ["--json", "unit", "list"], ["status"]];
  const results = steps.map((args) => runChild(["bun", "run", file, ...args], { cwd: ctx.tmp, env }));
  const stdout = results.map((result, index) => `[step ${index + 1} rc=${result.rc}]\n${result.stdout}`).join("");
  return { rc: results[results.length - 1].rc, stdout, stderr: results.map((result) => result.stderr).join("") };
}

// An argv or usage error is compared on stderr, because the CLI's error text is
// the observable contract there.
function contractCase(norms, id, args) {
  return {
    id,
    file: "watch-pr/watch-pr",
    normalizer: norms.plain,
    stream: "stderr",
    run: (ctx, tree) => runWatchPr(ctx, tree, { id, args, bin: null }),
  };
}

function watchPrCases(norms, ctx) {
  const fixtureArgs = ["--status-only", "--owner", "acme", "--repo", "widgets", "--pr", "42"];
  const ghFixture = (id, args, bin) => ({
    id,
    file: "watch-pr/watch-pr",
    normalizer: norms.fixture,
    stream: "stdout",
    run: (context, tree) => runWatchPr(context, tree, { id, args, bin, calls: true }),
  });
  return [
    {
      id: "watch-pr-help",
      file: "watch-pr/watch-pr",
      normalizer: norms.plain,
      stream: "stdout",
      run: (context, tree) => runWatchPr(context, tree, { id: "watch-pr-help", args: ["--help"], bin: ctx.fixtures.gh.bin }),
    },
    contractCase(norms, "watch-pr-badflag", ["--nope"]),
    contractCase(norms, "watch-pr-stack-prs-without-queued-stack", ["--stack-prs", "1,2"]),
    contractCase(norms, "watch-pr-invalid-interval", ["--owner", "o", "--repo", "r", "--pr", "1", "--interval", "nope"]),
    ghFixture("watch-pr-fixture-status", fixtureArgs, ctx.fixtures.gh.bin),
    ghFixture("watch-pr-fixture-pretty", [...fixtureArgs, "--pretty"], ctx.fixtures.gh.bin),
    ghFixture(
      "watch-pr-fixture-gh-error",
      ["--status-only", "--max-query-errors", "2", "--timeout", "0.001", "--owner", "acme", "--repo", "widgets", "--pr", "999"],
      ctx.fixtures.gh.failBin,
    ),
  ];
}

function localCases(norms, ctx) {
  const worktree = ctx.fixtures.worktree;
  return [
    {
      id: "worktree-audit",
      file: "worktree-audit.sh",
      normalizer: norms.audit,
      stream: "stdout",
      run: (context, tree) =>
        runCli(context, tree, {
          file: "worktree-audit.sh",
          args: [worktree.repo],
          cwd: worktree.repo,
          bin: worktree.bin,
          env: { HOME: worktree.home },
        }),
    },
    {
      id: "check-plan-usage-error",
      file: "check-plan.mjs",
      normalizer: norms.plain,
      stream: "stderr",
      run: (context, tree) => runCli(context, tree, { file: "check-plan.mjs", cwd: context.tmp, bin: null }),
    },
    {
      id: "check-plan-fixture",
      file: "check-plan.mjs",
      normalizer: norms.plain,
      stream: "stdout",
      run: (context, tree) => runCli(context, tree, { file: "check-plan.mjs", args: [ctx.fixtures.plan.file], cwd: context.tmp, bin: null }),
    },
    {
      id: "orch-usage-error",
      file: "orch/orch.ts",
      normalizer: norms.plain,
      stream: "stderr",
      run: (context, tree) => runCli(context, tree, { file: "orch/orch.ts", cwd: context.tmp, bin: null }),
    },
    {
      id: "orch-store-roundtrip",
      file: "orch/orch.ts",
      normalizer: norms.steps,
      stream: "stdout",
      run: runOrchStore,
    },
  ];
}

function caseDefinitions(norms, ctx) {
  return [...watchPrCases(norms, ctx), ...localCases(norms, ctx)];
}

function measureCase(definition, ctx) {
  const rules = definition.normalizer;
  const upstream = definition.run(ctx, ctx.trees.upstream);
  const ported = definition.run(ctx, ctx.trees.ported);
  const pick = (result) => (definition.stream === "stderr" ? result.stderr : result.stdout);
  const upstreamText = rules.apply(pick(upstream));
  const portedText = rules.apply(pick(ported));
  if (upstreamText.length === 0 && portedText.length === 0) throw new Error(`case ${definition.id} compared two empty results`);
  return {
    id: definition.id,
    equal: upstream.rc === ported.rc && upstreamText === portedText,
    upstreamRc: upstream.rc,
    portedRc: ported.rc,
    normalization: rules.names,
    upstreamText,
    portedText,
  };
}

function clip(value) {
  if (value === undefined) return "<line absent>";
  return value.length > 600 ? `${value.slice(0, 600)}...` : value;
}

function diffLines(upstreamText, portedText) {
  const upstream = upstreamText.split("\n");
  const ported = portedText.split("\n");
  const total = Math.max(upstream.length, ported.length);
  return Array.from({ length: total }, (_, index) => index)
    .filter((index) => upstream[index] !== ported[index])
    .slice(0, DIFF_LINE_LIMIT)
    .flatMap((index) => [
      `  upstream[${index + 1}]: ${clip(upstream[index])}`,
      `  ported[${index + 1}]:   ${clip(ported[index])}`,
    ]);
}

function printCase(outcome) {
  const verdict = outcome.equal ? "equal" : "differs";
  writeLine(`case=${outcome.id} upstream_rc=${outcome.upstreamRc} ported_rc=${outcome.portedRc} ${verdict}`);
  if (!outcome.equal) {
    for (const line of diffLines(outcome.upstreamText, outcome.portedText)) writeLine(line);
  }
  if (!process.argv.includes("--dump")) return;
  writeLine(`--- ${outcome.id} upstream rc=${outcome.upstreamRc}`);
  writeLine(outcome.upstreamText);
  writeLine(`--- ${outcome.id} ported rc=${outcome.portedRc}`);
  writeLine(outcome.portedText);
}

function resultPayload(ctx, outcomes) {
  const cases = outcomes.map((outcome) => ({
    id: outcome.id,
    equal: outcome.equal,
    upstreamRc: outcome.upstreamRc,
    portedRc: outcome.portedRc,
    normalization: outcome.normalization,
  }));
  const equal = cases.filter((entry) => entry.equal).length;
  return {
    generatedAt: new Date().toISOString(),
    upstreamDir: displayPath(ctx.upstreamDir),
    upstreamCommit: ctx.upstreamCommit,
    cases,
    summary: { cases: cases.length, equal, differ: cases.length - equal },
  };
}

function assertCoverage(ctx, definitions) {
  const ids = new Set(definitions.map((definition) => definition.id));
  for (const definition of definitions) {
    if (COVERAGE[definition.file] === undefined) throw new Error(`case ${definition.id} claims unknown executable ${definition.file}`);
  }
  const ported = treeExecutables(ctx.trees.ported.root);
  for (const rel of treeExecutables(ctx.trees.upstream.root)) {
    if (NOT_RUNNABLE[rel] !== undefined) {
      writeLine(`note ${rel} skipped: ${NOT_RUNNABLE[rel]}`);
      continue;
    }
    if (!(COVERAGE[rel] ?? []).some((id) => ids.has(id))) throw new Error(`no differential case covers ${SCRIPTS_REL}/${rel}`);
    if (!ported.includes(rel)) throw new Error(`${SCRIPTS_REL}/${rel} is present upstream but absent from the ported twin`);
  }
}

function preflight(ctx) {
  return runWatchPr(ctx, ctx.trees.ported, { id: "preflight", args: ["--help"], bin: null });
}

function cleanup(ctx, keep) {
  if (keep) {
    writeLine(`note scratch kept at ${ctx.tmp}`);
    return;
  }
  try {
    rmSync(ctx.tmp, { recursive: true, force: true });
  } catch {
    writeLine(`note scratch not removed: ${ctx.tmp}`);
  }
}

function main() {
  const meta = upstreamMeta();
  const resolution = resolveUpstream(meta);
  if (!resolution.ok) skip(`upstream tree unavailable at ${resolution.path}`);
  const pathBase = systemPath();
  const bunProbe = runChild(["bun", "--version"], { cwd: ROOT, env: { PATH: pathBase, LC_ALL: "C", ...GIT_ISOLATION } });
  if (bunProbe.rc !== 0) skip("bun unavailable");
  const ctx = buildContext(resolution, pathBase);
  const probe = preflight(ctx);
  if (probe.rc !== 0) skip(`bun cannot run the watch-pr CLI (${(probe.stderr.trim().split("\n")[0] || `exit ${probe.rc}`)})`);
  const definitions = caseDefinitions(normalizeCases(ctx), ctx);
  assertCoverage(ctx, definitions);
  const outcomes = definitions.map((definition) => measureCase(definition, ctx));
  for (const outcome of outcomes) printCase(outcome);
  writeFileSync(RESULTS_PATH, `${JSON.stringify(resultPayload(ctx, outcomes), null, 2)}\n`);
  cleanup(ctx, process.argv.includes("--keep-scratch"));
  const differ = outcomes.filter((outcome) => !outcome.equal).length;
  writeLine(`differential: cases=${outcomes.length} equal=${outcomes.length - differ} differ=${differ}`);
  process.exitCode = differ > 0 ? 1 : 0;
}

try {
  main();
} catch (error) {
  harnessError(error);
}
