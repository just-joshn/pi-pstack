import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallGhPrs, recallGitLog } from "../../../extensions/sessions/recall-corpus.ts";
import {
  buildRankedRecallCorpus,
  formatRankedRecallBody,
  hitsFromGhPrs,
  hitsFromGitLog,
  hitsFromSessionSnippets,
  rankRecallHits,
  type RecallHit,
} from "../../../extensions/sessions/recall-rank.ts";
import { registerSessions } from "../../../extensions/sessions/index.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface SessionTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<ToolResult>;
}

interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly sessionDir: string;
  readonly bin: string;
  readonly cwd: string;
}

interface FakeGh {
  versionCode?: number;
  stdout?: string;
  stderr?: string;
}

const ENV_KEYS = ["HOME", "PI_SESSION_DIR", "PI_SESSION_FILE", "PATH"] as const;
const GH_LOG = "gh-args.log";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function captureTool(): SessionTool {
  let captured: SessionTool | undefined;
  registerSessions({
    registerTool: (definition: SessionTool) => {
      captured = definition;
    },
  } as never);
  return captured as SessionTool;
}

function makeSandbox(): Sandbox {
  const root = tempDir("pstack-sessions-fn-");
  const sandbox = {
    root,
    home: join(root, "home"),
    sessionDir: join(root, "sessions"),
    bin: join(root, "bin"),
    cwd: join(root, "cwd"),
  };
  mkdirSync(sandbox.home, { recursive: true });
  mkdirSync(sandbox.sessionDir, { recursive: true });
  mkdirSync(sandbox.bin, { recursive: true });
  mkdirSync(sandbox.cwd, { recursive: true });
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
  process.env.PATH = `${sandbox.bin}:${process.env.PATH ?? ""}`;
  Reflect.deleteProperty(process.env, "PI_SESSION_FILE");
  try {
    await run(sandbox, captureTool());
  } finally {
    restoreEnv(snapshot);
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function callTool(
  tool: SessionTool,
  params: Record<string, unknown>,
  cwd: string,
  sessionManager: Record<string, unknown> = {},
): Promise<ToolResult> {
  return tool.execute("t", params, undefined, undefined, {
    cwd,
    sessionManager,
    isProjectTrusted: () => true,
  });
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

function installFakeGh(bin: string, options: FakeGh = {}): void {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, GH_LOG), "", "utf8");
  writeFileSync(join(bin, "stdout.txt"), options.stdout ?? "[]", "utf8");
  writeFileSync(join(bin, "stderr.txt"), options.stderr ?? "", "utf8");
  const lines = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(join(bin, GH_LOG))}`,
    `if [ "$1" = "--version" ]; then echo "gh version 2.101.0"; exit ${options.versionCode ?? 0}; fi`,
    `cat ${JSON.stringify(join(bin, "stderr.txt"))} 1>&2`,
    `cat ${JSON.stringify(join(bin, "stdout.txt"))}`,
    "",
  ];
  const script = join(bin, "gh");
  writeFileSync(script, lines.join("\n"), "utf8");
  chmodSync(script, 0o755);
}

function lastGhCall(bin: string): string {
  const lines = readFileSync(join(bin, GH_LOG), "utf8").trim().split("\n").filter(Boolean);
  return lines.at(-1) ?? "";
}

async function withPath<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${saved}`;
  try {
    return await run();
  } finally {
    process.env.PATH = saved;
  }
}

