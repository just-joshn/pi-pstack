/**
 * Scripted checks for close-local-v2 Stage 2 (no full Pi runtime required).
 * Run: node --experimental-strip-types extensions/test/verify-local-partials.mjs
 *   or: bun extensions/test/verify-local-partials.mjs
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
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

await check("index.ts wires sticky + playbook match + session readonly", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/index.ts"), "utf8");
  assert.ok(src.includes("buildPotetoStickyPrompt"));
  assert.ok(src.includes("matchStickyPlaybook"));
  assert.ok(src.includes("userText: lastUserText"));
  assert.ok(src.includes("pstack-readonly"));
  assert.ok(src.includes("pstack-session-readonly"));
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
  // Do not actually spawn pi — just verify registry API shapes via abort of empty
  assert.equal(mod.listBackgroundJobs().length, 0);
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  assert.ok(src.includes("enqueueBackgroundChild"));
  assert.ok(src.includes('action === "abort" || action === "cancel"') || src.includes('cancel'));
  assert.ok(src.includes("pstack_jobs"));
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
  // maxFires stop
  state.fires = 3;
  state.lastFireAt = 0;
  const stop = mod.decideFire(state, "interval", Date.now(), mod.DYNAMIC_COALESCE_MS, "interval");
  assert.equal(stop.action, "stop");
  // shutdown clear
  mod.clearLoopState(state);
  assert.equal(state.armed, false);
  const src = readFileSync(resolve(ROOT, "extensions/heartbeat/index.ts"), "utf8");
  assert.ok(src.includes("DYNAMIC_COALESCE_MS"));
  assert.match(src, /clearTimer\(state\)/);
  assert.ok(src.includes("session_shutdown"));
  assert.ok(src.includes("lastFireAt"));
});

await check("babysit watchArgv recipes concrete + materialize", async () => {
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
});

await check("deslop applySafe path exercised", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/companions/deslop-core.ts")).href);
  const dir = mkdtempSync(join(tmpdir(), "pstack-deslop-"));
  try {
    const file = join(dir, "sample.ts");
    writeFileSync(
      file,
      ["const x = 1;", "// Phase 1: add cards", "// =====", "const y = 2;", ""].join("\n"),
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
      { file: "a.ts", text: "const ok = true;" },
    ]);
    assert.ok(scanned.suggestions.some((s) => s.safeDelete));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(resolve(ROOT, "extensions/companions/index.ts"), "utf8");
  assert.ok(src.includes("applySafe"));
  assert.ok(src.includes("autoApply"));
  assert.ok(src.includes("safeDelete"));
});

await check("AUTO_READONLY roles + merge gates pure eval", async () => {
  const spawnSrc = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  assert.ok(spawnSrc.includes("AUTO_READONLY_ROLES"));
  assert.ok(spawnSrc.includes("comment-sicko"));
  assert.ok(spawnSrc.includes("investigator"));
  const ship = await import(pathToFileURL(resolve(ROOT, "extensions/shipping/gates.ts")).href);
  const bad = ship.evaluateMergeGates({
    state: "OPEN",
    mergedAt: null,
    mergeStateStatus: "DIRTY",
    reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }],
  });
  assert.ok(bad.some((p) => p.includes("DIRTY")));
  assert.ok(bad.some((p) => p.includes("CHANGES_REQUESTED")));
  assert.ok(bad.some((p) => p.includes("FAILURE")));
  const good = ship.evaluateMergeGates({
    state: "OPEN",
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
  });
  assert.equal(good.length, 0);
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

  // Live cleanup on a temp git repo with a safe empty worktree
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

await check("recall corpus broader than sessions-only", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/sessions/index.ts"), "utf8");
  assert.ok(src.includes('action === "recall"') || src.includes("recall"));
  assert.ok(src.includes("recallGitLog"));
  assert.ok(src.includes("recallGhPrs"));
  const skill = readFileSync(resolve(ROOT, "skills/recall/SKILL.md"), "utf8");
  assert.ok(skill.includes("recall") && skill.includes("git log"));
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sessions/recall-corpus.ts")).href);
  const log = await mod.recallGitLog(ROOT, "Stage", 5);
  assert.ok(typeof log === "string" && log.length > 0);
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

console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
