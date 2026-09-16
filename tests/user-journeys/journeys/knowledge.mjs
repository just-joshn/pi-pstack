/**
 * J14-J16 knowledge journeys. Owned by W5.
 *
 * Recall corpus (sessions + real git log + gh PRs, degraded and populated), worktree isolation
 * against a real temporary repo, and the Benny wake file plus its slash commands. J14 and J15
 * deliberately run real git: neither journey installs a fake git on PATH.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** HOME is process-level and resolved by the extension at import time, so read it per journey. */
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
  assert.equal(textOf(listed), "(no sessions found in known Pi dirs)");
  assert.deepEqual(listed.details.files, []);
}

async function assertSessionRefusals(user) {
  await assert.rejects(user.tool("pstack_sessions", { action: "grep" }), { message: "query required for grep" });
  await assert.rejects(user.tool("pstack_sessions", { action: "bogus" }), {
    message: "action must be list|grep|current|recall",
  });
}

async function assertCurrentSession(user) {
  const file = user.path(".pi/agent/injected-session.jsonl");
  user.setSessionFile(file);
  const current = await user.tool("pstack_sessions", { action: "current" });
  assert.equal(textOf(current), `current session: ${file}`);
  assert.deepEqual(current.details, { file });
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
  assert.equal(textOf(listed), `${new Date(stat.mtimeMs).toISOString()}  ${stat.size}B  ${path}`);
  assert.equal(listed.details.files.length, 1);
  assert.equal(listed.details.files[0].path, path);
  assert.equal(listed.details.files[0].bytes, stat.size);
}

async function assertGrep(user) {
  const path = user.path(SESSION_REL);
  const hit = await user.tool("pstack_sessions", { action: "grep", query: "KUMQUAT" });
  assert.equal(hit.details.hitCount, 1);
  assert.equal(textOf(hit).startsWith(`${path}\n  `), true);
  assert.equal(textOf(hit).includes("kumquat marker session"), true);
  const none = await user.tool("pstack_sessions", { action: "grep", query: "durian" });
  assert.equal(textOf(none), "(no hits for durian)");
  assert.equal(none.details.hitCount, 0);
}

async function assertDegradedRecall(user) {
  user.installFakeGh();
  const recall = await user.tool("pstack_sessions", { action: "recall", query: "kumquat" });
  const text = textOf(recall);
  assert.equal(text.split("\n")[0], "## Recall corpus (local, ranked)");
  assert.equal(text.split("\n")[1], "query=kumquat days=7");
  assert.equal(text.endsWith("### gh PRs\n(gh not available — skipped PR corpus)"), true);
  assert.deepEqual(recall.details.corpus, ["sessions", "git-log", "gh-prs", "ranked-merge"]);
  assert.equal(recall.details.rankedHits, 2);
  assert.deepEqual(rankedSources(text), ["session", "git"]);
}