test("sessions-functions-01 scores a session snippet from the literal query", () => {
  const base = hitsFromSessionSnippets(["/tmp/s.jsonl\n  plain"], "");
  expect(base).toEqual([
    { source: "session", score: 20, title: "/tmp/s.jsonl", detail: "plain", ref: "/tmp/s.jsonl" },
  ]);

  const exact = hitsFromSessionSnippets(["/tmp/a.jsonl\n  alpha here"], "alpha");
  expect(exact[0].score).toBe(35);
  const late = hitsFromSessionSnippets([`/tmp/a.jsonl\n  ${"z".repeat(90)}alpha`], "alpha");
  expect(late[0].score).toBe(33);
  const tokenOnly = hitsFromSessionSnippets(["/tmp/a.jsonl\n  alpha only"], "alpha beta");
  expect(tokenOnly[0].score).toBe(23);
  const shortTokens = hitsFromSessionSnippets(["/tmp/a.jsonl\n  ab only"], "ab alpha");
  expect(shortTokens[0].score).toBe(20);

  const blank = hitsFromSessionSnippets([""], "");
  expect(blank[0].title).toBe("");
  expect(blank[0].detail).toBe("session");
  expect(blank[0].ref).toBe("");

  const longPath = hitsFromSessionSnippets([`${"p".repeat(200)}\n  body`], "");
  expect(longPath[0].title.length).toBe(120);
  const longDetail = hitsFromSessionSnippets(["/tmp/d.jsonl\n  " + "d".repeat(500)], "");
  expect(longDetail[0].detail.length).toBe(400);
});

test("sessions-functions-02 parses git log lines into hits with short and full shas", () => {
  expect(hitsFromGitLog("", "x")).toEqual([]);
  expect(hitsFromGitLog("git log unavailable: boom", "x")).toEqual([]);
  expect(hitsFromGitLog("(no git log hits)", "x")).toEqual([]);

  const one = hitsFromGitLog("abc1234 fix the bug", "fix");
  expect(one).toEqual([
    { source: "git", score: 30, title: "fix the bug", detail: "abc1234 fix the bug", ref: "abc1234" },
  ]);

  const longSha = hitsFromGitLog(`${"a".repeat(40)} subject`, "");
  expect(longSha[0].ref).toBe("a".repeat(40));
  expect(longSha[0].title).toBe("subject");

  const noSha = hitsFromGitLog("zzz not a sha", "");
  expect(noSha[0].ref).toBe(undefined);
  expect(noSha[0].title).toBe("zzz not a sha");
  expect(hitsFromGitLog("abc12 short", "")[0].ref).toBe(undefined);

  const multi = hitsFromGitLog("abc1234 one\n\nabc1234 two\n", "");
  expect(multi.map((hit) => hit.title)).toEqual(["one", "two"]);
});

test("sessions-functions-03 parses gh PR lines and rejects the unavailable markers", () => {
  expect(hitsFromGhPrs("", "")).toEqual([]);
  expect(hitsFromGhPrs("(gh not available — skipped PR corpus)", "")).toEqual([]);
  expect(hitsFromGhPrs("(no matching PRs)", "")).toEqual([]);
  expect(hitsFromGhPrs("gh pr list failed: boom", "")).toEqual([]);

  const row = hitsFromGhPrs("#42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42", "topic");
  expect(row).toEqual([
    {
      source: "gh",
      score: 28 + 5,
      title: "#42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42",
      detail: "#42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42",
      ref: "#42",
    },
  ]);

  const long = hitsFromGhPrs(`#7 ${"t".repeat(400)}`, "");
  expect(long[0].title.length).toBe(140);
  expect(long[0].detail.length).toBe(300);
  expect(long[0].ref).toBe("#7");

  const noHash = hitsFromGhPrs("plain line", "");
  expect(noHash[0].ref).toBe(undefined);
  expect(noHash[0].title).toBe("plain line");
});

