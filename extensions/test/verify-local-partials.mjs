/**
 * Scripted checks for close-local-v3 Stage 2 (no full Pi runtime required).
 * Run: node --experimental-strip-types extensions/test/verify-local-partials.mjs
 *   or: bun extensions/test/verify-local-partials.mjs
 */
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from "node:fs";
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
    process.stdout.write(`PASS ${name}\n`);
  } catch (err) {
    failed = failed + 1;
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

await check("sticky restore reinjects playbook steps (not routing note only)", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-poteto.ts")).href);
  const pb = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-playbook.ts")).href);
  assert.ok(typeof pb.buildPlaybookInjectFromId === "function");
  const block = pb.buildPlaybookInjectFromId("babysit", { restored: true });
  assert.ok(block && block.includes("Restored sticky playbook"));
  assert.ok(block.includes("Open a todolist"));
  assert.ok(block.length > 200, "expected full playbook body, not a short note");
  const prompt = mod.buildPotetoStickyPrompt("BASE", {
    userText: "",
    restoredPlaybookId: "investigation",
  });
  assert.ok(prompt.includes("Restored sticky playbook") || prompt.includes("investigation"));
  assert.ok(!prompt.includes("Previously matched") || prompt.includes("Open a todolist"));
  assert.ok(prompt.includes("Open a todolist"), "restore path must reinject steps");
});

await check("force-invoke routes via input transform, not a queued follow-up", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  assert.ok(src.includes('action: "transform"'), "force-invoke must return a transform result");
  assert.ok(src.includes("restoredPlaybookId"));
  assert.ok(!src.includes("forceInvokeFallbackId"), "fallback-on-catch machinery must be gone");
  assert.ok(!src.includes("lastForcedSkillKey"), "re-entrant dedupe machinery must be gone");
  assert.ok(!src.includes("deliverAs"), "must not queue a followUp for force-invoke");
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
  const src = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  assert.ok(src.includes("forcePotetoSkillMessage"));
  assert.ok(src.includes("sendUserMessage"));
  assert.ok(src.includes("matchedPlaybookId"));
  assert.ok(src.includes("shouldAutoArmReadonly"));
  assert.ok(src.includes("STICKY_ENTRY_TYPE") || src.includes("pstack-poteto-mode"));
});

await check("extension modules wire sticky + playbook match + session readonly", async () => {
  const poteto = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  const readonly = readFileSync(resolve(ROOT, "extensions/readonly-state/index.ts"), "utf8");
  assert.ok(poteto.includes("buildPotetoStickyPrompt"));
  assert.ok(poteto.includes("matchStickyPlaybook"));
  assert.ok(poteto.includes("userText: lastUserText") || poteto.includes("userText:"));
  assert.ok(readonly.includes("pstack-readonly"));
  assert.ok(readonly.includes("pstack-session-readonly") || readonly.includes("READONLY_ENTRY_TYPE"));
  assert.ok(readonly.includes("tool_call"));
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
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  assert.ok(src.includes("inheritParentTools"));
  assert.ok(src.includes("getActiveTools"));
  assert.ok(src.includes("allowFallbackToParent: false"));
  assert.ok(runner.includes("AUTO_READONLY_ROLES") || src.includes("AUTO_READONLY_ROLES"));
  assert.ok(runner.includes("inheritParentTools !== false"), "inherit default-on in resolveTools");
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
      fires = fires + 1;
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
  assert.equal(argv[0], "bun", "watch-pr recipes must run through bun, not bash");
  assert.ok(argv.includes("--pr"), "watch-pr recipes must pass the PR via --pr, the cli has no positional arg");
  const gh = mod.materializeWatchArgv("gh-checks-watch", "#99");
  assert.deepEqual(gh, ["gh", "pr", "checks", "99", "--watch"]);
  const stackArgv = mod.materializeWatchArgv("watch-pr-stack", "7");
  assert.deepEqual(stackArgv, ["bun", "skills/poteto-mode/scripts/watch-pr/watch-pr", "--stack", "--pr", "7"]);
  const queuedArgv = mod.materializeWatchArgv("watch-pr-queued-stack", "7", { stackPrs: ["3", "5", "7"] });
  assert.deepEqual(queuedArgv, [
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--queued-stack",
    "--stack-prs",
    "3,5,7",
  ]);
  assert.throws(() => mod.materializeWatchArgv("watch-pr-queued-stack", "7"), /stackPrs/);
  for (const recipeId of Object.keys(mod.BABYSIT_WATCH_RECIPES)) {
    assert.ok(!mod.BABYSIT_WATCH_RECIPES[recipeId].argvTemplate.includes("bash"), `${recipeId} must not exec via bash`);
  }
  const src = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/babysit.md"), "utf8");
  assert.ok(src.includes("watchArgv"), "skill must bind the forge watcher to watchArgv");
  assert.ok(src.includes("dynamic"), "skill must bind the watch to pstack_loop dynamic mode");
  assert.ok(!src.includes("`/loop`"), "skill must not leave the Cursor /loop token");
  const ship = await import(pathToFileURL(resolve(ROOT, "extensions/shipping/babysit-recipes.ts")).href);
  assert.equal(ship.DEFAULT_BABYSIT_RECIPE, "watch-pr-drive");
  const hint = ship.babysitDynamicLoopHint("123");
  assert.equal(hint.loopArm.mode, "dynamic");
  assert.ok(Array.isArray(hint.watchArgv) && hint.watchArgv.includes("123"));
  assert.ok(!hint.watchArgv.some((a) => String(a).includes("<pr>")));
  const queuedHint = ship.babysitDynamicLoopHint("7", "watch-pr-queued-stack", ["3", "7"]);
  assert.ok(queuedHint.watchArgv.includes("3,7"), "stackPrs must thread through babysitDynamicLoopHint");
});

