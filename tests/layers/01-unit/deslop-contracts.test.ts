import { expect, test } from "vitest";
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
  expect(tool.name).toBe("pstack_deslop");
  expect(tool.label).toBe("Pstack Deslop");
  expect(tool.promptSnippet).toBe("Scan diff for prose/code slop before commit");
  expect(Object.keys(tool.parameters.properties)).toEqual([
    "base",
    "paths",
    "applySafe",
    "autoApply",
    "dryRun",
  ]);
  expect(typeof tool.execute).toBe("function");

  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await tool.execute("t", {}, undefined, undefined, { cwd: dir, ui: {} });
    expect(out.details.findings.map((f) => [f.severity, f.label, f.count])).toEqual([
        ["high", "narration / alibi comment", 2],
        ["high", "debug console in diff", 1],
        ["low", "empty comment line", 1],
      ]);
    expect(out.content[0].text).toMatch(/^pstack_deslop findings:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-02 rejects invalid base refs and accepts a clean ref", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF });
  const ctx = { cwd: "/tmp", ui: {} };
  for (const bad of ["-x", "main..HEAD", "feature branch", ".hidden"]) {
    await expect(() => h.deslop().execute("t", { base: bad }, undefined, undefined, ctx)).rejects.toThrow(/invalid git diff base/);
  }
  expect(h.execCalls().length, "a rejected base never reaches git").toBe(0);

  await h.deslop().execute("t", { base: "develop" }, undefined, undefined, ctx);
  expect(h.execCalls()[0].cmd).toBe("git");
  expect(h.execCalls()[0].args).toEqual(["diff", "-U3", "develop...HEAD"]);
});

test("deslop-03 scans committed and unstaged diffs with the expected git args", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: dir, ui: {} });
    expect(h.execCalls().map((c) => c.args)).toEqual([
        ["diff", "-U3", "main...HEAD"],
        ["diff", "-U3"],
      ]);
    expect(out.details.suggestions.map((s) => s.file)).toEqual(["app.ts", "app.ts", "app.ts", "working.ts"]);
    expect(out.details.suggestions[3].line).toBe("// NOTE: legacy shim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-04 enforces 19 rules categorized into three severities", () => {
  expect(SLOP_PATTERNS.length).toBe(19);
  const counts = SLOP_PATTERNS.reduce(
    (acc: Record<string, number>, p) => ({ ...acc, [p.severity]: (acc[p.severity] ?? 0) + 1 }),
    {},
  );
  expect(counts).toEqual({ high: 7, medium: 9, low: 3 });
  expect([...new Set(SLOP_PATTERNS.map((p) => p.severity))].toSorted()).toEqual([
    "high",
    "low",
    "medium",
  ]);
  expect(new Set(SLOP_PATTERNS.map((p) => p.label)).size).toBe(19);
  expect([...new Set(SLOP_PATTERNS.map((p) => p.suggestion))].toSorted()).toEqual(["delete-line", "remove-emoji", "rewrite-prose", "tighten-type"]);
});

test("deslop-05 applySafeDeletes removes safe comments and keeps console and code", async () => {
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL });
  try {
    const { suggestions, rankedLabels } = scanAddedLinesForSlop(APP_SUGGESTION_ROWS);
    expect(suggestions.map((s) => [s.label, s.severity, s.safeDelete])).toEqual([
        ["narration / alibi comment", "high", true],
        ["debug console in diff", "high", false],
        ["empty comment line", "low", true],
      ]);
    expect(rankedLabels).toEqual([
      "narration / alibi comment",
      "debug console in diff",
      "empty comment line",
    ]);

    const result = await applySafeDeletes(dir, suggestions);
    expect(result).toEqual({ applied: 2, files: ["app.ts"] });
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_CLEAN);
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
    expect(confirmCalls, "dryRun returns before the autoApply prompt").toBe(0);
    expect(out.details.apply).toEqual({
      applied: 0,
      files: ["app.ts", "working.ts"],
      dryRun: true,
    });
    expect(out.content[0].text).toMatch(/dryRun: would remove 3 safeDelete line\(s\) across 2 file\(s\) \(no writes\)$/);
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_ORIGINAL);
    expect(readFileSync(join(dir, "working.ts"), "utf8")).toBe(WORKING_ORIGINAL);
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
    expect(prompts).toEqual([
      {
        title: "pstack_deslop autoApply",
        msg: "Delete 3 safe slop line(s)?",
        contentBefore: APP_ORIGINAL,
      },
    ]);
    expect(accepted.details.apply).toEqual({ applied: 3, files: ["app.ts", "working.ts"] });
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_CLEAN);

    writeFileSync(join(dir, "app.ts"), APP_ORIGINAL, "utf8");
    writeFileSync(join(dir, "working.ts"), WORKING_ORIGINAL, "utf8");
    const declined = await h.deslop().execute("t", { autoApply: true }, undefined, undefined, {
      cwd: dir,
      ui: { confirm: async () => false },
    });
    expect(declined.details.apply).toBe(undefined);
    expect(declined.content[0].text).toMatch(/autoApply: declined by operator$/);
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_ORIGINAL);

    const skipped = await h.deslop().execute("t", { autoApply: true }, undefined, undefined, {
      cwd: dir,
      ui: {},
    });
    expect(skipped.content[0].text).toMatch(/autoApply: skipped \(no UI confirm available; pass applySafe:true to apply\)$/);
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_ORIGINAL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-08 the deslop command queues the deslop plus unslop prompt", async () => {
  const h = fakePi();
  expect([...h.commands.keys()]).toEqual(["deslop"]);
  let notices: Array<{ msg: string; level: string }> = [];
  await h.commands.get("deslop")!.handler([], {
    ui: {
      notify: (msg: string, level: string) => {
        notices = [...notices, { msg, level }];
      },
    },
  });
  expect(h.sent()).toEqual([
    {
      text: "Run pstack_deslop on the current diff against main (consider applySafe:true for safe comment deletes), then apply /skill:unslop to any prose surfaces and fix remaining findings with edit.",
      opts: { expandPromptTemplates: true, deliverAs: "followUp" },
    },
  ]);
  expect(notices).toEqual([{ msg: "Queued deslop twin", level: "info" }]);
});