test("sessions-functions-04 ranks by score, then source priority, then title", () => {
  const tied: RecallHit[] = [
    { source: "git", score: 20, title: "beta", detail: "" },
    { source: "gh", score: 20, title: "gamma", detail: "" },
    { source: "session", score: 20, title: "delta", detail: "" },
    { source: "session", score: 40, title: "top", detail: "" },
  ];
  expect(rankRecallHits(tied).map((hit) => hit.title)).toEqual(["top", "delta", "gamma", "beta"]);
  expect(rankRecallHits(tied, 1).length).toBe(1);
  expect(rankRecallHits(tied, 1)[0].title).toBe("top");
  expect(rankRecallHits([], 5)).toEqual([]);

  const sameSource: RecallHit[] = [
    { source: "session", score: 20, title: "zeta", detail: "" },
    { source: "session", score: 20, title: "alpha", detail: "" },
  ];
  expect(rankRecallHits(sameSource).map((hit) => hit.title)).toEqual(["alpha", "zeta"]);

  const many: RecallHit[] = Array.from({ length: 35 }, (_, index) => ({
    source: "git" as const,
    score: index,
    title: `t-${String(index).padStart(2, "0")}`,
    detail: "",
  }));
  expect(rankRecallHits(many).length).toBe(30);
  expect(rankRecallHits(many)[0].score).toBe(34);
});

test("sessions-functions-05 builds the ranked corpus with literal sections and block", () => {
  const corpus = buildRankedRecallCorpus({
    query: "topic",
    days: 7,
    sessionSnippets: ["/tmp/s.jsonl\n  topic session body"],
    gitLog: "abc1234 topic commit",
    ghPrs: "#42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42",
  });
  expect(corpus.query).toBe("topic");
  expect(corpus.hits.map((hit) => `${hit.source}:${hit.score}`)).toEqual(["session:35", "gh:33", "git:30"]);
  expect(corpus.sections).toEqual({
    sessions: "/tmp/s.jsonl\n  topic session body",
    git: "abc1234 topic commit",
    gh: "#42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42",
  });
  expect(corpus.rankedBlock).toBe([
      "1. [session score=35] /tmp/s.jsonl ⟨/tmp/s.jsonl⟩\n   topic session body",
      "2. [gh score=33] #42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42 ⟨#42⟩\n   #42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42",
      "3. [git score=30] topic commit ⟨abc1234⟩\n   abc1234 topic commit",
    ].join("\n"));

  const empty = buildRankedRecallCorpus({ query: "", days: 3, sessionSnippets: [], gitLog: "", ghPrs: "" });
  expect(empty.hits).toEqual([]);
  expect(empty.rankedBlock).toBe("(no ranked hits)");
  expect(empty.sections).toEqual({
    sessions: "(no session hits)",
    git: "(no git log hits)",
    gh: "(no gh PR hits)",
  });

  const limited = buildRankedRecallCorpus({
    query: "",
    days: 1,
    sessionSnippets: ["/a\n  x", "/b\n  y", "/c\n  z"],
    gitLog: "",
    ghPrs: "",
    limit: 2,
  });
  expect(limited.hits.map((hit) => hit.title)).toEqual(["/a", "/b"]);
});

test("sessions-functions-06 formats the recall body with four ordered sections", () => {
  const corpus = buildRankedRecallCorpus({
    query: "topic",
    days: 7,
    sessionSnippets: ["/tmp/s.jsonl\n  topic session body"],
    gitLog: "abc1234 topic commit",
    ghPrs: "#42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42",
  });
  expect(formatRankedRecallBody(corpus, 7)).toBe([
      "## Recall corpus (local, ranked)",
      "query=topic days=7",
      "",
      "### Ranked merge (sessions + git + gh)",
      corpus.rankedBlock,
      "",
      "### Pi sessions (raw)",
      "/tmp/s.jsonl\n  topic session body",
      "",
      "### git log",
      "abc1234 topic commit",
      "",
      "### gh PRs",
      "#42 [OPEN] topic pr (branch) 2026-01-01 https://example.test/42",
    ].join("\n"));

  const empty = buildRankedRecallCorpus({ query: "", days: 3, sessionSnippets: [], gitLog: "", ghPrs: "" });
  expect(formatRankedRecallBody(empty, 3).split("\n").slice(0, 2)).toEqual(["## Recall corpus (local, ranked)", "query=(none) days=3"]);
});