async function assertRankedRecall(user) {
  user.installFakeGh(GH_FIXTURES);
  const recall = await user.tool("pstack_sessions", { action: "recall", query: "kumquat", limit: 5 });
  const text = textOf(recall);
  assert.equal(text.includes("### git log\n"), true);
  assert.equal(text.includes(GIT_MARKER), true);
  assert.equal(text.endsWith(`### gh PRs\n${PR_ROW}`), true);
  assert.deepEqual(recall.details.corpus, ["sessions", "git-log", "gh-prs", "ranked-merge"]);
  assert.equal(recall.details.rankedHits, 3);
  assert.equal(recall.details.sessionHits, 1);
  assert.deepEqual(rankedSources(text), ["session", "gh", "git"]);
  assert.deepEqual(
    recall.details.top.map((entry) => entry.source),
    ["session", "gh", "git"],
  );
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

/** `list` goes through pi.exec; the default host exec is canned, so shell out to real git. */
function installRealGitList(user) {
  user.setExec((command, args) => {
    if (command !== "git" || args.join(" ") !== "worktree list --porcelain") {
      return { code: 0, stdout: "", stderr: "", killed: false };
    }
    const run = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
    return { code: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "", killed: false };
  });
}

async function assertCreateProbe(user) {
  const created = await user.tool("pstack_worktree", { action: "create", name: "probe" });
  const path = user.path(".pstack-worktrees/probe");
  assert.equal(textOf(created), `Created worktree ${path} on pstack/probe`);
  assert.deepEqual(created.details, { path, branch: "pstack/probe" });
  assert.equal(user.exists(".pstack-worktrees/probe"), true);
  return path;
}

async function assertWorktreeList(user) {
  const listed = await user.tool("pstack_worktree", { action: "list" });
  const text = textOf(listed);
  assert.equal(text.endsWith("\n\npstack-managed under .pstack-worktrees: 1/12"), true);
  assert.match(text, /worktree \S*\/\.pstack-worktrees\/probe\n/);
  assert.equal(text.includes("branch refs/heads/pstack/probe"), true);
  assert.deepEqual(listed.details, { code: 0, count: 1 });
  assert.deepEqual(user.execCalls().at(-1), { command: "git", args: ["worktree", "list", "--porcelain"] });
}

async function assertRemoveProbe(user, path) {
  const removed = await user.tool("pstack_worktree", { action: "remove", name: "probe" });
  assert.equal(textOf(removed), `Removed worktree ${path}`);
  assert.deepEqual(removed.details, { path });
  assert.equal(user.exists(".pstack-worktrees/probe"), false);
}

async function assertDefaultSlug(user) {
  const created = await user.tool("pstack_worktree", { action: "create" });
  const match = /^Created worktree (.+) on pstack\/(pstack-\d+)$/.exec(textOf(created));
  assert.ok(match !== null, `unexpected create text: ${textOf(created)}`);
  const path = match[1];
  const slug = match[2];
  assert.equal(path, user.path(`.pstack-worktrees/${slug}`));
  assert.deepEqual(created.details, { path, branch: `pstack/${slug}` });
  assert.equal(user.exists(`.pstack-worktrees/${slug}`), true);
  return slug;
}

async function assertNameRefusals(user) {
  const refusals = [
    ["-x", "worktree name must not start with '-'"],
    ["../x", "worktree name must not contain '..', path separators, or NUL"],
    ["a/b", "worktree name must not contain '..', path separators, or NUL"],
  ];
  for (const [name, message] of refusals) {
    await assert.rejects(user.tool("pstack_worktree", { action: "create", name }), { message });
  }
}

async function assertActionRefusals(user) {
  await assert.rejects(user.tool("pstack_worktree", { action: "remove" }), { message: "name required for remove" });
  await assert.rejects(user.tool("pstack_worktree", { action: "bogus" }), {
    message: "action must be create|list|remove|prune|cleanup",
  });
}

async function assertPrune(user) {
  const pruned = await user.tool("pstack_worktree", { action: "prune" });
  assert.equal(textOf(pruned), "pruned");
}

async function assertCleanup(user, slug) {
  const cleaned = await user.tool("pstack_worktree", { action: "cleanup" });
  assert.equal(textOf(cleaned), `cleanup removed=[${slug}] skipped=0 prune=pruned`);
  assert.deepEqual(cleaned.details.removed, [slug]);
  assert.deepEqual(cleaned.details.skipped, []);
  assert.equal(user.exists(`.pstack-worktrees/${slug}`), false);
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
  assert.equal(textOf(result), wakeFile);
  assert.deepEqual(result.details, { path: wakeFile });
  assert.equal(existsSync(wakeFile), true);
}

async function assertWakeAppend(user, wakeFile) {
  const payload = { issue: 42, title: "kumquat crash" };
  const appended = await user.tool("pstack_benny_wake", {
    action: "append",
    payload: JSON.stringify(payload),
    intent: "repro",
  });
  assert.equal(textOf(appended), `Appended wake to ${wakeFile}`);
  assert.deepEqual(appended.details, { ok: true, path: wakeFile });
  const first = JSON.parse(wakeLines(wakeFile)[0]);
  assert.equal(new Date(first.ts).toISOString(), first.ts);
  assert.equal(first.intent, "repro");
  assert.deepEqual(first.payload, payload);

  await user.tool("pstack_benny_wake", { action: "append", payload: "not json at all" });
  const second = JSON.parse(wakeLines(wakeFile)[1]);
  assert.equal(second.intent, "triage");
  assert.equal(second.payload, "not json at all");
}

async function assertWakeRefusal(user, wakeFile) {
  const refused = await user.tool("pstack_benny_wake", { action: "append" });
  assert.equal(textOf(refused), "pstack_benny_wake append requires payload JSON");
  assert.deepEqual(refused.details, { ok: false });
  const blank = await user.tool("pstack_benny_wake", { action: "append", payload: "   " });
  assert.equal(textOf(blank), "pstack_benny_wake append requires payload JSON");
  assert.equal(wakeLines(wakeFile).length, 2);
}

async function assertWakeDrain(user, wakeFile) {
  const lines = wakeLines(wakeFile);
  assert.equal(lines.length, 2);
  const drained = await user.tool("pstack_benny_wake", { action: "drain" });
  assert.equal(textOf(drained), `Drained 2 wake(s):\n${lines.join("\n")}`);
  assert.deepEqual(drained.details, { count: 2, path: wakeFile });
  assert.equal(readFileSync(wakeFile, "utf8"), "");
  const empty = await user.tool("pstack_benny_wake", { action: "drain" });
  assert.equal(textOf(empty), "No pending Benny wakes.");
  assert.deepEqual(empty.details, { count: 0, path: wakeFile });
  assert.equal(wakeLines(wakeFile).length, 0);
}

async function assertBennyCommands(user) {
  assert.equal(existsSync(SETUP_SKILL), true);
  await user.command("setup-benny", "");
  assert.equal(user.message(), SETUP_BODY);
  assert.deepEqual(user.messages().at(-1).options, { expandPromptTemplates: false });

  await user.command("benny-triage", "slack payload");
  assert.equal(user.message(), `${TRIAGE_BODY} Context: slack payload`);
  await user.command("benny-triage", "");
  assert.equal(
    user.message(),
    `${TRIAGE_BODY} Await the next Slack/tracker issue payload from pstack_benny_wake or chat.`,
  );

  await user.command("benny-repro", "issue 42");
  assert.equal(user.message(), `${REPRO_BODY} Issue: issue 42`);
  await user.command("benny-repro", "");
  assert.equal(user.message(), [REPRO_BODY, ""].join(" "));
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
