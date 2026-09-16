import { expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallGhPrs, recallGitLog } from "../../../extensions/sessions/recall-corpus.ts";
import { hitsFromGitLog } from "../../../extensions/sessions/recall-rank.ts";
import { withBudget } from "../../../extensions/models/budget.ts";
import { registerDecisionLog } from "../../../extensions/decision-log/index.ts";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withPath(path, run) {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try {
    return await run();
  } finally {
    process.env.PATH = previous;
  }
}

function writeGh(dir, body) {
  const path = join(dir, "gh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function decisionHost(cwd) {
  const tools = new Map();
  let entries = [];
  const pi = {
    registerTool: (definition) => tools.set(definition.name, definition),
    appendEntry: (type, data) => {
      entries = [...entries, { type, data }];
    },
  };
  registerDecisionLog(pi);
  return { tool: tools.get("pstack_decision_log"), ctx: { cwd }, entries: () => entries };
}

test("recall git corpus fails soft outside a repository", async () => {
  const dir = tempDir("pstack-recall-git-");
  try {
    const text = await recallGitLog(dir, "anything");
    expect(text.startsWith("git log unavailable:"), `expected the git failure line, saw: ${text}`).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall gh corpus renders the parsed pr rows", async () => {
  const dir = tempDir("pstack-recall-gh-");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeGh(
    bin,
    [
      'if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; exit 0; fi',
      'echo \'[{"number":12,"state":"MERGED","title":"fix the thing","updatedAt":"2026-01-02T03:04:05Z","url":"https://example.test/pr/12","headRefName":"fix/thing"}]\'',
    ].join("\n"),
  );
  try {
    const text = await withPath(bin, () => recallGhPrs(dir, "topic"));
    expect(text).toBe("#12 [MERGED] fix the thing (fix/thing) 2026-01-02T03:04:05Z https://example.test/pr/12");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall gh corpus fails soft when the pr query fails", async () => {
  const dir = tempDir("pstack-recall-ghfail-");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeGh(
    bin,
    ['if [ "$1" = "--version" ]; then echo "gh version 2.60.0"; exit 0; fi', 'echo "not logged in" >&2', "exit 1"].join("\n"),
  );
  try {
    const text = await withPath(bin, () => recallGhPrs(dir, "topic"));
    expect(text.startsWith("gh pr list failed:"), `expected the gh failure line, saw: ${text}`).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall ranking treats unavailable corpora as empty", () => {
  expect(hitsFromGitLog("git log unavailable: boom", "anything")).toEqual([]);
  expect(hitsFromGitLog("(no git log hits)", "anything")).toEqual([]);
});

test("an explicit colon effort wins over the budget and an empty selector stays empty", () => {
  expect(withBudget("anthropic/claude-opus-4-5:high", "small — medium reasoning")).toBe("anthropic/claude-opus-4-5:high");
  expect(withBudget("", "small — medium reasoning")).toBe("");
});

test("decision log rejects the .pi directory itself", async () => {
  const dir = tempDir("pstack-log-dir-");
  try {
    const host = decisionHost(dir);
    await expect(() =>
        host.tool.execute(
          "d",
          { phase: "coverage", decision: "reject", why: "the allowlist must exclude the directory", path: ".pi" },
          undefined,
          undefined,
          host.ctx,
        )).rejects.toThrow(/must stay under/);
    expect(host.entries().length, "a rejected call must not append a session entry").toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision log prepends the header when the file lacks one", async () => {
  const dir = tempDir("pstack-log-header-");
  try {
    const path = join(dir, ".pi", "decisions.tsv");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(path, "garbage from an older tool\n");
    const host = decisionHost(dir);
    await host.tool.execute(
      "d",
      { phase: "coverage", decision: "prepend", why: "an existing headerless file must gain the schema" },
      undefined,
      undefined,
      host.ctx,
    );
    const text = readFileSync(path, "utf8");
    expect(text.startsWith(HEADER + "garbage from an older tool\n"), "the old content must survive under a fresh header").toBeTruthy();
    expect(text.endsWith("\n"), "the appended row must end with a newline").toBeTruthy();
    expect(host.entries().length).toBe(1);
    expect(host.entries()[0].data.phase).toBe("coverage");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