test("sessions-functions-07 reads a real git log in a temp repo", async () => {
  const repo = tempDir("pstack-sessions-git-");
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first commit"], {
      cwd: repo,
    });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "second commit"], {
      cwd: repo,
    });

    const all = await recallGitLog(repo, "", 20);
    expect(all.includes("first commit")).toBe(true);
    expect(all.includes("second commit")).toBe(true);

    const filtered = await recallGitLog(repo, "first", 20);
    expect(filtered.includes("first commit")).toBe(true);
    expect(filtered.includes("second commit")).toBe(false);

    expect((await recallGitLog(repo, "", 1)).split("\n").length).toBe(1);
    expect((await recallGitLog(repo, "", 0)).split("\n").length).toBe(1);
    expect(await recallGitLog(join(repo, "missing"), "", 20)).toMatch(/^git log unavailable: /);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("sessions-functions-08 shapes gh PR output from a faked gh on PATH", async () => {
  const bin = tempDir("pstack-sessions-gh-");
  const cwd = tempDir("pstack-sessions-ghcwd-");
  try {
    installFakeGh(bin, { versionCode: 127 });
    expect(await withPath(bin, () => recallGhPrs(cwd, "topic"))).toBe("(gh not available — skipped PR corpus)");

    installFakeGh(bin, { stdout: "[]" });
    expect(await withPath(bin, () => recallGhPrs(cwd, "topic"))).toBe("(no matching PRs)");

    const row = {
      number: 42,
      title: "topic pr",
      state: "OPEN",
      updatedAt: "2026-01-01T00:00:00Z",
      url: "https://example.test/42",
      headRefName: "branch",
    };
    installFakeGh(bin, { stdout: JSON.stringify([row]) });
    expect(await withPath(bin, () => recallGhPrs(cwd, "topic"))).toBe("#42 [OPEN] topic pr (branch) 2026-01-01T00:00:00Z https://example.test/42");
    expect(lastGhCall(bin)).toBe("pr list --limit 10 --search topic --json number,title,state,updatedAt,url,headRefName");

    expect(lastGhCall(bin).includes("--limit 10")).toBe(true);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("sessions-functions-09 defaults the gh search and clamps its limit", async () => {
  const bin = tempDir("pstack-sessions-gh-");
  const cwd = tempDir("pstack-sessions-ghcwd-");
  try {
    installFakeGh(bin, { stdout: "[]" });
    await withPath(bin, () => recallGhPrs(cwd, "   ", 500));
    expect(lastGhCall(bin)).toBe("pr list --limit 50 --search sort:updated-desc --json number,title,state,updatedAt,url,headRefName");

    await withPath(bin, () => recallGhPrs(cwd, "topic", 0));
    expect(lastGhCall(bin).includes("--limit 1")).toBe(true);

    installFakeGh(bin, { stdout: "", stderr: "boom" });
    expect(await withPath(bin, () => recallGhPrs(cwd, "topic"))).toBe("boom");

    installFakeGh(bin, { stdout: "not json" });
    expect((await withPath(bin, () => recallGhPrs(cwd, "topic"))).startsWith("gh pr list failed: ")).toBe(true);
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("sessions-functions-10 recalls an empty query over the fallback session lines", async () => {
  await withSandbox(async (sandbox, tool) => {
    const path = writeSessionFile(sandbox.sessionDir, "empty-query.jsonl", "body without the marker\n");
    expect(path.endsWith("empty-query.jsonl")).toBe(true);
    installFakeGh(sandbox.bin, { versionCode: 127 });

    const result = await callTool(tool, { action: "recall", limit: 5, days: 30 }, sandbox.cwd);
    const body = result.content[0].text;
    expect(result.details.sessionHits).toBe(1);
    expect(result.details.rankedHits).toBe(1);
    expect(result.details.corpus).toEqual(["sessions", "git-log", "gh-prs", "ranked-merge"]);
    const top = result.details.top as Array<{ source: string; score: number; title: string }>;
    expect(top[0].source).toBe("session");
    expect(top[0].score).toBe(20);
    expect(top[0].title).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}/);
    expect(top[0].title.includes(sandbox.sessionDir)).toBe(true);
    expect(body.startsWith("## Recall corpus (local, ranked)\nquery=(none) days=30\n")).toBe(true);
    expect(body).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z {2}.*empty-query\.jsonl/);
    expect(body).toMatch(/### git log\ngit log unavailable: /);
    expect(body.includes("(gh not available — skipped PR corpus)")).toBe(true);
  });
});

test("sessions-functions-11 recalls a query and reports a null gh finding", async () => {
  await withSandbox(async (sandbox, tool) => {
    const path = writeSessionFile(sandbox.sessionDir, "query.jsonl", "querymarker body\n");
    installFakeGh(sandbox.bin, { stdout: "[]" });

    const result = await callTool(tool, { action: "recall", query: "querymarker", days: 30 }, sandbox.cwd);
    const body = result.content[0].text;
    expect(result.details.sessionHits).toBe(1);
    expect(result.details.rankedHits).toBe(1);
    const top = result.details.top as Array<{ source: string; title: string }>;
    expect(top[0].source).toBe("session");
    expect(top[0].title).toBe(path);
    expect(body.includes("(no matching PRs)")).toBe(true);
    expect(body).toMatch(/### git log\ngit log unavailable: /);
  });
});

test("sessions-functions-12 lists, greps, and resolves the current session file", async () => {
  await withSandbox(async (sandbox, tool) => {
    const older = writeSessionFile(sandbox.sessionDir, "older.jsonl", "{}\n", { mtimeMs: Date.now() - 60000 });
    const newer = writeSessionFile(sandbox.sessionDir, "newer.jsonl", "grepmarker line\n");

    const listed = await callTool(tool, { action: "list", limit: 5 }, sandbox.cwd);
    expect((listed.details.files as Array<{ path: string }>).map((file) => file.path)).toEqual([newer, older]);
    expect(listed.content[0].text.split("\n").length).toBe(2);

    const noise = writeSessionFile(sandbox.sessionDir, "noise.jsonl", "nothing here\n");
    const grepped = await callTool(tool, { action: "grep", query: "grepmarker" }, sandbox.cwd);
    expect(grepped.details.hitCount).toBe(1);
    expect(grepped.content[0].text).toBe(`${newer}\n  grepmarker line`);
    expect(grepped.content[0].text.includes(noise)).toBe(false);

    await expect(() => callTool(tool, { action: "grep" }, sandbox.cwd)).rejects.toThrow(/query required for grep/);
    await expect(() => callTool(tool, { action: "summarize" }, sandbox.cwd)).rejects.toThrow(/action must be list\|grep\|current\|recall/);

    expect((await callTool(tool, { action: "current" }, sandbox.cwd)).details.file).toBe("(unknown)");
    process.env.PI_SESSION_FILE = "/tmp/env-session.jsonl";
    expect((await callTool(tool, { action: "current" }, sandbox.cwd)).details.file).toBe("/tmp/env-session.jsonl");
    const fromManager = await callTool(tool, { action: "current" }, sandbox.cwd, {
      getSessionFile: () => "/tmp/manager-session.jsonl",
    });
    expect(fromManager.details.file).toBe("/tmp/manager-session.jsonl");
    expect(fromManager.content[0].text).toBe("current session: /tmp/manager-session.jsonl");
  });
});

test("sessions-functions-13 reports empty results and the no-hit grep message", async () => {
  await withSandbox(async (sandbox, tool) => {
    const listed = await callTool(tool, { action: "list" }, sandbox.cwd);
    expect(listed.content[0].text).toBe("(no sessions found in known Pi dirs)");
    expect(listed.details.files).toEqual([]);

    writeSessionFile(sandbox.sessionDir, "notarget.jsonl", "unrelated\n");
    const grepped = await callTool(tool, { action: "grep", query: "absentmarker" }, sandbox.cwd);
    expect(grepped.details.hitCount).toBe(0);
    expect(grepped.content[0].text).toBe("(no hits for absentmarker)");
  });
});