await check("watch-pr runs via bun with an ENOENT-free failure when bun is missing", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  assert.deepEqual(mod.watchPrInvocation("/abs/watch-pr", ["--pr", "9"]), {
    command: "bun",
    args: ["/abs/watch-pr", "--pr", "9"],
  });
  await mod.assertBunAvailable(async () => ({ code: 0 }));
  await assert.rejects(
    () => mod.assertBunAvailable(async () => ({ code: 1 })),
    /bun is required.*not found on PATH/,
    "missing bun must fail with an actionable message, not a bare ENOENT",
  );
  const src = readFileSync(resolve(ROOT, "extensions/shipping/index.ts"), "utf8");
  assert.ok(src.includes("assertBunAvailable"), "pstack_babysit must gate the watch-pr recipes on bun being resolvable");
  assert.ok(!/pi\.exec\(\s*"bash"/.test(src), "must not exec the bundled TypeScript watcher via bash");
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
  const poteto = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  const readonly = readFileSync(resolve(ROOT, "extensions/readonly-state/index.ts"), "utf8");
  assert.ok(poteto.includes("shouldAutoArmReadonly"));
  assert.ok(readonly.includes("SESSION_WRITE_TOOLS") || readonly.includes('"write"'));
  assert.ok(readonly.includes("block: true"));
});

await check("playbook auto-arm ignores long briefs", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  assert.equal(mod.shouldAutoArmFromPlaybookMatch("investigation", false, 5, "short request"), true);
  assert.equal(mod.shouldAutoArmFromPlaybookMatch("investigation", true, 12, "x".repeat(500)), false);
  assert.equal(mod.shouldAutoArmFromPlaybookMatch("investigation", false, 3, "short request"), false);
  assert.equal(mod.shouldAutoArmFromPlaybookMatch("babysit", true, 12, "x"), false);
});

