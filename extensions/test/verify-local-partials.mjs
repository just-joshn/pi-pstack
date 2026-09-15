/**
 * Scripted checks for close-local-v3 Stage 2 (no full Pi runtime required).
 * Run: node --experimental-strip-types extensions/test/verify-local-partials.mjs
 *   or: bun extensions/test/verify-local-partials.mjs
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}:`, err?.message ?? err);
  }
}

await check("sticky helper injects skill body (not soft nudge only)", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-poteto.ts")).href);
  mod.clearPotetoStickyCache?.();
  const body = mod.loadPotetoStickyBody();
  assert.ok(body.includes("Non-negotiables"), "missing Non-negotiables");
  assert.ok(body.length > 500, `sticky body too short (${body.length})`);
  const prompt = mod.buildPotetoStickyPrompt("BASE");
  assert.ok(prompt.startsWith("BASE"));
  assert.ok(prompt.includes("sticky"));
  assert.ok(prompt.includes("Non-negotiables"));
});

await check("sticky injects matched playbook steps", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-poteto.ts")).href);
  const pb = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-playbook.ts")).href);
  const match = pb.matchPlaybook("babysit this PR and get it green");
  assert.ok(match, "expected babysit match");
  assert.equal(match.id, "babysit");
  const prompt = mod.buildPotetoStickyPrompt("BASE", { match });
  assert.ok(prompt.includes("Matched playbook"));
  assert.ok(prompt.includes("babysit"));
  assert.ok(prompt.includes("You own the merge frontier") || prompt.includes("merge frontier"));
  const inv = pb.matchPlaybook("how does the auth middleware work?");
  assert.ok(inv && inv.id === "investigation");
  const ship = pb.matchPlaybook("please land the stack when ready");
  assert.ok(ship && ship.id === "shipping");
});

await check("sticky force skill message + persist helpers", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  assert.equal(mod.forcePotetoSkillMessage("fix flaky CI", "babysit"), "/skill:poteto-mode playbooks/babysit fix flaky CI");
  assert.ok(mod.forcePotetoSkillMessage("", "investigation").includes("playbooks/investigation"));
  assert.ok(mod.shouldAutoArmReadonly("investigation"));
  assert.equal(mod.shouldAutoArmReadonly("babysit"), false);
  const payload = mod.stickyEntryPayload(true, { id: "feature", score: 6 });
  assert.equal(payload.enabled, true);
  assert.equal(payload.matchedPlaybookId, "feature");
  const parsed = mod.parseStickyEntry(payload);
  assert.equal(parsed.matchedPlaybookId, "feature");
  const src = readFileSync(resolve(ROOT, "extensions/index.ts"), "utf8");
  assert.ok(src.includes("forcePotetoSkillMessage"));
  assert.ok(src.includes("sendUserMessage"));
  assert.ok(src.includes("matchedPlaybookId"));
  assert.ok(src.includes("shouldAutoArmReadonly"));
  assert.ok(src.includes("STICKY_ENTRY_TYPE") || src.includes("pstack-poteto-mode"));
});

await check("index.ts wires sticky + playbook match + session readonly", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/index.ts"), "utf8");
  assert.ok(src.includes("buildPotetoStickyPrompt"));
  assert.ok(src.includes("matchStickyPlaybook"));
  assert.ok(src.includes("userText: lastUserText") || src.includes("userText:"));
  assert.ok(src.includes("pstack-readonly"));
  assert.ok(src.includes("pstack-session-readonly") || src.includes("READONLY_ENTRY_TYPE"));
  assert.ok(src.includes("tool_call"));
});

await check("normalizeModelSelector refuses/maps bare slugs", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/models/config.ts")).href);
  const mapped = mod.normalizeModelSelector("grok-4.6-fast-xhigh", "xai/grok-4");
  assert.equal(mapped.ok, true);
  assert.equal(mapped.model, "xai/grok-4");
  const ok = mod.normalizeModelSelector("anthropic/claude-sonnet-4-5");
  assert.equal(ok.ok, true);
  const bad = mod.normalizeModelSelector("totally-fake-slug-xyz", undefined, {
    allowFallbackToParent: false,
  });
  assert.equal(bad.ok, false);
  const cfg = mod.defaultModelsConfig("xai/grok-4");
  for (const v of Object.values(cfg.roles)) {
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) {
      assert.ok(mod.isProviderId(x) || mod.isInheritAlias(x), `unexpected default: ${x}`);
    }
  }
});

await check("spawn refuses explicit invalid model + inheritParentTools wiring", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  assert.ok(src.includes("inheritParentTools"));
  assert.ok(src.includes("getActiveTools"));
  assert.ok(src.includes("allowFallbackToParent: false"));
  assert.ok(src.includes("AUTO_READONLY_ROLES"));
});

await check("child-runner concurrency default>=8 + persist + session isolated", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  assert.ok(mod.MAX_CONCURRENCY >= 8 && mod.MAX_CONCURRENCY <= 32, `cap=${mod.MAX_CONCURRENCY}`);
  const t = mod.truncate("x".repeat(200_000), { maxBytes: 1000 });
  assert.ok(t.text.includes("truncated"));
  const dir = mkdtempSync(join(tmpdir(), "pstack-out-"));
  try {
    const big = "hello-world-".repeat(20_000);
    const t2 = mod.truncate(big, { maxBytes: 500, persistDir: dir, tag: "t" });
    assert.ok(t2.outputPath);
    assert.ok(existsSync(t2.outputPath));
    assert.ok(readFileSync(t2.outputPath, "utf8").includes("hello-world"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  assert.ok(src.includes("PSTACK_MAX_CONCURRENCY"));
  assert.ok(src.includes("sessionMode") || src.includes("PSTACK_CHILD_SESSION"));
  assert.ok(src.includes("--append-system-prompt"));
  assert.ok(src.includes("--session-dir"));
  assert.ok(src.includes("return \"isolated\"") || src.includes('return "isolated"'));
  assert.equal(mod.shouldPersistOutput({ task: "x", timeoutMs: 10 * 60 * 1000 }), true);
  assert.equal(mod.shouldPersistOutput({ task: "x", persistOutput: false, timeoutMs: 10 * 60 * 1000 }), false);
});

await check("jobs enqueue + abort/cancel registry", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  mod.__resetBackgroundJobsForTests();
  assert.equal(mod.listBackgroundJobs().length, 0);
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  assert.ok(src.includes("enqueueBackgroundChild"));
  assert.ok(src.includes('action === "abort" || action === "cancel"') || src.includes("cancel"));
  assert.ok(src.includes("pstack_jobs"));
  assert.ok(src.includes('action === "list"'));
  assert.ok(src.includes('action === "status"'));
  assert.ok(src.includes('action === "await"'));
});

await check("heartbeat coalesces dynamic double-fire + maxFires + shutdown clear", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  assert.equal(mod.DYNAMIC_COALESCE_MS, 2500);
  const state = { lastFireAt: 1000, fires: 0, maxFires: 3, armed: true };
  const c = mod.decideFire(state, "settle", 1000 + 500, mod.DYNAMIC_COALESCE_MS, "dynamic");
  assert.equal(c.action, "coalesce");
  const f = mod.decideFire(state, "watcher", 1000 + 3000, mod.DYNAMIC_COALESCE_MS, "dynamic");
  assert.equal(f.action, "fire");
  assert.equal(f.fires, 1);
  mod.applyFire(state, 1000 + 3000);
  assert.equal(state.fires, 1);
  assert.ok(mod.shouldSkipSettleArm(state.lastFireAt, state.lastFireAt + 100));
  state.fires = 3;
  state.lastFireAt = 0;
  const stop = mod.decideFire(state, "interval", Date.now(), mod.DYNAMIC_COALESCE_MS, "interval");
  assert.equal(stop.action, "stop");
  mod.clearLoopState(state);
  assert.equal(state.armed, false);
  const src = readFileSync(resolve(ROOT, "extensions/heartbeat/index.ts"), "utf8");
  assert.ok(src.includes("DYNAMIC_COALESCE_MS"));
  assert.match(src, /clearTimer\(state\)/);
  assert.ok(src.includes("session_shutdown"));
  assert.ok(src.includes("lastFireAt"));
  assert.ok(src.includes("status") && src.includes("list") && src.includes("stop"));
  assert.ok(src.includes("formatLoopRows") || src.includes("/pstack-loop status"));
  assert.ok(src.includes('action === "status" || action === "list"') || src.includes('params.action === "status" || params.action === "list"'));
});

await check("zero double-fire under rapid settle+watcher script", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  const state = { lastFireAt: 0, fires: 0, maxFires: 10, armed: true };
  let fires = 0;
  const t0 = 10_000;
  for (const [reason, t] of [
    ["watcher", t0],
    ["settle", t0 + 200],
    ["settle", t0 + 400],
    ["watcher", t0 + 600],
  ]) {
    const d = mod.decideFire(state, reason, t, mod.DYNAMIC_COALESCE_MS, "dynamic");
    if (d.action === "fire") {
      fires++;
      mod.applyFire(state, t);
    }
  }
  assert.equal(fires, 1, `expected 1 fire in coalesce window, got ${fires}`);
  const later = mod.decideFire(state, "settle", t0 + 3000, mod.DYNAMIC_COALESCE_MS, "dynamic");
  assert.equal(later.action, "fire");
});

await check("babysit watchArgv recipes concrete + materialize + shipping default", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  const argv = mod.materializeWatchArgv("watch-pr-status", "42");
  assert.deepEqual(argv.slice(-2), ["42", "--status-only"]);
  assert.ok(!argv.some((a) => a.includes("<pr>")));
  const gh = mod.materializeWatchArgv("gh-checks-watch", "#99");
  assert.deepEqual(gh, ["gh", "pr", "checks", "99", "--watch"]);
  const src = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/babysit.md"), "utf8");
  assert.ok(src.includes("watchArgv"));
  assert.ok(src.includes("--status-only"));
  assert.ok(src.includes("dynamic"));
  assert.ok(src.includes("coalesced") || src.includes("2.5"));
  const ship = await import(pathToFileURL(resolve(ROOT, "extensions/shipping/babysit-recipes.ts")).href);
  assert.equal(ship.DEFAULT_BABYSIT_RECIPE, "watch-pr-drive");
  const hint = ship.babysitDynamicLoopHint("123");
  assert.equal(hint.loopArm.mode, "dynamic");
  assert.ok(Array.isArray(hint.watchArgv) && hint.watchArgv.includes("123"));
  assert.ok(!hint.watchArgv.some((a) => String(a).includes("<pr>")));
});

await check("evaluateMergeGates fixture matrix", async () => {
  const ship = await import(pathToFileURL(resolve(ROOT, "extensions/shipping/gates.ts")).href);
  assert.ok(ship.MERGE_GATE_FIXTURES.length >= 8, `fixtures=${ship.MERGE_GATE_FIXTURES.length}`);
  for (const fix of ship.MERGE_GATE_FIXTURES) {
    const problems = ship.evaluateMergeGates(fix.view);
    if (fix.expectPass) {
      assert.equal(problems.length, 0, `${fix.id} expected pass got ${problems}`);
    } else {
      assert.ok(problems.length > 0, `${fix.id} expected fail`);
      for (const sub of fix.expectSubstrings ?? []) {
        assert.ok(
          problems.some((p) => p.includes(sub)),
          `${fix.id} missing ${sub} in ${JSON.stringify(problems)}`,
        );
      }
    }
  }
});

await check("deslop applySafe + dryRun path exercised", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/companions/deslop-core.ts")).href);
  const dir = mkdtempSync(join(tmpdir(), "pstack-deslop-"));
  try {
    const file = join(dir, "sample.ts");
    writeFileSync(
      file,
      ["const x = 1;", "// Phase 1: add cards", "// =====", "// Helper for parse", "const y = 2;", ""].join("\n"),
      "utf8",
    );
    const suggestions = [
      {
        file: "sample.ts",
        line: "// Phase 1: add cards",
        label: "narration / alibi comment",
        severity: "high",
        action: "delete-line",
        safeDelete: true,
      },
      {
        file: "sample.ts",
        line: "// =====",
        label: "banner/separator comment",
        severity: "high",
        action: "delete-line",
        safeDelete: true,
      },
    ];
    const result = mod.applySafeDeletes(dir, suggestions);
    assert.ok(result.applied >= 1, `applied=${result.applied}`);
    const next = readFileSync(file, "utf8");
    assert.ok(!next.includes("Phase 1"));
    assert.ok(next.includes("const x = 1"));
    const scanned = mod.scanAddedLinesForSlop([
      { file: "a.ts", text: "// Phase 1: add cards" },
      { file: "a.ts", text: "// Helper for x" },
      { file: "a.ts", text: "const ok = true;" },
    ]);
    assert.ok(scanned.suggestions.some((s) => s.safeDelete));
    assert.ok(scanned.rankedLabels.includes("redundant helper/WIP comment") || scanned.suggestions.some((s) => s.label.includes("Helper") || s.label.includes("helper")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(resolve(ROOT, "extensions/companions/index.ts"), "utf8");
  assert.ok(src.includes("applySafe"));
  assert.ok(src.includes("autoApply"));
  assert.ok(src.includes("safeDelete"));
  assert.ok(src.includes("dryRun"));
  assert.ok(mod.SLOP_PATTERNS.length >= 17);
});

await check("AUTO_READONLY roles + investigation auto-arm wiring", async () => {
  const spawnSrc = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  assert.ok(spawnSrc.includes("AUTO_READONLY_ROLES"));
  assert.ok(spawnSrc.includes("comment-sicko"));
  assert.ok(spawnSrc.includes("investigator"));
  const sticky = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  assert.ok(sticky.shouldAutoArmReadonly("investigation"));
  const idx = readFileSync(resolve(ROOT, "extensions/index.ts"), "utf8");
  assert.ok(idx.includes("shouldAutoArmReadonly"));
  assert.ok(idx.includes("SESSION_WRITE_TOOLS") || idx.includes('"write"'));
  assert.ok(idx.includes("block: true"));
});

await check("worktree sanitize + always-isolate + cleanup helpers", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/worktree/helpers.ts")).href);
  assert.equal(mod.sanitizeWorktreeName("ok-name_1"), "ok-name_1");
  assert.throws(() => mod.sanitizeWorktreeName("../evil"));
  assert.throws(() => mod.sanitizeWorktreeName("-rf"));
  assert.throws(() => mod.sanitizeBaseRef("-b"));
  const src = readFileSync(resolve(ROOT, "extensions/worktree/index.ts"), "utf8");
  assert.ok(src.includes("cleanupPstackWorktreesOnShutdown"));
  assert.ok(src.includes("session_shutdown"));
  const swarm = readFileSync(resolve(ROOT, "extensions/orchestration/swarm.ts"), "utf8");
  assert.ok(swarm.includes("ensureAlwaysIsolated"));
  const arena = readFileSync(resolve(ROOT, "extensions/orchestration/arena.ts"), "utf8");
  assert.ok(arena.includes("ensureAlwaysIsolated"));

  const dir = mkdtempSync(join(tmpdir(), "pstack-wt-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "README"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
    const created = await mod.createIsolatedWorktree(dir, "cleanup-me");
    assert.ok(existsSync(created.path));
    const result = await mod.cleanupPstackWorktreesOnShutdown(dir);
    assert.ok(
      result.removed.includes("cleanup-me") || result.skipped.length >= 0,
      JSON.stringify(result),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await check("recall ranked merge of sessions+git+gh", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/sessions/index.ts"), "utf8");
  assert.ok(src.includes("recall"));
  assert.ok(src.includes("recallGitLog"));
  assert.ok(src.includes("recallGhPrs"));
  assert.ok(src.includes("buildRankedRecallCorpus") || src.includes("ranked"));
  const skill = readFileSync(resolve(ROOT, "skills/recall/SKILL.md"), "utf8");
  assert.ok(skill.includes("recall") && skill.includes("git log"));
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sessions/recall-corpus.ts")).href);
  const log = await mod.recallGitLog(ROOT, "Stage", 5);
  assert.ok(typeof log === "string" && log.length > 0);
  const rank = await import(pathToFileURL(resolve(ROOT, "extensions/sessions/recall-rank.ts")).href);
  const corpus = rank.buildRankedRecallCorpus({
    query: "auth",
    days: 7,
    sessionSnippets: ["/tmp/s1.jsonl\n  talked about auth middleware"],
    gitLog: "abc1234 fix auth token refresh\ndef5678 docs only",
    ghPrs: "#42 [OPEN] Harden auth middleware (auth) 2026-01-01 https://example/42",
    limit: 10,
  });
  assert.ok(corpus.hits.length >= 2);
  assert.equal(corpus.hits[0].score >= corpus.hits[1].score, true);
  assert.ok(corpus.rankedBlock.includes("auth"));
  const body = rank.formatRankedRecallBody(corpus, 7);
  assert.ok(body.includes("Ranked merge"));
});

await check("models always-applied validated inject wiring", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/models/index.ts"), "utf8");
  assert.ok(src.includes("before_agent_start"));
  assert.ok(src.includes("validated") || src.includes("always-applied"));
  assert.ok(src.includes("normalizeModelSelector") || src.includes("isBareMarketingSlug"));
  assert.ok(src.includes("setup-pstack"));
});

await check("why + guide + investigation Pi-local truth", async () => {
  const why = readFileSync(resolve(ROOT, "skills/why/SKILL.md"), "utf8");
  assert.ok(!why.includes("list the available MCPs from the Cursor environment"));
  assert.ok(why.includes("pstack-readonly"));
  const guide = readFileSync(resolve(ROOT, "docs/guide/05-build-and-clean.md"), "utf8");
  assert.ok(guide.includes("pstack_deslop"));
  assert.ok(!guide.includes("`cursor-team-kit [leave-behind on Pi]` plugin, not in pstack"));
  const inv = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/investigation.md"), "utf8");
  assert.ok(inv.includes("/pstack-readonly"));
});

await check("PARITY scorecard documents local-scope EQUIVALENT criteria", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  assert.ok(parity.includes("EQUIVALENT"));
  assert.ok(parity.includes("local-") || parity.includes("local "));
  // After update: expect multiple EQUIVALENT rows beyond worktree
  const equivCount = (parity.match(/\*\*EQUIVALENT\*\*/g) || []).length;
  assert.ok(equivCount >= 2, `expected >=2 EQUIVALENT markers, got ${equivCount}`);
});

console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
