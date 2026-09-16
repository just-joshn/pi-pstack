/**
 * Differential case domain.
 *
 * A case is a runnable definition: which executable it exercises, which stream
 * it observes, how that stream is normalized, and how both trees are invoked.
 * `measureCase` runs one definition against the pinned upstream tree and the
 * ported twin and returns the comparable outcome.
 *
 * The per-case rewrites are named on each normalizer; `assertCoverage` fails the
 * run when a synced-in upstream executable appears with no case, so the suite
 * cannot silently shrink as upstream drifts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { SCRIPTS_REL, childEnv, runChild, writeLine } from "./environment.mjs";
import { treeExecutables } from "./fixtures.mjs";

export const DIFF_LINE_LIMIT = 24;
const AUDIT_COLUMNS = { 0: "<size>", 1: "<age>", 6: "<date>" };

// Upstream executable -> case ids that exercise it.
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

export function normalizeCases(ctx) {
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

export function caseDefinitions(norms, ctx) {
  return [...watchPrCases(norms, ctx), ...localCases(norms, ctx)];
}

export function measureCase(definition, ctx) {
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

export function diffLines(upstreamText, portedText) {
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

export function formatMismatch(outcome) {
  const header = `case ${outcome.id} differs; upstream rc=${outcome.upstreamRc} ported rc=${outcome.portedRc}; normalization: ${outcome.normalization}`;
  const lines = diffLines(outcome.upstreamText, outcome.portedText);
  return [header, ...(lines.length > 0 ? lines : ["  normalized text equal; exit codes differ"])].join("\n");
}

export function dumpCase(outcome) {
  writeLine(`--- ${outcome.id} upstream rc=${outcome.upstreamRc}`);
  writeLine(outcome.upstreamText);
  writeLine(`--- ${outcome.id} ported rc=${outcome.portedRc}`);
  writeLine(outcome.portedText);
}

export function assertCoverage(ctx, definitions) {
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

export function preflight(ctx) {
  return runWatchPr(ctx, ctx.trees.ported, { id: "preflight", args: ["--help"], bin: null });
}