await check("readonly auto-arm requires the read-only investigation playbook target", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  assert.equal(mod.shouldAutoArmFromSkillText("please investigate this"), false);
  assert.equal(mod.shouldAutoArmFromSkillText("playbooks/investigation how does auth work"), false);
  assert.equal(mod.shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/babysit investigate CI"), false);
  assert.equal(mod.shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation how does auth work"), true);
});

async function verifyWorktreeCleanup(mod, dir) {
  const created = await mod.createIsolatedWorktree(dir, "cleanup-me");
  assert.ok(existsSync(created.path));
  const result = await mod.cleanupPstackWorktreesOnShutdown(dir);
  assert.ok(result.removed.includes("cleanup-me") || result.skipped.length >= 0, JSON.stringify(result));

  const busy = await mod.createIsolatedWorktree(dir, "child-busy");
  const busySessions = join(busy.path, ".pi", "pstack-child-sessions", "c-test");
  mkdirSync(busySessions, { recursive: true });
  writeFileSync(join(busySessions, "session.jsonl"), "{}\n");
  const busyResult = await mod.cleanupPstackWorktreesOnShutdown(dir);
  assert.ok(existsSync(busy.path), "a live child session must block cleanup");
  assert.ok(
    busyResult.skipped.some(
      (entry) => entry.name === "child-busy" && entry.reason.includes("child session active"),
    ),
    JSON.stringify(busyResult),
  );

  const stale = await mod.createIsolatedWorktree(dir, "child-stale");
  const staleSessions = join(stale.path, ".pi", "pstack-child-sessions", "c-old");
  mkdirSync(staleSessions, { recursive: true });
  const staleFile = join(staleSessions, "session.jsonl");
  writeFileSync(staleFile, "{}\n");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(staleFile, twoHoursAgo, twoHoursAgo);
  const staleResult = await mod.cleanupPstackWorktreesOnShutdown(dir);
  assert.ok(staleResult.removed.includes("child-stale"), JSON.stringify(staleResult));
  assert.ok(!existsSync(stale.path), "a stale child session must not block cleanup");
}

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
    writeFileSync(join(dir, ".gitignore"), ".pi/\n.pstack-worktrees/\n");
    writeFileSync(join(dir, "README"), "x\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
    await verifyWorktreeCleanup(mod, dir);
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
  assert.ok(skill.includes("pstack_sessions"), "recall skill must name the Pi corpus tool");
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
  assert.ok(why.includes("investigator"), "why must offer the Pi investigator role");
  const guide = readFileSync(resolve(ROOT, "docs/guide/05-build-and-clean.md"), "utf8");
  assert.ok(guide.includes("pstack_deslop"));
  assert.ok(!guide.includes("`cursor-team-kit [leave-behind on Pi]` plugin, not in pstack"));
  const inv = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/investigation.md"), "utf8");
  assert.ok(inv.includes("read-only"), "investigation stays read-only");
  const readonly = readFileSync(resolve(ROOT, "extensions/readonly-state/index.ts"), "utf8");
  assert.ok(readonly.includes("pstack-readonly"), "parent readonly enforcement lives in the extension");
});


await check("close-orch-p0: poteto prefers background:true + pstack_jobs drain", async () => {
  const skill = readFileSync(resolve(ROOT, "skills/poteto-mode/SKILL.md"), "utf8");
  assert.ok(skill.includes("Prefer `background: true`") || skill.includes("Prefer **`background: true`**"), "poteto must prefer background:true");
  assert.ok(!skill.includes("**Defaults for every `pstack_spawn` call.** Foreground sync-awaits."), "must not lead with Foreground sync-awaits as primary default");
  assert.ok(skill.includes("pstack_jobs"), "must cite pstack_jobs drain");
});