test("deslop-09 defaults the base parameter to main", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF });
  const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: "/tmp", ui: {} });
  expect(h.execCalls()[0].args).toEqual(["diff", "-U3", "main...HEAD"]);
  expect(out.details.findings.length).toBe(3);
});

test("deslop-10 restricts the scan with the paths array and rejects unsafe paths", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF });
  const ctx = { cwd: "/tmp", ui: {} };
  await h.deslop().execute("t", { paths: ["src", "lib"] }, undefined, undefined, ctx);
  expect(h.execCalls()[0].args).toEqual(["diff", "-U3", "main...HEAD", "--", "src", "lib"]);
  expect(h.execCalls()[1].args).toEqual(["diff", "-U3"]);

  for (const bad of [["-x"], ["src\0evil"]]) {
    await expect(() => h.deslop().execute("t", { paths: bad }, undefined, undefined, ctx)).rejects.toThrow(/invalid path/);
  }
  expect(h.execCalls().length, "a rejected path never reaches git").toBe(2);
});

test("deslop-11 applySafe true mutates files and reports removed lines", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  expect(h.deslop().parameters.properties.applySafe.type).toBe("boolean");
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await h.deslop().execute("t", { applySafe: true }, undefined, undefined, {
      cwd: dir,
      ui: {},
    });
    expect(out.details.apply).toEqual({ applied: 3, files: ["app.ts", "working.ts"] });
    expect(out.content[0].text).toMatch(/applySafe: removed 3 line\(s\) in 2 file\(s\): app\.ts, working\.ts$/);
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_CLEAN);
    expect(readFileSync(join(dir, "working.ts"), "utf8")).toBe(WORKING_CLEAN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-12 autoApply true is accepted and confirms before mutation", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  expect(h.deslop().parameters.properties.autoApply.type).toBe("boolean");
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
    expect(prompts).toBe(1);
    expect(out.details.apply).toEqual({ applied: 3, files: ["app.ts", "working.ts"] });
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_CLEAN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-13 dryRun true is accepted and reports without writing", async () => {
  const h = fakePi({ committed: COMMITTED_DIFF, unstaged: UNSTAGED_DIFF });
  expect(h.deslop().parameters.properties.dryRun.type).toBe("boolean");
  const dir = fixtureDir({ "app.ts": APP_ORIGINAL, "working.ts": WORKING_ORIGINAL });
  try {
    const out = await h.deslop().execute("t", { dryRun: true }, undefined, undefined, {
      cwd: dir,
      ui: {},
    });
    expect(out.details.apply).toEqual({
      applied: 0,
      files: ["app.ts", "working.ts"],
      dryRun: true,
    });
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe(APP_ORIGINAL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deslop-14 caps suggestions at 80", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ file: "app.ts", text: `Simply value ${i}` }));
  const { suggestions, rankedLabels } = scanAddedLinesForSlop(rows);
  expect(suggestions.length).toBe(80);
  expect(suggestions[0].line).toBe("Simply value 0");
  expect(suggestions[79].line).toBe("Simply value 79");
  expect(rankedLabels).toEqual(["hedge/filler adverb"]);

  const diff = ["+++ b/app.ts", ...rows.map((r) => `+${r.text}`)].join("\n");
  const h = fakePi({ committed: diff });
  const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: "/tmp", ui: {} });
  expect(out.details.suggestions.length).toBe(80);
});

test("deslop-15 limits samples to 5 per rule", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `+console.log(${i + 1})`);
  const h = fakePi({ committed: ["+++ b/app.ts", ...rows].join("\n") });
  const out = await h.deslop().execute("t", {}, undefined, undefined, { cwd: "/tmp", ui: {} });
  expect(out.details.findings.length).toBe(1);
  const finding = out.details.findings[0];
  expect(finding.label).toBe("debug console in diff");
  expect(finding.count).toBe(7);
  expect(finding.samples).toEqual([
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
  expect(out.details.suggestions.length).toBe(30);
  const marker = "Structured fixes (apply via edit, or re-run with applySafe:true for safeDelete lines):\n";
  const block = out.content[0].text.split(marker)[1].split("\n\nThen /skill:unslop")[0];
  const lines = block.split("\n");
  expect(lines.length).toBe(25);
  expect(lines[0]).toBe("- rewrite-prose [medium] app.ts: Simply value 0 (hedge/filler adverb)");
  expect(lines[24]).toBe("- rewrite-prose [medium] app.ts: Simply value 24 (hedge/filler adverb)");
});
