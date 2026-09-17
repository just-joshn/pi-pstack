import { expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { processExec } from "../../support/pi-host.mjs";

const SESSION_REL = ".pi/sessions/recall-kumquat.jsonl";
const SESSION_BODY = '{"type": "user", "text": "kumquat marker session"}\n';
const GIT_MARKER = "kumquat marker commit";
const GH_UPDATED = "2025-01-02T03:04:05Z";
const GH_URL = "https://example.invalid/pull/42";
const PR_TITLE = "kumquat PR title";
const PR_ROW = `#42 [OPEN] ${PR_TITLE} (kumquat-branch) ${GH_UPDATED} ${GH_URL}`;
const GH_FIXTURES = {
  "--version": { code: 0, stdout: "gh version 2.0.0\n", stderr: "" },
  "pr list": {
    code: 0,
    stdout: `${JSON.stringify([
      {
        number: 42,
        title: PR_TITLE,
        state: "OPEN",
        updatedAt: GH_UPDATED,
        url: GH_URL,
        headRefName: "kumquat-branch",
      },
    ])}\n`,
    stderr: "",
  },
};

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SETUP_SKILL = join(PACKAGE_ROOT, "automations/benny/skills/setup-benny/SKILL.md");
const TRIAGE_SKILL = join(PACKAGE_ROOT, "automations/benny/skills/triage-issue-reports/SKILL.md");
const REPRO_SKILL = join(PACKAGE_ROOT, "automations/benny/skills/reproduce-and-fix-issues/SKILL.md");
const SETUP_BODY = `Read and follow ${SETUP_SKILL}. Retarget paths to .pi/automations/benny and .pi/benny. Do not use Cursor Automations host APIs.`;
const TRIAGE_BODY = `Read and follow ${TRIAGE_SKILL}.`;
const REPRO_BODY = `Read and follow ${REPRO_SKILL}. Use pstack_control_cli / pstack_control_ui for the control adapter.`;

function textOf(result) {
  return result.content[0].text;
}

function wakePath() {
  return resolve(process.env.HOME ?? "", ".pi/agent/pstack-benny-wakes.jsonl");
}

function wakeLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function rankedSources(text) {
  return [...text.matchAll(/^\d+\. \[(\w+) score=\d+\] /gm)].map((match) => match[1]);
}

async function assertEmptySessionList(user) {
  const listed = await user.tool("pstack_sessions", { action: "list" });
  expect(textOf(listed)).toBe("(no sessions found in known Pi dirs)");
  expect(listed.details.files).toEqual([]);
}

async function assertSessionRefusals(user) {
  await expect(user.tool("pstack_sessions", { action: "grep" })).rejects.toThrow("query required for grep");
  await expect(user.tool("pstack_sessions", { action: "bogus" })).rejects.toThrow("action must be list|grep|current|recall");
}

async function assertCurrentSession(user) {
  const file = user.path(".pi/agent/injected-session.jsonl");
  user.setSessionFile(file);
  const current = await user.tool("pstack_sessions", { action: "current" });
  expect(textOf(current)).toBe(`current session: ${file}`);
  expect(current.details).toEqual({ file });
}

async function seedHistory(user) {
  user.git(["init"]);
  user.git(["commit", "--allow-empty", "-m", GIT_MARKER]);
  user.write(SESSION_REL, SESSION_BODY);
}

async function assertSeededList(user) {
  const path = user.path(SESSION_REL);
  const stat = statSync(path);
  const listed = await user.tool("pstack_sessions", { action: "list" });
  expect(textOf(listed)).toBe(`${new Date(stat.mtimeMs).toISOString()}  ${stat.size}B  ${path}`);
  expect(listed.details.files.length).toBe(1);
  expect(listed.details.files[0].path).toBe(path);
  expect(listed.details.files[0].bytes).toBe(stat.size);
}

async function assertGrep(user) {
  const path = user.path(SESSION_REL);
  const hit = await user.tool("pstack_sessions", { action: "grep", query: "KUMQUAT" });
  expect(hit.details.hitCount).toBe(1);
  expect(textOf(hit).startsWith(`${path}\n  `)).toBe(true);
  expect(textOf(hit).includes("kumquat marker session")).toBe(true);
  const none = await user.tool("pstack_sessions", { action: "grep", query: "durian" });
  expect(textOf(none)).toBe("(no hits for durian)");
  expect(none.details.hitCount).toBe(0);
}

async function assertDegradedRecall(user) {
  user.installFakeGh();
  const recall = await user.tool("pstack_sessions", { action: "recall", query: "kumquat" });
  const text = textOf(recall);
  expect(text.split("\n")[0]).toBe("## Recall corpus (local, ranked)");
  expect(text.split("\n")[1]).toBe("query=kumquat days=7");
  expect(text.endsWith("### gh PRs\n(gh not available — skipped PR corpus)")).toBe(true);
  expect(recall.details.corpus).toEqual(["sessions", "git-log", "gh-prs", "ranked-merge"]);
  expect(recall.details.rankedHits).toBe(2);
  expect(rankedSources(text)).toEqual(["session", "git"]);
}

async function assertRankedRecall(user) {
  user.installFakeGh(GH_FIXTURES);
  const recall = await user.tool("pstack_sessions", { action: "recall", query: "kumquat", limit: 5 });
  const text = textOf(recall);
  expect(text.includes("### git log\n")).toBe(true);
  expect(text.includes(GIT_MARKER)).toBe(true);
  expect(text.endsWith(`### gh PRs\n${PR_ROW}`)).toBe(true);
  expect(recall.details.corpus).toEqual(["sessions", "git-log", "gh-prs", "ranked-merge"]);
  expect(recall.details.rankedHits).toBe(3);
  expect(recall.details.sessionHits).toBe(1);
  expect(rankedSources(text)).toEqual(["session", "gh", "git"]);
  expect(recall.details.top.map((entry) => entry.source)).toEqual(["session", "gh", "git"]);
}

const J14 = {
  id: "recall-knowledge",
  title: "a user recalls prior work from sessions, git history, and PRs",
  critical: true,
  surfaces: ["sessions"],
  async run(user) {
    await assertEmptySessionList(user);
    await assertSessionRefusals(user);
    await assertCurrentSession(user);
    await seedHistory(user);
    await assertSeededList(user);
    await assertGrep(user);
    await assertDegradedRecall(user);
    await assertRankedRecall(user);
  },
};

function installRealGitList(user) {
  user.setExec((command, args) => {
    if (command !== "git" || args.join(" ") !== "worktree list --porcelain") {
      return { code: 0, stdout: "", stderr: "", killed: false };
    }
    return processExec(command, args);
  });
}

async function assertCreateProbe(user) {
  const created = await user.tool("pstack_worktree", { action: "create", name: "probe" });
  const path = user.path(".pstack-worktrees/probe");
  expect(textOf(created)).toBe(`Created worktree ${path} on pstack/probe`);
  expect(created.details).toEqual({ path, branch: "pstack/probe" });
  expect(user.exists(".pstack-worktrees/probe")).toBe(true);
  return path;
}

async function assertWorktreeList(user) {
  const listed = await user.tool("pstack_worktree", { action: "list" });
  const text = textOf(listed);
  expect(text.endsWith("\n\npstack-managed under .pstack-worktrees: 1/12")).toBe(true);
  expect(text).toMatch(/worktree \S*\/\.pstack-worktrees\/probe\n/);
  expect(text.includes("branch refs/heads/pstack/probe")).toBe(true);
  expect(listed.details).toEqual({ code: 0, count: 1 });
  expect(user.execCalls().at(-1)).toEqual({ command: "git", args: ["worktree", "list", "--porcelain"] });
}

async function assertRemoveProbe(user, path) {
  const removed = await user.tool("pstack_worktree", { action: "remove", name: "probe" });
  expect(textOf(removed)).toBe(`Removed worktree ${path}`);
  expect(removed.details).toEqual({ path });
  expect(user.exists(".pstack-worktrees/probe")).toBe(false);
}

async function assertDefaultSlug(user) {
  const created = await user.tool("pstack_worktree", { action: "create" });
  const match = /^Created worktree (.+) on pstack\/(pstack-\d+)$/.exec(textOf(created));
  expect(match !== null, `unexpected create text: ${textOf(created)}`).toBeTruthy();
  const path = match[1];
  const slug = match[2];
  expect(path).toBe(user.path(`.pstack-worktrees/${slug}`));
  expect(created.details).toEqual({ path, branch: `pstack/${slug}` });
  expect(user.exists(`.pstack-worktrees/${slug}`)).toBe(true);
  return slug;
}

async function assertNameRefusals(user) {
  const refusals = [
    ["-x", "worktree name must not start with '-'"],
    ["../x", "worktree name must not contain '..', path separators, or NUL"],
    ["a/b", "worktree name must not contain '..', path separators, or NUL"],
  ];
  for (const [name, message] of refusals) {
    await expect(user.tool("pstack_worktree", { action: "create", name })).rejects.toThrow(message);
  }
}

async function assertActionRefusals(user) {
  await expect(user.tool("pstack_worktree", { action: "remove" })).rejects.toThrow("name required for remove");
  await expect(user.tool("pstack_worktree", { action: "bogus" })).rejects.toThrow("action must be create|list|remove|prune|cleanup");
}

async function assertPrune(user) {
  const pruned = await user.tool("pstack_worktree", { action: "prune" });
  expect(textOf(pruned)).toBe("pruned");
}

async function assertCleanup(user, slug) {
  const cleaned = await user.tool("pstack_worktree", { action: "cleanup" });
  expect(textOf(cleaned)).toBe(`cleanup removed=[${slug}] skipped=0 prune=pruned`);
  expect(cleaned.details.removed).toEqual([slug]);
  expect(cleaned.details.skipped).toEqual([]);
  expect(user.exists(`.pstack-worktrees/${slug}`)).toBe(false);
}

const J15 = {
  id: "isolate-and-clean-worktrees",
  title: "a user isolates work in a worktree and cleans it back up",
  critical: true,
  surfaces: ["worktree"],
  async run(user) {
    user.git(["init"]);
    user.git(["commit", "--allow-empty", "-m", "worktree marker commit"]);
    const probe = await assertCreateProbe(user);
    installRealGitList(user);
    await assertWorktreeList(user);
    await assertRemoveProbe(user, probe);
    const slug = await assertDefaultSlug(user);
    await assertNameRefusals(user);
    await assertActionRefusals(user);
    await assertPrune(user);
    await assertCleanup(user, slug);
  },
};

async function assertWakePath(user, wakeFile) {
  const result = await user.tool("pstack_benny_wake", { action: "path" });
  expect(textOf(result)).toBe(wakeFile);
  expect(result.details).toEqual({ path: wakeFile });
  expect(existsSync(wakeFile)).toBe(true);
}

async function assertWakeAppend(user, wakeFile) {
  const payload = { issue: 42, title: "kumquat crash" };
  const appended = await user.tool("pstack_benny_wake", {
    action: "append",
    payload: JSON.stringify(payload),
    intent: "repro",
  });
  expect(textOf(appended)).toBe(`Appended wake to ${wakeFile}`);
  expect(appended.details).toEqual({ ok: true, path: wakeFile });
  const first = JSON.parse(wakeLines(wakeFile)[0]);
  expect(new Date(first.ts).toISOString()).toBe(first.ts);
  expect(first.intent).toBe("repro");
  expect(first.payload).toEqual(payload);

  await user.tool("pstack_benny_wake", { action: "append", payload: "not json at all" });
  const second = JSON.parse(wakeLines(wakeFile)[1]);
  expect(second.intent).toBe("triage");
  expect(second.payload).toBe("not json at all");
}

async function assertWakeRefusal(user, wakeFile) {
  await expect(() => user.tool("pstack_benny_wake", { action: "append" })).rejects.toThrow(/pstack_benny_wake append requires a non-empty payload JSON string/);
  await expect(() => user.tool("pstack_benny_wake", { action: "append", payload: "   " })).rejects.toThrow(/pstack_benny_wake append requires a non-empty payload JSON string/);
  expect(wakeLines(wakeFile).length).toBe(2);
}

async function assertWakeDrain(user, wakeFile) {
  const lines = wakeLines(wakeFile);
  expect(lines.length).toBe(2);
  const drained = await user.tool("pstack_benny_wake", { action: "drain" });
  expect(textOf(drained)).toBe(`Drained 2 wake(s):\n${lines.join("\n")}`);
  expect(drained.details).toEqual({ count: 2, path: wakeFile });
  expect(readFileSync(wakeFile, "utf8")).toBe("");
  const empty = await user.tool("pstack_benny_wake", { action: "drain" });
  expect(textOf(empty)).toBe("No pending Benny wakes.");
  expect(empty.details).toEqual({ count: 0, path: wakeFile });
  expect(wakeLines(wakeFile).length).toBe(0);
}

async function assertBennyCommands(user) {
  expect(existsSync(SETUP_SKILL)).toBe(true);
  await user.command("setup-benny", "");
  expect(user.message()).toBe(SETUP_BODY);
  expect(user.messages().at(-1).options).toEqual({ expandPromptTemplates: false, deliverAs: "followUp" });

  await user.command("benny-triage", "slack payload");
  expect(user.message()).toBe(`${TRIAGE_BODY} Context: slack payload`);
  await user.command("benny-triage", "");
  expect(user.message()).toBe(`${TRIAGE_BODY} Await the next Slack/tracker issue payload from pstack_benny_wake or chat.`);

  await user.command("benny-repro", "issue 42");
  expect(user.message()).toBe(`${REPRO_BODY} Issue: issue 42`);
  await user.command("benny-repro", "");
  expect(user.message()).toBe([REPRO_BODY, ""].join(" "));
}

const J16 = {
  id: "wake-benny",
  title: "a user queues and drains a Benny wake and opens the Benny skills",
  critical: true,
  surfaces: ["benny", "commands"],
  async run(user) {
    const wakeFile = wakePath();
    await assertWakePath(user, wakeFile);
    await assertWakeAppend(user, wakeFile);
    await assertWakeRefusal(user, wakeFile);
    await assertWakeDrain(user, wakeFile);
    await assertBennyCommands(user);
  },
};

export const JOURNEYS = [J14, J15, J16];