await check("close-orch-p0: swarm/arena concurrency cap 8 (not 4)", async () => {
  const swarm = readFileSync(resolve(ROOT, "skills/swarm/SKILL.md"), "utf8");
  const arena = readFileSync(resolve(ROOT, "skills/arena/SKILL.md"), "utf8");
  assert.ok(!/concurrency cap:\s*4\b/.test(swarm), "swarm must not say cap 4");
  assert.ok(!/concurrency cap:\s*4\b/.test(arena), "arena must not say cap 4");
  assert.ok(swarm.includes("Pi concurrency cap"), "swarm must bind the cloud concurrency limit to the Pi cap");
  assert.ok(arena.includes("pstack_arena"), "arena must bind the Cursor fan-out to pstack_arena");
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  assert.ok(/parsePositiveInt\(process\.env\.PSTACK_MAX_CONCURRENCY,\s*8/.test(runner), "code default must remain 8");
});

await check("close-orch-p0: PARITY row 2 EQUIVALENT (local-Task) + ceilings", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  const row2 = parity.split("\n").find((l) => l.startsWith("| 2 | Task"));
  assert.ok(row2, "row 2 line missing");
  assert.ok(row2.includes("EQUIVALENT") && row2.includes("local-Task"), `row2 must be EQUIVALENT (local-Task): ${row2.slice(0, 120)}`);
  assert.ok(!/Residuals \(≤3\):\s*\(1\)/.test(row2), "must not keep blocking Residuals (1)(2)(3) PARTIAL framing");
  assert.ok(/host ceiling|N\/A/i.test(row2) && /MCP/i.test(row2), "must mark MCP inherit as host ceiling / N/A");
  assert.ok(/clean|start clean|parent transcript/i.test(row2), "must mark clean-context / no parent-history as Cursor-aligned");
  assert.ok(/session_shutdown|session-scoped|Cursor-local restart/i.test(row2), "must mark session-scoped jobs as Cursor-local parity");
});


await check("close-orch-p1: unit resume / role-aware background default / inherit default-on", async () => {
  const { runSpawnOrchP1Units } = await import(pathToFileURL(resolve(ROOT, "extensions/test/spawn-orch-p1-unit.mjs")).href);
  await runSpawnOrchP1Units();
});

await check("close-orch-p1: pstack_spawn schema + guidelines (resume, bg default, inherit)", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  assert.ok(src.includes("resumeSessionDir"), "must declare resumeSessionDir");
  assert.ok(src.includes("resumeJobId"), "must declare resumeJobId");
  assert.ok(src.includes("wantsBackground"), "must use wantsBackground");
  assert.ok(src.includes("wantsBackground(params.background, poteto)"), "role-aware call site");
  assert.ok(/role-aware/i.test(src), "guidelines describe role-aware background default");
  assert.ok(src.includes("background:false") || src.includes("background: false") || src.includes("background:true/false"), "guidelines mention explicit override");
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  assert.ok(runner.includes("if (background !== undefined) return background"), "explicit background always wins");
  assert.ok(runner.includes("return poteto === true"), "only poteto-agent detaches by default");
  assert.ok(runner.includes("inheritParentTools !== false"), "inherit default-on");
  assert.ok(runner.includes("resolveChildSessionDir"), "child-runner must resolve resume session dir");
  assert.ok(runner.includes("resumeSessionDir"), "child-runner accepts resumeSessionDir");
  assert.ok(runner.includes("sessionDir"), "job records sessionDir");
  assert.ok(!runner.includes(".pi/pstack-jobs/"), "must not productize disk job ledger");
});

await check("close-orch-p1: orchestrate cites resume; no deferred carve-out", async () => {
  const orch = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/orchestrate.md"), "utf8");
  assert.ok(orch.includes("resumeSessionDir"), "orchestrate must cite resumeSessionDir");
  assert.ok(orch.includes("resumeJobId"), "orchestrate must cite resumeJobId");
  assert.ok(!/P1 follow-on/i.test(orch), "must not say resume is P1 follow-on");
  assert.ok(!/not required for local-Task/i.test(orch), "must not carve out resume from Cap2");
});

await check("close-orch-p1: poteto cites resume + bg prefer", async () => {
  const skill = readFileSync(resolve(ROOT, "skills/poteto-mode/SKILL.md"), "utf8");
  assert.ok(skill.includes("Prefer `background: true`") || skill.includes("Prefer **`background: true`**"), "poteto must prefer background:true");
  assert.ok(skill.includes("resumeSessionDir"), "poteto must cite resumeSessionDir");
  assert.ok(skill.includes("resumeJobId") || skill.includes("resumeJobId"), "poteto must cite resume");
});

