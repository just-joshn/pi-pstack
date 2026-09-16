import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SLOP_PATTERNS,
  applySafeDeletes,
  scanAddedLinesForSlop,
} from "../../../extensions/companions/deslop-core.ts";
import { registerCompanions } from "../../../extensions/companions/index.ts";

const COMMITTED_DIFF = [
  "diff --git a/app.ts b/app.ts",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1,2 +1,5 @@",
  "+// Phase 1: add cards",
  "+const total = 1",
  "+console.log(total)",
  "+//",
  "+const items = []",
].join("\n");

const UNSTAGED_DIFF = [
  "diff --git a/working.ts b/working.ts",
  "--- a/working.ts",
  "+++ b/working.ts",
  "@@ -1,1 +1,2 @@",
  "+// NOTE: legacy shim",
  "+const other = 2",
].join("\n");

const APP_ORIGINAL = [
  "// Phase 1: add cards",
  "const total = 1",
  "console.log(total)",
  "//",
  "const items = []",
  "",
].join("\n");

const WORKING_ORIGINAL = ["// NOTE: legacy shim", "const other = 2", ""].join("\n");

const APP_CLEAN = ["const total = 1", "console.log(total)", "const items = []", ""].join("\n");

const WORKING_CLEAN = ["const other = 2", ""].join("\n");

const APP_SUGGESTION_ROWS = [
  "// Phase 1: add cards",
  "const total = 1",
  "console.log(total)",
  "//",
  "const items = []",
].map((text) => ({ file: "app.ts", text }));

type ExecCall = { cmd: string; args: string[] };

type Finding = {
  label: string;
  severity: string;
  count: number;
  samples: string[];
  safeDelete: boolean;
};

type Suggestion = {
  file: string;
  line: string;
  label: string;
  severity: string;
  action: string;
  safeDelete: boolean;
};

type DeslopResult = {
  content: Array<{ text: string }>;
  details: {
    findings: Finding[];
    suggestions: Suggestion[];
    apply?: { applied: number; files: string[]; dryRun?: boolean };
  };
};

type DeslopTool = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: { properties: Record<string, { type?: string }> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: {
      cwd: string;
      ui?: { confirm?: (title: string, msg: string) => Promise<boolean | undefined> };
    },
  ) => Promise<DeslopResult>;
};

type CommandCapture = { handler: (args: unknown, ctx: unknown) => Promise<void> };

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "deslop-contracts-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, "utf8");
  return dir;
}

function fakePi(options: { committed?: string; unstaged?: string } = {}) {
  const tools = new Map<string, DeslopTool>();
  const commands = new Map<string, CommandCapture>();
  let execCalls: ExecCall[] = [];
  let sent: Array<{ text: string; opts?: unknown }> = [];
  const pi = {
    registerTool(cfg: DeslopTool) {
      tools.set(cfg.name, cfg);
    },
    registerCommand(name: string, cfg: CommandCapture) {
      commands.set(name, cfg);
    },
    exec: async (cmd: string, args: string[]) => {
      execCalls = [...execCalls, { cmd, args }];
      const isBase = args.some((arg) => arg.endsWith("...HEAD"));
      return {
        stdout: isBase ? (options.committed ?? "") : (options.unstaged ?? ""),
        stderr: "",
        code: 0,
      };
    },
    sendUserMessage: (text: string, opts?: unknown) => {
      sent = [...sent, { text, opts }];
    },
  };
  registerCompanions(pi as never);
  return {
    tools,
    commands,
    execCalls: () => execCalls,
    sent: () => sent,
    deslop: () => tools.get("pstack_deslop") as DeslopTool,
  };
}

