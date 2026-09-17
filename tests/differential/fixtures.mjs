/**
 * Scratch context and fixtures.
 *
 * `buildContext` stages both trees into one temp directory and seeds every
 * fixture a case needs. The staged copies keep bun's self-bootstrap from writing
 * into the pinned upstream checkout.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { ROOT, SCRIPTS_REL, gitEnv, gitRun, writeExecutable, writeJson } from "./environment.mjs";

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

export function treeExecutables(root) {
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

function copyTree(ctx, root, name) {
  const scripts = join(ctx.tmp, name, "scripts");
  cpSync(join(root, SCRIPTS_REL), scripts, { recursive: true });
  rmSync(join(scripts, "node_modules"), { recursive: true, force: true });
  return { name, root, scripts };
}

// node_modules is copied once into the scratch tree and shared by both copies.
function seedModules(ctx) {
  const modules = join(ctx.tmp, "node_modules");
  const sources = [join(ROOT, SCRIPTS_REL, "node_modules"), join(ctx.upstreamDir, SCRIPTS_REL, "node_modules")];
  const origin = sources.find((dir) => existsSync(dir));
  if (origin === undefined) return;
  cpSync(origin, modules, { recursive: true });
  for (const tree of Object.values(ctx.trees)) symlinkSync(modules, join(tree.scripts, "node_modules"), "dir");
}

export function buildContext(resolution, pathBase) {
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

// Two gh stubs: one serves fixture payloads, one fails every call.
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

function buildPlanFixture(ctx) {
  const file = join(ctx.tmp, "plan-fixture.md");
  writeFileSync(file, PLAN_FIXTURE_LINES.join("\n"));
  return { file };
}