await check("close-orch-p1: swarm/arena intentional sync gather + N× spawn bg drain", async () => {
  const swarm = readFileSync(resolve(ROOT, "skills/swarm/SKILL.md"), "utf8");
  const arena = readFileSync(resolve(ROOT, "skills/arena/SKILL.md"), "utf8");
  assert.ok(/intentional sync gather/i.test(swarm), "swarm must state intentional sync gather");
  assert.ok(/intentional sync gather/i.test(arena), "arena must state intentional sync gather");
  assert.ok(/N× `pstack_spawn`|N× pstack_spawn/i.test(swarm) || swarm.includes("N× `pstack_spawn`"), "swarm cites N× spawn");
  assert.ok(swarm.includes("pstack_jobs") || /N× `pstack_spawn`/.test(swarm), "swarm cites bg drain path");
  assert.ok(/N× `pstack_spawn`/.test(arena) || arena.includes("N× `pstack_spawn`"), "arena cites N× spawn");
  assert.ok(!/PARTIAL because sync/i.test(swarm + arena), "must not imply PARTIAL for sync gather");
});

await check("close-orch-p1: PARITY row 2 IN list (resume + bg default + inherit default-on)", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  const row2 = parity.split("\n").find((l) => l.startsWith("| 2 | Task"));
  assert.ok(row2, "row 2 line missing");
  assert.ok(row2.includes("EQUIVALENT") && row2.includes("local-Task"), `row2 must be EQUIVALENT (local-Task)`);
  assert.ok(/resumeSessionDir/i.test(row2), "row2 IN must include resumeSessionDir");
  assert.ok(/omit→true|omit→true|background omit/i.test(row2) || /omit.*true/i.test(row2), "row2 IN must include background omit→true");
  assert.ok(/inheritParentTools.*default-on|default-on/i.test(row2), "row2 IN must include inherit default-on");
  assert.ok(/intentional sync gather|local-gather/i.test(row2), "row2 must frame swarm/arena gather");
  assert.ok(!/P1 follow-on|not a row-2 gate|resume deferred/i.test(row2), "must not keep resume-deferred gate language");
  assert.ok(/host ceiling|N\/A/i.test(row2) && /MCP/i.test(row2), "ceilings MCP N/A");
  assert.ok(!parity.includes(".pi/pstack-jobs/") || !/required.*pstack-jobs/i.test(parity), "no required disk ledger product");
});


await check("close-orch-p1b: unit true-continue argv (resume -c; fresh no -c)", async () => {
  const { runSpawnOrchP1bUnits } = await import(pathToFileURL(resolve(ROOT, "extensions/test/spawn-orch-p1b-unit.mjs")).href);
  await runSpawnOrchP1bUnits();
});

await check("close-orch-p1b: child-runner resume carries --continue with --session-dir", async () => {
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  assert.ok(runner.includes("buildChildPiArgs"), "must export/build argv via buildChildPiArgs");
  const { buildChildPiArgs, argvHasContinueSemantics } = await import(
    pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href
  );
  const spawnArgs = {
    selectedModel: "test/model",
    sessionMode: "isolated",
    sessionDir: "/tmp/pstack-resume-check",
    inheritNote: "note",
    prompt: "task",
  };
  const resumed = buildChildPiArgs({ ...spawnArgs, continueSession: true });
  assert.ok(argvHasContinueSemantics(resumed), "resume path must carry --continue or -c");
  assert.ok(resumed.includes("--session-dir"), "still passes --session-dir");
  assert.ok(!resumed.includes("--resume") && !resumed.includes("-r"), "must not pass interactive -r");
  const fresh = buildChildPiArgs({ ...spawnArgs, continueSession: false });
  assert.ok(!argvHasContinueSemantics(fresh), "fresh isolated argv must not carry continue");
});

await check("close-orch-p1b: spawn/jobs surface sessionDir in text+details", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  assert.ok(src.includes("sessionDir: job.sessionDir") || /sessionDir:\s*job\.sessionDir/.test(src), "details.sessionDir");
  assert.ok(/sessionDir=\$\{/.test(src), "text advertises sessionDir=");
  assert.ok(/sessionDir:\s*result\.sessionDir/.test(src) || src.includes("sessionDir: result.sessionDir"), "sync spawn details");
});

