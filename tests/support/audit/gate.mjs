/**
 * GATE-01..GATE-08: the verification gates themselves. These predicates check
 * that the repo's own checks run, cover what they claim, and fail when they should.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fail,
  pass,
  repoPath,
  runNode,
  runProcess,
  verdict,
  withNamedTempDir,
  withTempDir,
} from "./harness.mjs";

const COVERAGE_FUNCTIONS = /--test-coverage-functions=(\d+)/;
const COVERAGE_INCLUDE = /--test-coverage-include=(?:"([^"]+)"|(\S+))/g;
const SCRIPT_REFERENCE = /npm run ([a-z0-9:_-]+)|npm-run-all\s+(.+)/g;

function packageScripts() {
  return JSON.parse(readFileSync(repoPath("package.json"), "utf8")).scripts ?? {};
}

async function gateTypecheckClean() {
  const scripts = packageScripts();
  if (!scripts.typecheck) return fail("no typecheck script");
  const run = await runProcess("npm", ["run", "--silent", "typecheck"]);
  return verdict(
    run.code === 0,
    "npm run typecheck exits 0",
    `npm run typecheck exited ${run.code}: ${(run.stdout + run.stderr).trim().slice(-600)}`,
  );
}

function referencedScripts(body) {
  return [...body.matchAll(SCRIPT_REFERENCE)].flatMap((match) =>
    match[1] ? [match[1]] : (match[2] ?? "").split(/\s+/).filter(Boolean),
  );
}

function reachableScripts(scripts, start, seen = new Set()) {
  if (seen.has(start) || !scripts[start]) return seen;
  const next = new Set([...seen, start]);
  return referencedScripts(scripts[start]).reduce(
    (acc, name) => reachableScripts(scripts, name, acc),
    next,
  );
}

async function gateTypecheckInTest() {
  const scripts = packageScripts();
  if (!scripts.test) return fail("package.json has no test script");
  if (!scripts.typecheck) return fail("no typecheck script, so npm test cannot invoke it");
  const reachable = reachableScripts(scripts, "test");
  return verdict(
    reachable.has("typecheck"),
    `npm test reaches typecheck through ${[...reachable].join(" -> ")}`,
    `npm test reaches only ${[...reachable].join(", ")}; typecheck is not in the graph`,
  );
}

async function gateCoverageFunctions() {
  const scripts = packageScripts();
  const body = scripts["test:coverage"];
  if (!body) return fail("package.json has no test:coverage script");
  const match = COVERAGE_FUNCTIONS.exec(body);
  if (!match) return fail(`test:coverage sets no --test-coverage-functions threshold: ${body}`);
  return verdict(
    Number(match[1]) >= 80,
    `test:coverage enforces --test-coverage-functions=${match[1]}`,
    `test:coverage sets --test-coverage-functions=${match[1]}, below the required 80`,
  );
}

async function gateCoverageScope() {
  const scripts = packageScripts();
  const body = scripts["test:coverage"];
  if (!body) return fail("package.json has no test:coverage script");
  const includes = [...body.matchAll(COVERAGE_INCLUDE)].map((match) => match[1] ?? match[2]);
  const covered = includes.some((glob) => glob.startsWith("services/"));
  return verdict(
    covered,
    `test:coverage includes services: ${includes.join(", ")}`,
    `--test-coverage-include covers only ${includes.join(", ") || "(nothing)"}; services/** is never measured`,
  );
}

const CHILD_POLICY = JSON.stringify({
  filesystem: "workspace-write",
  shell: "full",
  git: "branch-write",
  network: "allowed",
  integrations: "inherit",
  environment: "local",
  background: false,
  isolation: "session",
});

function summarize(run) {
  const failLine = /# fail (\d+)/.exec(run.stdout);
  const failed = failLine ? failLine[1] : "unknown";
  const first = run.stdout
    .split("\n")
    .find((line) => line.trimStart().startsWith("not ok"));
  const assertion = run.stdout.split("\n").find((line) => line.includes("AssertionError"));
  return `${failed} failing test(s); first: ${(first ?? "(none captured)").trim()}${assertion ? ` | ${assertion.trim()}` : ""}`;
}

function unitTestFiles() {
  const dir = repoPath("tests/layers/01-unit");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .toSorted()
    .map((name) => join(dir, name));
}

async function gateSelfHosting() {
  const run = await runNode(["--test", "--test-reporter=tap", ...unitTestFiles()], {
    env: { PSTACK_CHILD_POLICY: CHILD_POLICY },
  });
  return verdict(
    run.code === 0,
    "the unit layer passes with PSTACK_CHILD_POLICY set in the environment",
    `the unit layer fails when PSTACK_CHILD_POLICY is inherited (exit ${run.code}): ${summarize(run)}`,
  );
}

async function gateTmpdirFlake() {
  return await withNamedTempDir("harness-evil", async (dir) => {
    const run = await runNode(
      ["--test", "--test-reporter=tap", repoPath("tests/layers/01-unit/integrations-registry.test.ts")],
      { env: { TMPDIR: dir } },
    );
    return verdict(
      run.code === 0,
      `integrations-registry passes with TMPDIR=${dir}`,
      `integrations-registry fails under TMPDIR=${dir} (exit ${run.code}): ${summarize(run)}`,
    );
  });
}

function stageDriftTree(dir) {
  const portDir = join(dir, "port");
  mkdirSync(portDir, { recursive: true });
  copyFileSync(repoPath("upstream.lock.json"), join(dir, "upstream.lock.json"));
  copyFileSync(repoPath("port/upstream.json"), join(portDir, "upstream.json"));
  const source = readFileSync(repoPath("port/drift.mjs"), "utf8");
  const patched = source.replace("if (commits.length === 0) {", "if (false) {");
  if (patched === source) throw new Error("port/drift.mjs no longer contains the commits.length === 0 branch");
  writeFileSync(join(portDir, "drift.mjs"), patched, "utf8");
  return join(portDir, "drift.mjs");
}

async function gateDriftExitCode() {
  const pinned = JSON.parse(readFileSync(repoPath("port/upstream.json"), "utf8"));
  const cache = repoPath(".port-upstream", `cursor-plugins-${pinned.commit.slice(0, 7)}`);
  return await withTempDir("drift", async (dir) => {
    const script = stageDriftTree(dir);
    const run = await runNode([script, "report"], {
      cwd: dir,
      env: { PORT_UPSTREAM_DIR: cache },
    });
    return verdict(
      run.code !== 0,
      `drift.mjs exits ${run.code} when the drift branch is taken`,
      `drift.mjs exits 0 on the drift branch, so real upstream drift never fails a gate. stdout: ${run.stdout.trim().split("\n").slice(0, 3).join(" | ")}`,
    );
  });
}

async function gateConformanceCoverage() {
  const run = await runNode([repoPath("tests/conformance.mjs")]);
  const reportsScan = /(?:scanned|of)\s+\d+\s+files?|\b\d+\s+files?\s+scanned/i.test(run.stdout);
  const ownedZero = /\b0 owned file\(s\)/.test(run.stdout);
  if (reportsScan && !ownedZero) return pass(`conformance reports scan coverage: ${run.stdout.trim()}`);
  return fail(
    `conformance reports only violations, not files scanned: ${run.stdout.trim()}${ownedZero ? " (and it owns zero files, so nothing is actually enforced)" : ""}`,
  );
}

export const GATE_PREDICATES = Object.freeze([
  { id: "GATE-01", description: "the repo has a strict typecheck script and it exits 0", run: gateTypecheckClean },
  { id: "GATE-02", description: "npm test transitively invokes the typecheck script", run: gateTypecheckInTest },
  { id: "GATE-03", description: "the coverage gate enforces --test-coverage-functions>=80", run: gateCoverageFunctions },
  { id: "GATE-04", description: "the coverage scope includes services/**", run: gateCoverageScope },
  { id: "GATE-05", description: "the unit suite is self-hosting-safe under PSTACK_CHILD_POLICY", run: gateSelfHosting },
  { id: "GATE-06", description: "the unit suite does not flake on a TMPDIR containing '-e'", run: gateTmpdirFlake },
  { id: "GATE-07", description: "port/drift.mjs exits nonzero when upstream drift is detected", run: gateDriftExitCode },
  { id: "GATE-08", description: "tests/conformance.mjs reports how many files it scanned", run: gateConformanceCoverage },
]);