test("deslop-01 registers the pstack_deslop tool and returns severity-ranked findings", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  const tool = h.deslop();
  assert.equal(tool.name, "pstack_deslop");
  assert.equal(tool.label, "Pstack Deslop");
  assert.equal(tool.promptSnippet, "Scan diff for prose/code slop before commit");
  assert.deepEqual(Object.keys(tool.parameters.properties), [
    "base",
    "paths",
    "applySafe",
    "autoApply",
    "dryRun",
  ]);
  assert.equal(typeof tool.execute, "function");

  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await tool.execute("t", {}, undefined, undefined, { cwd: dir, ui: {} });
    assert.deepEqual(
      out.details.findings.map((f) => [f.severity, f.label, f.count]),
      [
        ["high", "narration / alibi comment", 2],
        ["high", "debug console in diff", 1],
        ["low", "empty comment line", 1],
      ],
    );
    assert.match(out.content[0].text, /^pstack_deslop findings:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-02 rejects invalid base refs and accepts a clean ref", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF });
  const ctx = { cwd: "/tmp", ui: {} };
  for (const bad of ["-x", "main..HEAD", "feature branch", ".hidden"]) {
    await assert.rejects(
      () => h.deslop().execute("t", { base: bad }, undefined, undefined, ctx),
      /invalid git diff base/,
    );
  }
  assert.equal(h.execCalls().length, 0, "a rejected base never reaches git");

  await h.deslop().execute("t", { base: "develop" }, undefined, undefined, ctx);
  assert.equal(h.execCalls()[0].cmd, "git");
  assert.deepEqual(h.execCalls()[0].args, ["diff", "-U3", "develop...HEAD"]);
});

test("deslop-03 scans committed and unstaged diffs with the expected git args", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: dir, ui: {} });
    assert.deepEqual(
      h.execCalls().map((c) => c.args),
      [
        ["diff", "-U3", "main...HEAD"],
        ["diff", "-U3"],
      ],
    );
    assert.deepEqual(
      out.details.suggestions.map((s) => s.file),
      ["app.ts", "app.ts", "app.ts", "working.ts"],
    );
    assert.equal(out.details.suggestions[3].line, "// NOTE: legacy shim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-04 enforces 19 rules categorized into three severities", () => {
  assert.equal(SLOP_PATTERNS.length, 19);
  const counts = SLOP_PATTERNS.reduce(
    (acc: Record<string, number>, p) => ({ ...acc, [p.severity]: (acc[p.severity] ?? 0) + 1 }),
    {},
  );
  assert.deepEqual(counts, { high: 7, medium: 9, low: 3 });
  assert.deepEqual([...new Set(SLOP_PATTERNS.map((p) => p.severity))].toSorted(), [
    "high",
    "low",
    "medium",
  ]);
  assert.equal(new Set(SLOP_PATTERNS.map((p) => p.label)).size, 19);
  assert.deepEqual(
    [...new Set(SLOP_PATTERNS.map((p) => p.suggestion))].toSorted(),
    ["delete-line", "remove-emoji", "rewrite-prose", "tighten-type"],
  );
});