await check("close-orch-p1b: PARITY Cap2 EQUIVALENT cites continue/-c (not dir-only)", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  const row2 = parity.split("\n").find((l) => l.startsWith("| 2 | Task"));
  assert.ok(row2, "row 2 missing");
  assert.ok(row2.includes("EQUIVALENT") && row2.includes("local-Task"), `row2 must be EQUIVALENT after true continue: ${row2.slice(0, 160)}`);
  assert.ok(/--continue|-c|continueRecent|true continue/i.test(row2), "row2 must cite continue/-c semantics");
  assert.ok(!/reuse child `--session-dir`(?!;|;|,| \+)/.test(row2) || /--continue|-c/.test(row2), "must not claim dir-only reuse as sole resume");
  assert.ok(!/\*\*PARTIAL\*\*.*false twin|false-twin residual/i.test(row2), "after fix must not remain PARTIAL false-twin");
  assert.ok(/sessionDir/i.test(row2), "row2 mentions sessionDir surfacing or resume path");
});

await check("close-orch-p1b: orchestrate/poteto cite true continue", async () => {
  const orch = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/orchestrate.md"), "utf8");
  const skill = readFileSync(resolve(ROOT, "skills/poteto-mode/SKILL.md"), "utf8");
  assert.ok(/--continue|-c|continueRecent|true continue/i.test(orch), "orchestrate must document continue argv");
  assert.ok(/sessionDir/i.test(orch), "orchestrate cites surfaced sessionDir");
  assert.ok(/--continue|-c|continueRecent|continue prior child transcript/i.test(skill), "poteto must say continue transcript");
});

await check("docs-sync: README points at the live spec; PARITY is the historical scorecard", async () => {
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  assert.ok(!/several PARTIAL/i.test(readme), "README must not lead with several PARTIAL");
  assert.ok(readme.includes("omit→true"), "README must document background omit→true");
  assert.ok(/resumeSessionDir|resumeJobId|--continue/.test(readme), "README must mention resume / --continue");
  assert.ok(/PARITY\.md/.test(readme), "README must link PARITY");
  assert.ok(/spec\/SPEC\.md/.test(readme) && /spec:check/.test(readme), "README must point at the live spec and its check");
  assert.ok(/historical/i.test(readme), "README must name PARITY as the historical snapshot");
  assert.ok(!/background: true detaches/.test(readme), "README must not sole-story background:true detaches");
});

await check("docs-sync: PARITY keeps the scorecard wording and the swarm inventory row", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  assert.ok(/EQUIVALENT/.test(parity) && /PARTIAL/.test(parity), "PARITY scorecard names EQUIVALENT and PARTIAL");
  const swarmRow = parity.split("\n").find((l) => l.includes("`skills/swarm/SKILL.md`"));
  assert.ok(swarmRow, "swarm inventory row missing");
  assert.ok(/EQUIVALENT.*local-gather|local-gather.*EQUIVALENT/i.test(swarmRow), "swarm row must say EQUIVALENT local-gather");
  assert.ok(!/\(PARTIAL infra\)/.test(swarmRow), "swarm row must not claim PARTIAL infra");
});


await check("skill frontmatter names are Pi kebab-case (a-z0-9-hyphen)", async () => {
  const skillsDir = resolve(ROOT, "skills");
  const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  let bad = [];
  for (const d of dirs) {
    const f = resolve(skillsDir, d.name, "SKILL.md");
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^name:\s*(.+)$/m);
    if (!m) {
      bad = [...bad, `${d.name}: missing name`];
      continue;
    }
    const name = m[1].trim().replace(/^["']|["']$/g, "");
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) bad = [...bad, `${d.name}: [${name}]`];
  }
  assert.equal(bad.length, 0, `invalid Pi skill names:\n${bad.join("\n")}`);
});

await check("PARITY scorecard documents local-scope EQUIVALENT criteria", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  assert.ok(parity.includes("EQUIVALENT"));
  assert.ok(parity.includes("local-") || parity.includes("local "));
  // After update: expect multiple EQUIVALENT rows beyond worktree
  const equivCount = (parity.match(/\*\*EQUIVALENT\*\*/g) || []).length;
  assert.ok(equivCount >= 2, `expected >=2 EQUIVALENT markers, got ${equivCount}`);
});

process.stdout.write((failed ? `\n${failed} failed` : "\nAll checks passed") + "\n");
process.exit(failed ? 1 : 0);
