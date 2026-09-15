/**
 * Behavioral ledger proofs for the sessions surface (spec/contracts/companions.tsv).
 * Drives the registered pstack_sessions tool through a fake pi and asserts literal results.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessions } from "../../../extensions/sessions/index.ts";
import {
  hitsFromGhPrs,
  hitsFromGitLog,
  hitsFromSessionSnippets,
  rankRecallHits,
} from "../../../extensions/sessions/recall-rank.ts";

interface SessionFileEntry {
  path: string;
  mtimeMs: number;
  bytes: number;
}

interface RankedHit {
  source: string;
  score: number;
  title: string;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: {
    files?: SessionFileEntry[];
    hitCount?: number;
    file?: string;
    corpus?: string[];
    sessionHits?: number;
    rankedHits?: number;
    top?: RankedHit[];
  };
}

interface ToolParams {
  action: string;
  query?: string;
  limit?: number;
  days?: number;
}

interface PropertySchema {
  description?: string;
  minimum?: number;
  maximum?: number;
}

interface SessionTool {
  parameters: { properties: Record<string, PropertySchema> };
  execute: (
    id: string,
    params: ToolParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<ToolResult>;
}

interface Sandbox {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly sessionDir: string;
  readonly bin: string;
}

interface FakeRecallTools {
  gitLog: string;
  prJson: string;
}

const ENV_KEYS = ["HOME", "PI_SESSION_DIR", "PI_SESSION_FILE", "PATH"] as const;

function captureTool(): SessionTool {
  const captured: SessionTool[] = [];
  registerSessions({
    registerTool: (definition: SessionTool) => {
      captured[0] = definition;
    },
  } as never);
  const tool = captured[0];
  if (!tool) throw new Error("registerSessions did not register pstack_sessions");
  return tool;
}

function installFakeRecallTools(binDir: string, tools: FakeRecallTools): void {
  const git = ["#!/bin/sh", `echo "${tools.gitLog}"`, ""].join("\n");
  const gh = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi',
    `printf '%s' '${tools.prJson}'`,
    "",
  ].join("\n");
  writeFileSync(join(binDir, "git"), git, { mode: 0o755 });
  writeFileSync(join(binDir, "gh"), gh, { mode: 0o755 });
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pstack-sessions-contract-"));
  const sandbox = {
    root,
    cwd: join(root, "cwd"),
    home: join(root, "home"),
    sessionDir: join(root, "session-dir"),
    bin: join(root, "bin"),
  };
  mkdirSync(sandbox.cwd, { recursive: true });
  mkdirSync(sandbox.home, { recursive: true });
  mkdirSync(sandbox.sessionDir, { recursive: true });
  mkdirSync(sandbox.bin, { recursive: true });
  installFakeRecallTools(sandbox.bin, { gitLog: "aaaaaaa base commit", prJson: "[]" });
  return sandbox;
}

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

async function withSandbox(run: (sandbox: Sandbox, tool: SessionTool) => Promise<void>): Promise<void> {
  const sandbox = makeSandbox();
  const snapshot = snapshotEnv();
  process.env.HOME = sandbox.home;
  process.env.PI_SESSION_DIR = sandbox.sessionDir;
  process.env.PI_SESSION_FILE = join(sandbox.root, "active-session.jsonl");
  process.env.PATH = `${sandbox.bin}:${process.env.PATH ?? ""}`;
  try {
    await run(sandbox, captureTool());
  } finally {
    restoreEnv(snapshot);
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function callTool(
  tool: SessionTool,
  params: ToolParams,
  cwd: string,
  sessionManager: Record<string, unknown> = {},
): Promise<ToolResult> {
  return tool.execute("contract", params, undefined, undefined, { cwd, sessionManager });
}

function writeSessionFile(
  dir: string,
  name: string,
  content: string,
  options: { ageDays?: number; mtimeMs?: number } = {},
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  const when = options.mtimeMs ?? (options.ageDays ? Date.now() - options.ageDays * 86400000 : undefined);
  if (when !== undefined) utimesSync(path, new Date(when), new Date(when));
  return path;
}

function listedPaths(result: ToolResult): string[] {
  return (result.details.files ?? []).map((entry) => entry.path);
}

function textOf(result: ToolResult): string {
  return result.content[0]?.text ?? "";
}

test("sessions-01 dispatches list, grep, current, and recall over the corpus", async () => {
  await withSandbox(async (sandbox, tool) => {
    writeSessionFile(sandbox.sessionDir, "hit.jsonl", "line one dispatchmarker\n");
    writeSessionFile(sandbox.sessionDir, "miss.jsonl", "unrelated line\n");

    const listed = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.equal(listedPaths(listed).length, 2, "list returns both session files");
    assert.match(textOf(listed), /\d{4}-\d{2}-\d{2}T.*\d+B.*hit\.jsonl/);

    const grepped = await callTool(tool, { action: "grep", query: "dispatchmarker" }, sandbox.cwd);
    assert.equal(grepped.details.hitCount, 1);
    assert.ok(textOf(grepped).includes("hit.jsonl"));
    assert.ok(!textOf(grepped).includes("miss.jsonl"));

    const current = await callTool(tool, { action: "current" }, sandbox.cwd, {
      getSessionFile: () => "/tmp/live.jsonl",
    });
    assert.equal(current.details.file, "/tmp/live.jsonl");
    assert.equal(textOf(current), "current session: /tmp/live.jsonl");

    const recalled = await callTool(tool, { action: "recall", query: "dispatchmarker" }, sandbox.cwd);
    assert.deepEqual(recalled.details.corpus, ["sessions", "git-log", "gh-prs", "ranked-merge"]);
  });
});

test("sessions-02 includes PI_SESSION_DIR for local workflow overrides", async () => {
  await withSandbox(async (sandbox, tool) => {
    const path = writeSessionFile(sandbox.sessionDir, "override.jsonl", "override\n");

    const withDir = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.deepEqual(listedPaths(withDir), [path]);

    process.env.PI_SESSION_DIR = "";
    const withoutDir = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.deepEqual(listedPaths(withoutDir), []);
  });
});

test("sessions-03 walks four levels deep for .json and .jsonl files", async () => {
  await withSandbox(async (sandbox, tool) => {
    const jsonl = writeSessionFile(join(sandbox.sessionDir, "a/b/c/d"), "level4.jsonl", "{}\n");
    const json = writeSessionFile(join(sandbox.sessionDir, "a/b/c/d"), "level4.json", "{}\n");
    writeSessionFile(join(sandbox.sessionDir, "a/b/c/d/e"), "level5.jsonl", "{}\n");
    writeSessionFile(join(sandbox.sessionDir, "a/b/c"), "notes.txt", "nope\n");

    const result = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.deepEqual(listedPaths(result).toSorted(), [json, jsonl].toSorted());
  });
});

test("sessions-04 filters files to the days cutoff", async () => {
  await withSandbox(async (sandbox, tool) => {
    const fresh = writeSessionFile(sandbox.sessionDir, "fresh.jsonl", "{}\n");
    const aged = writeSessionFile(sandbox.sessionDir, "aged.jsonl", "{}\n", { ageDays: 30 });

    const withinDefault = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.deepEqual(listedPaths(withinDefault), [fresh]);

    const widened = await callTool(tool, { action: "list", days: 40 }, sandbox.cwd);
    assert.deepEqual(listedPaths(widened).toSorted(), [fresh, aged].toSorted());
  });
});

test("sessions-05 current action bypasses the cutoff and falls back to PI_SESSION_FILE", async () => {
  await withSandbox(async (sandbox, tool) => {
    writeSessionFile(sandbox.sessionDir, "stale.jsonl", "{}\n", { ageDays: 30 });
    const staleList = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.deepEqual(listedPaths(staleList), [], "the aged file is outside the cutoff");

    process.env.PI_SESSION_FILE = "/tmp/env-session.jsonl";
    const fromManager = await callTool(tool, { action: "current" }, sandbox.cwd, {
      getSessionFile: () => "/tmp/manager-session.jsonl",
    });
    assert.equal(fromManager.details.file, "/tmp/manager-session.jsonl");

    const fromEnv = await callTool(tool, { action: "current" }, sandbox.cwd);
    assert.equal(fromEnv.details.file, "/tmp/env-session.jsonl");

    Reflect.deleteProperty(process.env, "PI_SESSION_FILE");
    const unknown = await callTool(tool, { action: "current" }, sandbox.cwd);
    assert.equal(unknown.details.file, "(unknown)");
    assert.equal(textOf(unknown), "current session: (unknown)");
  });
});

test("sessions-06 joins three matching lines and truncates grep hits to 400 characters", async () => {
  await withSandbox(async (sandbox, tool) => {
    const path = writeSessionFile(
      sandbox.sessionDir,
      "grep.jsonl",
      "grepcontract one\ngrepcontract two\ngrepcontract three\ngrepcontract four\ngrepcontract five\n",
    );
    const joined = await callTool(tool, { action: "grep", query: "grepcontract" }, sandbox.cwd);
    assert.equal(textOf(joined), `${path}\n  grepcontract one | grepcontract two | grepcontract three`);

    const longLine = `longcontract ${"z".repeat(500)}`;
    const longPath = writeSessionFile(sandbox.sessionDir, "long.jsonl", `${longLine}\n`);
    const truncated = await callTool(tool, { action: "grep", query: "longcontract" }, sandbox.cwd);
    assert.equal(textOf(truncated), `${longPath}\n  ${longLine.slice(0, 400)}`);

    writeSessionFile(sandbox.sessionDir, "limit-a.jsonl", "limithit a\n");
    writeSessionFile(sandbox.sessionDir, "limit-b.jsonl", "limithit b\n");
    writeSessionFile(sandbox.sessionDir, "limit-c.jsonl", "limithit c\n");
    const limited = await callTool(tool, { action: "grep", query: "limithit", limit: 2 }, sandbox.cwd);
    assert.equal(limited.details.hitCount, 2);
    assert.equal(textOf(limited).split("\n\n").length, 2);
  });
});

test("sessions-07 recall merges sessions, git log, and gh PRs into one ranked local result", async () => {
  await withSandbox(async (sandbox, tool) => {
    installFakeRecallTools(sandbox.bin, {
      gitLog: "abc1234 recallmerge git log subject",
      prJson: JSON.stringify([
        {
          number: 42,
          title: `${"x".repeat(90)}recallmerge pr title`,
          state: "OPEN",
          updatedAt: "2026-01-01T00:00:00Z",
          url: "https://example.test/pr/42",
          headRefName: "topic",
        },
      ]),
    });
    writeSessionFile(sandbox.sessionDir, "recall.jsonl", `${"p".repeat(100)} recallmerge session body\n`);

    const result = await callTool(tool, { action: "recall", query: "recallmerge", days: 30 }, sandbox.cwd);
    assert.deepEqual(result.details.corpus, ["sessions", "git-log", "gh-prs", "ranked-merge"]);
    assert.equal(result.details.sessionHits, 1);
    assert.equal(result.details.rankedHits, 3);
    assert.deepEqual(
      (result.details.top ?? []).map((hit) => `${hit.source}:${hit.score}`),
      ["session:33", "gh:31", "git:30"],
    );
  });
});

test("sessions-08 ranks hits using base scores 20 for sessions, 18 for gh, and 15 for git", () => {
  const sessions = hitsFromSessionSnippets(["/tmp/s.jsonl\n  neutral snippet"], "");
  const git = hitsFromGitLog("abc1234 neutral commit", "");
  const gh = hitsFromGhPrs("#7 [OPEN] neutral pr (topic) 2026-01-01 https://example.test/7", "");

  assert.deepEqual(
    [...sessions, ...git, ...gh].map((hit) => [hit.source, hit.score]),
    [
      ["session", 20],
      ["git", 15],
      ["gh", 18],
    ],
  );
  assert.deepEqual(
    rankRecallHits([...sessions, ...git, ...gh]).map((hit) => `${hit.source}:${hit.score}`),
    ["session:20", "gh:18", "git:15"],
  );
});

test("sessions-09 awards exact-substring and long-token bonuses in recall scoring", () => {
  const early = hitsFromSessionSnippets(["/tmp/a.jsonl\n  alpha here"], "alpha");
  assert.equal(early[0].score, 35, "exact substring at offset < 80 earns 10 + 3 + 2");

  const late = hitsFromSessionSnippets([`/tmp/a.jsonl\n  ${"z".repeat(90)}alpha`], "alpha");
  assert.equal(late[0].score, 33, "offset >= 80 drops the proximity bonus");

  const partial = hitsFromSessionSnippets(["/tmp/a.jsonl\n  alpha only"], "alpha beta");
  assert.equal(partial[0].score, 23, "one long token present and no exact-substring bonus");

  const shortTokenOnly = hitsFromSessionSnippets(["/tmp/a.jsonl\n  ab only"], "ab alpha");
  assert.equal(shortTokenOnly[0].score, 20, "tokens of two characters or fewer do not score");

  const git = hitsFromGitLog("abc1234 alpha subject", "alpha");
  assert.equal(git[0].score, 30, "git uses the same matching bonuses on its base");
});

test("sessions-10 breaks score ties by source priority and then title", () => {
  const tied = [
    { source: "git", score: 20, title: "beta", detail: "" },
    { source: "gh", score: 20, title: "gamma", detail: "" },
    { source: "session", score: 20, title: "delta", detail: "" },
  ];
  assert.deepEqual(
    rankRecallHits(tied).map((hit) => hit.source),
    ["session", "gh", "git"],
  );

  const sameSource = [
    { source: "session", score: 20, title: "zeta", detail: "" },
    { source: "session", score: 20, title: "alpha", detail: "" },
  ];
  assert.deepEqual(
    rankRecallHits(sameSource).map((hit) => hit.title),
    ["alpha", "zeta"],
  );
});

test("sessions-11 requires the action parameter to be list, grep, current, or recall", async () => {
  await withSandbox(async (sandbox, tool) => {
    assert.equal(tool.parameters.properties.action?.description, "list | grep | current | recall");
    await assert.rejects(
      () => callTool(tool, { action: "summarize" }, sandbox.cwd),
      /action must be list\|grep\|current\|recall/,
    );
  });
});

test("sessions-12 accepts a query parameter for grep and recall", async () => {
  await withSandbox(async (sandbox, tool) => {
    const match = writeSessionFile(sandbox.sessionDir, "match.jsonl", "querymarker body\n");
    const miss = writeSessionFile(sandbox.sessionDir, "miss.jsonl", "nothing relevant\n");

    await assert.rejects(
      () => callTool(tool, { action: "grep" }, sandbox.cwd),
      /query required for grep/,
    );

    const grepped = await callTool(tool, { action: "grep", query: "querymarker" }, sandbox.cwd);
    assert.equal(grepped.details.hitCount, 1);
    assert.ok(textOf(grepped).includes(match));

    const recalled = await callTool(tool, { action: "recall", query: "querymarker" }, sandbox.cwd);
    assert.ok(textOf(recalled).includes("query=querymarker days=7"));
    assert.ok(textOf(recalled).includes(match));
    assert.ok(!textOf(recalled).includes(miss));
  });
});

test("sessions-13 constrains limit to 1..100 with a default of 20", async () => {
  await withSandbox(async (sandbox, tool) => {
    assert.equal(tool.parameters.properties.limit?.minimum, 1);
    assert.equal(tool.parameters.properties.limit?.maximum, 100);

    const names = Array.from({ length: 25 }, (_, index) => `limit-${index}.jsonl`);
    for (const name of names) writeSessionFile(sandbox.sessionDir, name, "{}\n");

    const defaulted = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.equal(listedPaths(defaulted).length, 20);

    const explicit = await callTool(tool, { action: "list", limit: 3 }, sandbox.cwd);
    assert.equal(listedPaths(explicit).length, 3);
  });
});

test("sessions-14 constrains days to 1..365 with a default of 7", async () => {
  await withSandbox(async (sandbox, tool) => {
    assert.equal(tool.parameters.properties.days?.minimum, 1);
    assert.equal(tool.parameters.properties.days?.maximum, 365);

    const fresh = writeSessionFile(sandbox.sessionDir, "days-fresh.jsonl", "{}\n");
    const aged = writeSessionFile(sandbox.sessionDir, "days-aged.jsonl", "{}\n", { ageDays: 8 });

    const defaulted = await callTool(tool, { action: "list" }, sandbox.cwd);
    assert.deepEqual(listedPaths(defaulted), [fresh]);

    const widened = await callTool(tool, { action: "list", days: 30 }, sandbox.cwd);
    assert.deepEqual(listedPaths(widened).toSorted(), [fresh, aged].toSorted());

    const narrowed = await callTool(tool, { action: "list", days: 1 }, sandbox.cwd);
    assert.deepEqual(listedPaths(narrowed), [fresh]);
  });
});

test("sessions-15 orders corpus directories cwd, home agent, home, then PI_SESSION_DIR", async () => {
  await withSandbox(async (sandbox, tool) => {
    const fixed = Date.now() - 60000;
    const cwdFile = writeSessionFile(join(sandbox.cwd, ".pi/sessions"), "a-cwd.jsonl", "{}\n", { mtimeMs: fixed });
    const agentFile = writeSessionFile(join(sandbox.home, ".pi/agent/sessions"), "b-agent.jsonl", "{}\n", { mtimeMs: fixed });
    const homeFile = writeSessionFile(join(sandbox.home, ".pi/sessions"), "c-home.jsonl", "{}\n", { mtimeMs: fixed });
    const dirFile = writeSessionFile(sandbox.sessionDir, "d-override.jsonl", "{}\n", { mtimeMs: fixed });

    const result = await callTool(tool, { action: "list", limit: 10 }, sandbox.cwd);
    assert.deepEqual(listedPaths(result), [cwdFile, agentFile, homeFile, dirFile]);
  });
});

test("sessions-16 caps the walk at the 200 most recently modified files", async () => {
  await withSandbox(async (sandbox, tool) => {
    const base = Date.now();
    const names = Array.from({ length: 205 }, (_, index) => `f-${String(index).padStart(3, "0")}.jsonl`);
    for (const [index, name] of names.entries()) {
      writeSessionFile(sandbox.sessionDir, name, "{}\n", { mtimeMs: base - index * 5000 });
    }

    // The host clamps limit to 100. The test passes an oversized limit to observe the walk cap itself.
    const result = await callTool(tool, { action: "list", limit: 500 }, sandbox.cwd);
    const paths = listedPaths(result);
    assert.equal(paths.length, 200);
    assert.deepEqual(
      paths.map((path) => path.split("/").at(-1)),
      names.slice(0, 200),
    );
  });
});

test("sessions-17 formats recall output into four ordered sections", async () => {
  await withSandbox(async (sandbox, tool) => {
    installFakeRecallTools(sandbox.bin, {
      gitLog: "abc1234 sectionsmarker git log line",
      prJson: JSON.stringify([
        {
          number: 7,
          title: "sectionsmarker pr",
          state: "OPEN",
          updatedAt: "2026-01-01T00:00:00Z",
          url: "https://example.test/pr/7",
          headRefName: "topic",
        },
      ]),
    });
    writeSessionFile(sandbox.sessionDir, "sections.jsonl", "sectionsmarker session body\n");

    const result = await callTool(tool, { action: "recall", query: "sectionsmarker" }, sandbox.cwd);
    const body = textOf(result);
    assert.ok(body.startsWith("## Recall corpus (local, ranked)\nquery=sectionsmarker days=7\n"));

    const headings = [
      "### Ranked merge (sessions + git + gh)",
      "### Pi sessions (raw)",
      "### git log",
      "### gh PRs",
    ];
    const positions = headings.map((heading) => body.indexOf(heading));
    assert.ok(positions.every((position) => position >= 0), "all four recall sections render");
    assert.deepEqual(positions.toSorted((a, b) => a - b), positions, "sections keep corpus order");
    assert.equal(body.split("### ").length - 1, 4, "exactly four sections");
    assert.match(body, /\n1\. \[session score=\d+\]/);
    assert.ok(body.includes("sectionsmarker session body"));
  });
});