test("deslop-05 applySafeDeletes removes safe comments and keeps console and code", () => {
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL });
  try {
    const { suggestions, rankedLabels } = scanAddedLinesForSlop(APP_SUGGESTION_ROWS);
    assert.deepEqual(
      suggestions.map((s) => [s.label, s.severity, s.safeDelete]),
      [
        ["narration / alibi comment", "high", true],
        ["debug console in diff", "high", false],
        ["empty comment line", "low", true],
      ],
    );
    assert.deepEqual(rankedLabels, [
      "narration / alibi comment",
      "debug console in diff",
      "empty comment line",
    ]);

    const result = applySafeDeletes(dir, suggestions);
    assert.deepEqual(result, { applied: 2, files: ["app.ts"] });
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_CLEAN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-06 dryRun overrides applySafe and autoApply without mutating files", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  let confirmCalls = 0;
  try {
    const out = await h.deslop().execute(
      "t",
      { dryRun: true, applySafe: true, autoApply: true },
      undefined,
      undefined,
      {
        cwd: dir,
        ui: {
          confirm: async () => {
            confirmCalls += 1;
            return true;
          },
        },
      },
    );
    assert.equal(confirmCalls, 0, "dryRun returns before the autoApply prompt");
    assert.deepEqual(out.details.apply, {
      applied: 0,
      files: ["app.ts", "working.ts"],
      dryRun: true,
    });
    assert.match(
      out.content[0].text,
      /dryRun: would remove 3 safeDelete line\(s\) across 2 file\(s\) \(no writes\)$/,
    );
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_ORIGINAL);
    assert.equal(readFileSync(join(dir, "working.ts"), "utf8"), WORKING_ORIGINAL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-07 autoApply prompts before deleting and honors decline or missing UI", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  let prompts: Array<{ title: string; msg: string; contentBefore: string }> = [];
  try {
    const accepted = await h.deslop().execute("t", { autoApply: true }, undefined, undefined, {
      cwd: dir,
      ui: {
        confirm: async (title, msg) => {
          prompts = [
            ...prompts,
            { title, msg, contentBefore: readFileSync(join(dir, "app.ts"), "utf8") },
          ];
          return true;
        },
      },
    });
    assert.deepEqual(prompts, [
      {
        title: "pstack_deslop autoApply",
        msg: "Delete 3 safe slop line(s)?",
        contentBefore: APP_ORIGINAL,
      },
    ]);
    assert.deepEqual(accepted.details.apply, { applied: 3, files: ["app.ts", "working.ts"] });
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_CLEAN);

    writeFileSync(join(dir, "app.ts"), APP_ORIGINAL, "utf8");
    writeFileSync(join(dir, "working.ts"), WORKING_ORIGINAL, "utf8");
    const declined = await h.deslop().execute("t", { autoApply: true }, undefined, undefined, {
      cwd: dir,
      ui: { confirm: async () => false },
    });
    assert.equal(declined.details.apply, undefined);
    assert.match(declined.content[0].text, /autoApply: declined by operator$/);
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_ORIGINAL);

    const skipped = await h.deslop().execute("t", { autoApply: true }, undefined, undefined, {
      cwd: dir,
      ui: {},
    });
    assert.match(
      skipped.content[0].text,
      /autoApply: skipped \(no UI confirm available; pass applySafe:true to apply\)$/,
    );
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_ORIGINAL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-08 the deslop command queues the deslop plus unslop prompt", async () => {
  const h = fakePi();
  assert.deepEqual([...h.commands.keys()], ["deslop"]);
  let notices: Array<{ msg: string; level: string }> = [];
  await h.commands.get("deslop")!.handler([], {
    ui: {
      notify: (msg: string, level: string) => {
        notices = [...notices, { msg, level }];
      },
    },
  });
  assert.deepEqual(h.sent(), [
    {
      text: "Run pstack_deslop on the current diff against main (consider applySafe:true for safe comment deletes), then apply /skill:unslop to any prose surfaces and fix remaining findings with edit.",
      opts: { expandPromptTemplates: true },
    },
  ]);
  assert.deepEqual(notices, [{ msg: "Queued deslop twin", level: "info" }]);
});

test("deslop-09 defaults the base parameter to main", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF });
  const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: "/tmp", ui: {} });
  assert.deepEqual(h.execCalls()[0].args, ["diff", "-U3", "main...HEAD"]);
  assert.equal(out.details.findings.length, 3);
});

test("deslop-10 restricts the scan with the paths array and rejects unsafe paths", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF });
  const ctx = { cwd: "/tmp", ui: {} };
  await h.deslop().execute("t", { paths: ["src", "lib"] }, undefined, undefined, ctx);
  assert.deepEqual(h.execCalls()[0].args, ["diff", "-U3", "main...HEAD", "--", "src", "lib"]);
  assert.deepEqual(h.execCalls()[1].args, ["diff", "-U3"]);

  for (const bad of [["-x"], ["src\0evil"]]) {
    await assert.rejects(
      () => h.deslop().execute("t", { paths: bad }, undefined, undefined, ctx),
      /invalid path/,
    );
  }
  assert.equal(h.execCalls().length, 2, "a rejected path never reaches git");
});

test("deslop-11 applySafe true mutates files and reports removed lines", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  assert.equal(h.deslop().parameters.properties.applySafe.type, "boolean");
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await h.deslop().execute("t", { applySafe: true }, undefined, undefined, {
      cwd: dir,
      ui: {},
    });
    assert.deepEqual(out.details.apply, { applied: 3, files: ["app.ts", "working.ts"] });
    assert.match(
      out.content[0].text,
      /applySafe: removed 3 line\(s\) in 2 file\(s\): app\.ts, working\.ts$/,
    );
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_CLEAN);
    assert.equal(readFileSync(join(dir, "working.ts"), "utf8"), WORKING_CLEAN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-12 autoApply true is accepted and confirms before mutation", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  assert.equal(h.deslop().parameters.properties.autoApply.type, "boolean");
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  let prompts = 0;
  try {
    const out = await h.deslop().execute("t", { autoApply: true }, undefined, undefined, {
      cwd: dir,
      ui: {
        confirm: async () => {
          prompts += 1;
          return true;
        },
      },
    });
    assert.equal(prompts, 1);
    assert.deepEqual(out.details.apply, { applied: 3, files: ["app.ts", "working.ts"] });
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_CLEAN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-13 dryRun true is accepted and reports without writing", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  assert.equal(h.deslop().parameters.properties.dryRun.type, "boolean");
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await h.deslop().execute("t", { dryRun: true }, undefined, undefined, {
      cwd: dir,
      ui: {},
    });
    assert.deepEqual(out.details.apply, {
      applied: 0,
      files: ["app.ts", "working.ts"],
      dryRun: true,
    });
    assert.equal(readFileSync(join(dir, "app.ts"), "utf8"), APP_ORIGINAL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-14 caps suggestions at 80", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ file: "app.ts", text: `Simply value ${i}` }));
  const { suggestions, rankedLabels } = scanAddedLinesForSlop(rows);
  assert.equal(suggestions.length, 80);
  assert.equal(suggestions[0].line, "Simply value 0");
  assert.equal(suggestions[79].line, "Simply value 79");
  assert.deepEqual(rankedLabels, ["hedge/filler adverb"]);

  const diff = ["+++ b/app.ts", ...rows.map((r) => `+${r.text}`)].join("\n");
  const h = fakePi({ committed: diff });
  const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: "/tmp", ui: {} });
  assert.equal(out.details.suggestions.length, 80);
});

test("deslop-15 limits samples to 5 per rule", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `+console.log(${i + 1})`);
  const h = fakePi({ committed: ["+++ b/app.ts", ...rows].join("\n") });
  const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: "/tmp", ui: {} });
  assert.equal(out.details.findings.length, 1);
  const finding = out.details.findings[0];
  assert.equal(finding.label, "debug console in diff");
  assert.equal(finding.count, 7);
  assert.deepEqual(finding.samples, [
    "app.ts: console.log(1)",
    "app.ts: console.log(2)",
    "app.ts: console.log(3)",
    "app.ts: console.log(4)",
    "app.ts: console.log(5)",
  ]);
});

test("deslop-16 limits the fix block to 25 lines", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => `+Simply value ${i}`);
  const h = fakePi({ committed: ["+++ b/app.ts", ...rows].join("\n") });
  const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: "/tmp", ui: {} });
  assert.equal(out.details.suggestions.length, 30);
  const marker = "Structured fixes (apply via edit, or re-run with applySafe:true for safeDelete lines):\n";
  const block = out.content[0].text.split(marker)[1].split("\n\nThen /skill:unslop")[0];
  const lines = block.split("\n");
  assert.equal(lines.length, 25);
  assert.equal(lines[0], "- rewrite-prose [medium] app.ts: Simply value 0 (hedge/filler adverb)");
  assert.equal(lines[24], "- rewrite-prose [medium] app.ts: Simply value 24 (hedge/filler adverb)");
});
