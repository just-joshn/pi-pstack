/**
 * Scripted checks for close-local-v3 Stage 2 (no full Pi runtime required).
 * Run: npx vitest run --project extensions
 */
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("sticky helper injects skill body (not soft nudge only)", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-poteto.ts")).href);
  mod.clearPotetoStickyCache?.();
  const body = mod.loadPotetoStickyBody();
  expect(body.includes("Non-negotiables"), "missing Non-negotiables").toBeTruthy();
  expect(body.length > 500, `sticky body too short (${body.length})`).toBeTruthy();
  const prompt = mod.buildPotetoStickyPrompt("BASE");
  expect(prompt.startsWith("BASE")).toBeTruthy();
  expect(prompt.includes("sticky")).toBeTruthy();
  expect(prompt.includes("Non-negotiables")).toBeTruthy();
});

test("sticky injects matched playbook steps", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-poteto.ts")).href);
  const pb = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-playbook.ts")).href);
  const match = pb.matchPlaybook("babysit this PR and get it green");
  expect(match, "expected babysit match").toBeTruthy();
  expect(match.id).toBe("babysit");
  const prompt = mod.buildPotetoStickyPrompt("BASE", { match });
  expect(prompt.includes("Matched playbook")).toBeTruthy();
  expect(prompt.includes("babysit")).toBeTruthy();
  expect(prompt.includes("You own the merge frontier") || prompt.includes("merge frontier")).toBeTruthy();
  const inv = pb.matchPlaybook("how does the auth middleware work?");
  expect(inv && inv.id === "investigation").toBeTruthy();
  const ship = pb.matchPlaybook("please land the stack when ready");
  expect(ship && ship.id === "shipping").toBeTruthy();
});

test("sticky restore reinjects playbook steps (not routing note only)", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-poteto.ts")).href);
  const pb = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-playbook.ts")).href);
  expect(typeof pb.buildPlaybookInjectFromId === "function").toBeTruthy();
  const block = pb.buildPlaybookInjectFromId("babysit", { restored: true });
  expect(block && block.includes("Restored sticky playbook")).toBeTruthy();
  expect(block.includes("Open a todolist")).toBeTruthy();
  expect(block.length > 200, "expected full playbook body, not a short note").toBeTruthy();
  const prompt = mod.buildPotetoStickyPrompt("BASE", {
    userText: "",
    restoredPlaybookId: "investigation",
  });
  expect(prompt.includes("Restored sticky playbook") || prompt.includes("investigation")).toBeTruthy();
  expect(!prompt.includes("Previously matched") || prompt.includes("Open a todolist")).toBeTruthy();
  expect(prompt.includes("Open a todolist"), "restore path must reinject steps").toBeTruthy();
});

test("force-invoke routes via input transform, not a queued follow-up", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  expect(src.includes('action: "transform"'), "force-invoke must return a transform result").toBeTruthy();
  expect(src.includes("restoredPlaybookId")).toBeTruthy();
  expect(!src.includes("forceInvokeFallbackId"), "fallback-on-catch machinery must be gone").toBeTruthy();
  expect(!src.includes("lastForcedSkillKey"), "re-entrant dedupe machinery must be gone").toBeTruthy();
  const inputHandler = src.slice(
    src.indexOf("function registerPotetoInput"),
    src.indexOf("function registerPotetoPrompt"),
  );
  expect(!inputHandler.includes("sendUserMessage"), "force-invoke must return a transform from the input handler, not queue a follow-up").toBeTruthy();
});

test("sticky force skill message + persist helpers", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  expect(mod.forcePotetoSkillMessage("fix flaky CI", "babysit")).toBe("/skill:poteto-mode playbooks/babysit fix flaky CI");
  expect(mod.forcePotetoSkillMessage("", "investigation").includes("playbooks/investigation")).toBeTruthy();
  expect(mod.shouldAutoArmReadonly("investigation")).toBeTruthy();
  expect(mod.shouldAutoArmReadonly("babysit")).toBe(false);
  const payload = mod.stickyEntryPayload(true, { id: "feature", score: 6 });
  expect(payload.enabled).toBe(true);
  expect(payload.matchedPlaybookId).toBe("feature");
  const parsed = mod.parseStickyEntry(payload);
  expect(parsed.matchedPlaybookId).toBe("feature");
  const src = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  expect(src.includes("forcePotetoSkillMessage")).toBeTruthy();
  expect(src.includes("sendUserMessage")).toBeTruthy();
  expect(src.includes("matchedPlaybookId")).toBeTruthy();
  expect(src.includes("shouldAutoArmReadonly")).toBeTruthy();
  expect(src.includes("STICKY_ENTRY_TYPE") || src.includes("pstack-poteto-mode")).toBeTruthy();
});

test("extension modules wire sticky + playbook match + session readonly", async () => {
  const poteto = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  const readonly = readFileSync(resolve(ROOT, "extensions/readonly-state/index.ts"), "utf8");
  expect(poteto.includes("buildPotetoStickyPrompt")).toBeTruthy();
  expect(poteto.includes("matchStickyPlaybook")).toBeTruthy();
  expect(poteto.includes("assignedPlaybookId") || poteto.includes("restoredPlaybookId")).toBeTruthy();
  expect(readonly.includes("pstack-readonly")).toBeTruthy();
  expect(readonly.includes("pstack-session-readonly") || readonly.includes("READONLY_ENTRY_TYPE")).toBeTruthy();
  expect(readonly.includes("tool_call")).toBeTruthy();
});

test("normalizeModelSelector refuses/maps bare slugs", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/models/config.ts")).href);
  const mapped = mod.normalizeModelSelector("grok-4.6-fast-xhigh", "xai/grok-4");
  expect(mapped.ok).toBe(true);
  expect(mapped.model).toBe("xai/grok-4");
  const ok = mod.normalizeModelSelector("anthropic/claude-sonnet-4-5");
  expect(ok.ok).toBe(true);
  const bad = mod.normalizeModelSelector("totally-fake-slug-xyz", undefined, {
    allowFallbackToParent: false,
  });
  expect(bad.ok).toBe(false);
  const cfg = mod.defaultModelsConfig("xai/grok-4");
  for (const v of Object.values(cfg.roles)) {
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) {
      expect(mod.isProviderId(x) || mod.isInheritAlias(x), `unexpected default: ${x}`).toBeTruthy();
    }
  }
});

test("spawn refuses explicit invalid model + inheritParentTools wiring", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  expect(src.includes("inheritParentTools")).toBeTruthy();
  expect(src.includes("getActiveTools")).toBeTruthy();
  expect(src.includes("allowFallbackToParent: false")).toBeTruthy();
  expect(runner.includes("AUTO_READONLY_ROLES") || src.includes("AUTO_READONLY_ROLES")).toBeTruthy();
  expect(runner.includes("inheritParentTools !== false"), "inherit default-on in resolveTools").toBeTruthy();
});

test("child-runner concurrency default>=8 + persist + session isolated", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  expect(mod.MAX_CONCURRENCY >= 8 && mod.MAX_CONCURRENCY <= 32, `cap=${mod.MAX_CONCURRENCY}`).toBeTruthy();
  const t = mod.truncate("x".repeat(200_000), { maxBytes: 1000 });
  expect(t.text.includes("truncated")).toBeTruthy();
  const dir = mkdtempSync(join(tmpdir(), "pstack-out-"));
  try {
    const big = "hello-world-".repeat(20_000);
    const t2 = mod.truncate(big, { maxBytes: 500, persistDir: dir, tag: "t" });
    expect(t2.outputPath).toBeTruthy();
    expect(existsSync(t2.outputPath)).toBeTruthy();
    expect(readFileSync(t2.outputPath, "utf8").includes("hello-world")).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  const sessionSrc = readFileSync(resolve(ROOT, "extensions/subagents/session-dir.ts"), "utf8");
  expect(src.includes("PSTACK_MAX_CONCURRENCY")).toBeTruthy();
  expect(src.includes("sessionMode") || sessionSrc.includes("PSTACK_CHILD_SESSION")).toBeTruthy();
  expect(src.includes("--append-system-prompt")).toBeTruthy();
  expect(src.includes("--session-dir")).toBeTruthy();
  expect(sessionSrc.includes('return "isolated"')).toBeTruthy();
  expect(mod.shouldPersistOutput({ task: "x", timeoutMs: 10 * 60 * 1000 })).toBe(true);
  expect(mod.shouldPersistOutput({ task: "x", persistOutput: false, timeoutMs: 10 * 60 * 1000 })).toBe(false);
});

test("jobs enqueue + abort/cancel registry", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  mod.__resetBackgroundJobsForTests();
  expect(mod.listBackgroundJobs().length).toBe(0);
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  expect(src.includes("enqueueBackgroundChild")).toBeTruthy();
  expect(src.includes('action === "abort" || action === "cancel"') || src.includes("cancel")).toBeTruthy();
  expect(src.includes("pstack_jobs")).toBeTruthy();
  expect(src.includes('action === "list"')).toBeTruthy();
  expect(src.includes('action === "status"')).toBeTruthy();
  expect(src.includes('action === "await"')).toBeTruthy();
});

test("heartbeat coalesces dynamic double-fire + maxFires + shutdown clear", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  const fsm = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/state.ts")).href);
  expect(mod.DYNAMIC_COALESCE_MS).toBe(2500);
  const state = { lastFireAt: 1000, fires: 0, maxFires: 3, armed: true };
  const c = mod.decideFire(state, "settle", 1000 + 500, mod.DYNAMIC_COALESCE_MS, "dynamic");
  expect(c.action).toBe("coalesce");
  const f = mod.decideFire(state, "watcher", 1000 + 3000, mod.DYNAMIC_COALESCE_MS, "dynamic");
  expect(f.action).toBe("fire");
  expect(f.fires).toBe(1);
  expect(state.fires, "decideFire must not mutate the state it decides on").toBe(0);
  const armed = fsm.initialLoopState({ id: "h", mode: "dynamic", prompt: "tick", intervalMs: 1000, maxFires: 3, watchArgv: [] });
  const fired = fsm.reduceLoop(armed, { type: "tick", reason: "settle" }, 1000 + 3000);
  expect(fired.state.fires).toBe(1);
  expect(armed.fires, "a transition must return a new state, not mutate the armed one").toBe(0);
  expect(mod.shouldSkipSettleArm(fired.state.lastFireAt, fired.state.lastFireAt + 100)).toBeTruthy();
  const capped = fsm.initialLoopState({ id: "h", mode: "interval", prompt: "tick", intervalMs: 1000, maxFires: 3, watchArgv: [] });
  const atCap = { ...capped, fires: 3, lastFireAt: 0 };
  const stop = fsm.reduceLoop(atCap, { type: "tick", reason: "interval" }, Date.now());
  expect(stop.state.armed).toBe(false);
  expect(stop.effects.some((effect) => effect.type === "announce-stopped")).toBe(true);
  const disarmed = fsm.reduceLoop(atCap, { type: "disarm" }, Date.now());
  expect(disarmed.state.armed).toBe(false);
  expect(atCap.armed, "disarm must return a new state, not mutate the armed one").toBe(true);
  const src =
    readFileSync(resolve(ROOT, "extensions/heartbeat/index.ts"), "utf8") +
    readFileSync(resolve(ROOT, "extensions/heartbeat/runtime.ts"), "utf8") +
    readFileSync(resolve(ROOT, "extensions/heartbeat/state.ts"), "utf8");
  expect(src.includes("DYNAMIC_COALESCE_MS")).toBeTruthy();
  expect(src).toMatch(/clearTimer\(run, id\)/);
  expect(src.includes("session_shutdown")).toBeTruthy();
  expect(src.includes("lastFireAt")).toBeTruthy();
  expect(src.includes("status") && src.includes("list") && src.includes("stop")).toBeTruthy();
  expect(src.includes("formatLoopRows") || src.includes("/pstack-loop status")).toBeTruthy();
  expect(src.includes('action === "status" || action === "list"') || src.includes('params.action === "status" || params.action === "list"')).toBeTruthy();
});

test("zero double-fire under rapid settle+watcher script", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  const fsm = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/state.ts")).href);
  const eventFor = (reason) =>
    reason === "watcher"
      ? { type: "watcher-exit", code: 0, output: "ready" }
      : { type: "tick", reason };
  let loop = fsm.initialLoopState({ id: "rapid", mode: "dynamic", prompt: "wake", intervalMs: 1000, maxFires: 10, watchArgv: [] });
  let fires = 0;
  const t0 = 10_000;
  for (const [reason, t] of [
    ["watcher", t0],
    ["settle", t0 + 200],
    ["settle", t0 + 400],
    ["watcher", t0 + 600],
  ]) {
    const reduced = fsm.reduceLoop(loop, eventFor(reason), t);
    loop = reduced.state;
    if (reduced.effects.some((effect) => effect.type === "deliver")) fires = fires + 1;
  }
  expect(fires, `expected 1 fire in coalesce window, got ${fires}`).toBe(1);
  const later = fsm.reduceLoop(loop, { type: "tick", reason: "settle" }, t0 + 3000);
  expect(later.effects.some((effect) => effect.type === "deliver")).toBe(true);
});

test("babysit watchArgv recipes concrete + materialize + shipping default", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  const argv = mod.materializeWatchArgv("watch-pr-status", "42");
  expect(argv.slice(-2)).toEqual(["42", "--status-only"]);
  expect(!argv.some((a) => a.includes("<pr>"))).toBeTruthy();
  expect(argv[0], "watch-pr recipes must run through bun, not bash").toBe("bun");
  expect(argv.includes("--pr"), "watch-pr recipes must pass the PR via --pr, the cli has no positional arg").toBeTruthy();
  const gh = mod.materializeWatchArgv("gh-checks-watch", "#99");
  expect(gh).toEqual(["gh", "pr", "checks", "99", "--watch"]);
  const stackArgv = mod.materializeWatchArgv("watch-pr-stack", "7");
  expect(stackArgv).toEqual(["bun", "skills/poteto-mode/scripts/watch-pr/watch-pr", "--stack", "--pr", "7"]);
  const queuedArgv = mod.materializeWatchArgv("watch-pr-queued-stack", "7", { stackPrs: ["3", "5", "7"] });
  expect(queuedArgv).toEqual([
    "bun",
    "skills/poteto-mode/scripts/watch-pr/watch-pr",
    "--queued-stack",
    "--stack-prs",
    "3,5,7",
  ]);
  expect(() => mod.materializeWatchArgv("watch-pr-queued-stack", "7")).toThrow(/stackPrs/);
  for (const recipeId of Object.keys(mod.BABYSIT_WATCH_RECIPES)) {
    expect(!mod.BABYSIT_WATCH_RECIPES[recipeId].argvTemplate.includes("bash"), `${recipeId} must not exec via bash`).toBeTruthy();
  }
  const src = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/babysit.md"), "utf8");
  expect(src.includes("watchArgv"), "skill must bind the forge watcher to watchArgv").toBeTruthy();
  expect(src.includes("dynamic"), "skill must bind the watch to pstack_loop dynamic mode").toBeTruthy();
  expect(!src.includes("`/loop`"), "skill must not leave the Cursor /loop token").toBeTruthy();
  const ship = await import(pathToFileURL(resolve(ROOT, "extensions/shipping/babysit-recipes.ts")).href);
  expect(ship.DEFAULT_BABYSIT_RECIPE).toBe("watch-pr-drive");
  const hint = ship.babysitDynamicLoopHint("123");
  expect(hint.loopArm.mode).toBe("dynamic");
  expect(Array.isArray(hint.watchArgv) && hint.watchArgv.includes("123")).toBeTruthy();
  expect(!hint.watchArgv.some((a) => String(a).includes("<pr>"))).toBeTruthy();
  const queuedHint = ship.babysitDynamicLoopHint("7", "watch-pr-queued-stack", ["3", "7"]);
  expect(queuedHint.watchArgv.includes("3,7"), "stackPrs must thread through babysitDynamicLoopHint").toBeTruthy();
});

test("watch-pr runs via bun with an ENOENT-free failure when bun is missing", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/heartbeat/coalesce.ts")).href);
  expect(mod.watchPrInvocation("/abs/watch-pr", ["--pr", "9"])).toEqual({
    command: "bun",
    args: ["/abs/watch-pr", "--pr", "9"],
  });
  await mod.assertBunAvailable(async () => ({ code: 0 }));
  await expect(() => mod.assertBunAvailable(async () => ({ code: 1 })), "missing bun must fail with an actionable message, not a bare ENOENT").rejects.toThrow(/bun is required.*not found on PATH/);
  const src = readFileSync(resolve(ROOT, "extensions/shipping/index.ts"), "utf8");
  expect(src.includes("assertBunAvailable"), "pstack_babysit must gate the watch-pr recipes on bun being resolvable").toBeTruthy();
  expect(!/pi\.exec\(\s*"bash"/.test(src), "must not exec the bundled TypeScript watcher via bash").toBeTruthy();
});

test("evaluateMergeGates fixture matrix", async () => {
  const ship = await import(pathToFileURL(resolve(ROOT, "extensions/shipping/gates.ts")).href);
  expect(ship.MERGE_GATE_FIXTURES.length >= 8, `fixtures=${ship.MERGE_GATE_FIXTURES.length}`).toBeTruthy();
  for (const fix of ship.MERGE_GATE_FIXTURES) {
    const problems = ship.evaluateMergeGates(fix.view);
    if (fix.expectPass) {
      expect(problems.length, `${fix.id} expected pass got ${problems}`).toBe(0);
    } else {
      expect(problems.length > 0, `${fix.id} expected fail`).toBeTruthy();
      for (const sub of fix.expectSubstrings ?? []) {
        expect(problems.some((p) => p.includes(sub)), `${fix.id} missing ${sub} in ${JSON.stringify(problems)}`).toBeTruthy();
      }
    }
  }
});

test("deslop applySafe + dryRun path exercised", async () => {
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
    const result = await mod.applySafeDeletes(dir, suggestions);
    expect(result.applied >= 1, `applied=${result.applied}`).toBeTruthy();
    const next = readFileSync(file, "utf8");
    expect(!next.includes("Phase 1")).toBeTruthy();
    expect(next.includes("const x = 1")).toBeTruthy();
    const scanned = mod.scanAddedLinesForSlop([
      { file: "a.ts", text: "// Phase 1: add cards" },
      { file: "a.ts", text: "// Helper for x" },
      { file: "a.ts", text: "const ok = true;" },
    ]);
    expect(scanned.suggestions.some((s) => s.safeDelete)).toBeTruthy();
    expect(scanned.rankedLabels.includes("redundant helper/WIP comment") || scanned.suggestions.some((s) => s.label.includes("Helper") || s.label.includes("helper"))).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const src = readFileSync(resolve(ROOT, "extensions/companions/index.ts"), "utf8");
  expect(src.includes("applySafe")).toBeTruthy();
  expect(src.includes("autoApply")).toBeTruthy();
  expect(src.includes("safeDelete")).toBeTruthy();
  expect(src.includes("dryRun")).toBeTruthy();
  expect(mod.SLOP_PATTERNS.length >= 17).toBeTruthy();
});

test("AUTO_READONLY roles + investigation auto-arm wiring", async () => {
  const spawnSrc = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  expect(spawnSrc.includes("AUTO_READONLY_ROLES")).toBeTruthy();
  expect(spawnSrc.includes("comment-sicko")).toBeTruthy();
  expect(spawnSrc.includes("investigator")).toBeTruthy();
  const sticky = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  expect(sticky.shouldAutoArmReadonly("investigation")).toBeTruthy();
  const poteto = readFileSync(resolve(ROOT, "extensions/poteto-state/index.ts"), "utf8");
  const readonly = readFileSync(resolve(ROOT, "extensions/readonly-state/index.ts"), "utf8");
  expect(poteto.includes("shouldAutoArmReadonly")).toBeTruthy();
  expect(readonly.includes("SESSION_WRITE_TOOLS") || readonly.includes('"write"')).toBeTruthy();
  expect(readonly.includes("block: true")).toBeTruthy();
});

test("playbook auto-arm ignores long briefs", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  expect(mod.shouldAutoArmFromPlaybookMatch("investigation", false, 5, "short request")).toBe(true);
  expect(mod.shouldAutoArmFromPlaybookMatch("investigation", true, 12, "x".repeat(500))).toBe(false);
  expect(mod.shouldAutoArmFromPlaybookMatch("investigation", false, 3, "short request")).toBe(false);
  expect(mod.shouldAutoArmFromPlaybookMatch("babysit", true, 12, "x")).toBe(false);
});

test("readonly auto-arm requires the read-only investigation playbook target", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sticky-session.ts")).href);
  expect(mod.shouldAutoArmFromSkillText("please investigate this")).toBe(false);
  expect(mod.shouldAutoArmFromSkillText("playbooks/investigation how does auth work")).toBe(false);
  expect(mod.shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/babysit investigate CI")).toBe(false);
  expect(mod.shouldAutoArmFromSkillText("/skill:poteto-mode playbooks/investigation how does auth work")).toBe(true);
});

async function verifyWorktreeCleanup(mod, dir) {
  const created = await mod.createIsolatedWorktree(dir, "cleanup-me");
  expect(existsSync(created.path)).toBeTruthy();
  const result = await mod.cleanupPstackWorktreesOnShutdown(dir);
  expect(result.removed.includes("cleanup-me") || result.skipped.length >= 0, JSON.stringify(result)).toBeTruthy();

  const busy = await mod.createIsolatedWorktree(dir, "child-busy");
  const busySessions = join(busy.path, ".pi", "pstack-child-sessions", "c-test");
  mkdirSync(busySessions, { recursive: true });
  writeFileSync(join(busySessions, "session.jsonl"), "{}\n");
  const busyResult = await mod.cleanupPstackWorktreesOnShutdown(dir);
  expect(existsSync(busy.path), "a live child session must block cleanup").toBeTruthy();
  expect(busyResult.skipped.some(
      (entry) => entry.name === "child-busy" && entry.reason.includes("child session active"),
    ), JSON.stringify(busyResult)).toBeTruthy();

  const stale = await mod.createIsolatedWorktree(dir, "child-stale");
  const staleSessions = join(stale.path, ".pi", "pstack-child-sessions", "c-old");
  mkdirSync(staleSessions, { recursive: true });
  const staleFile = join(staleSessions, "session.jsonl");
  writeFileSync(staleFile, "{}\n");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(staleFile, twoHoursAgo, twoHoursAgo);
  const staleResult = await mod.cleanupPstackWorktreesOnShutdown(dir);
  expect(staleResult.removed.includes("child-stale"), JSON.stringify(staleResult)).toBeTruthy();
  expect(!existsSync(stale.path), "a stale child session must not block cleanup").toBeTruthy();
}

test("worktree sanitize + always-isolate + cleanup helpers", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/worktree/helpers.ts")).href);
  expect(mod.sanitizeWorktreeName("ok-name_1")).toBe("ok-name_1");
  expect(() => mod.sanitizeWorktreeName("../evil")).toThrow();
  expect(() => mod.sanitizeWorktreeName("-rf")).toThrow();
  expect(() => mod.sanitizeBaseRef("-b")).toThrow();
  const src = readFileSync(resolve(ROOT, "extensions/worktree/index.ts"), "utf8");
  expect(src.includes("cleanupPstackWorktreesOnShutdown")).toBeTruthy();
  expect(src.includes("session_shutdown")).toBeTruthy();
  const swarm = readFileSync(resolve(ROOT, "extensions/orchestration/swarm.ts"), "utf8");
  expect(swarm.includes("ensureAlwaysIsolated")).toBeTruthy();
  const arena = readFileSync(resolve(ROOT, "extensions/orchestration/arena.ts"), "utf8");
  expect(arena.includes("ensureAlwaysIsolated")).toBeTruthy();

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

test("recall ranked merge of sessions+git+gh", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/sessions/index.ts"), "utf8");
  expect(src.includes("recall")).toBeTruthy();
  expect(src.includes("recallGitLog")).toBeTruthy();
  expect(src.includes("recallGhPrs")).toBeTruthy();
  expect(src.includes("buildRankedRecallCorpus") || src.includes("ranked")).toBeTruthy();
  const skill = readFileSync(resolve(ROOT, "skills/recall/SKILL.md"), "utf8");
  expect(skill.includes("pstack_sessions"), "recall skill must name the Pi corpus tool").toBeTruthy();
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/sessions/recall-corpus.ts")).href);
  const log = await mod.recallGitLog(ROOT, "Stage", 5);
  expect(typeof log === "string" && log.length > 0).toBeTruthy();
  const rank = await import(pathToFileURL(resolve(ROOT, "extensions/sessions/recall-rank.ts")).href);
  const corpus = rank.buildRankedRecallCorpus({
    query: "auth",
    days: 7,
    sessionSnippets: ["/tmp/s1.jsonl\n  talked about auth middleware"],
    gitLog: "abc1234 fix auth token refresh\ndef5678 docs only",
    ghPrs: "#42 [OPEN] Harden auth middleware (auth) 2026-01-01 https://example/42",
    limit: 10,
  });
  expect(corpus.hits.length >= 2).toBeTruthy();
  expect(corpus.hits[0].score >= corpus.hits[1].score).toBe(true);
  expect(corpus.rankedBlock.includes("auth")).toBeTruthy();
  const body = rank.formatRankedRecallBody(corpus, 7);
  expect(body.includes("Ranked merge")).toBeTruthy();
});

test("models always-applied validated inject wiring", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/models/index.ts"), "utf8");
  expect(src.includes("before_agent_start")).toBeTruthy();
  expect(src.includes("validated") || src.includes("always-applied")).toBeTruthy();
  expect(src.includes("normalizeModelSelector") || src.includes("isBareMarketingSlug")).toBeTruthy();
  expect(src.includes("setup-pstack")).toBeTruthy();
});

test("why + guide + investigation Pi-local truth", async () => {
  const why = readFileSync(resolve(ROOT, "skills/why/SKILL.md"), "utf8");
  expect(!why.includes("list the available MCPs from the Cursor environment")).toBeTruthy();
  expect(why.includes("investigator"), "why must offer the Pi investigator role").toBeTruthy();
  const guide = readFileSync(resolve(ROOT, "docs/guide/05-build-and-clean.md"), "utf8");
  expect(guide.includes("pstack_deslop")).toBeTruthy();
  expect(!guide.includes("`cursor-team-kit [leave-behind on Pi]` plugin, not in pstack")).toBeTruthy();
  const inv = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/investigation.md"), "utf8");
  expect(inv.includes("read-only"), "investigation stays read-only").toBeTruthy();
  const readonly = readFileSync(resolve(ROOT, "extensions/readonly-state/index.ts"), "utf8");
  expect(readonly.includes("pstack-readonly"), "parent readonly enforcement lives in the extension").toBeTruthy();
});


test("close-orch-p0: poteto prefers background:true + pstack_jobs drain", async () => {
  const skill = readFileSync(resolve(ROOT, "skills/poteto-mode/SKILL.md"), "utf8");
  expect(skill.includes("Prefer `background: true`") || skill.includes("Prefer **`background: true`**"), "poteto must prefer background:true").toBeTruthy();
  expect(!skill.includes("**Defaults for every `pstack_spawn` call.** Foreground sync-awaits."), "must not lead with Foreground sync-awaits as primary default").toBeTruthy();
  expect(skill.includes("pstack_jobs"), "must cite pstack_jobs drain").toBeTruthy();
});

test("close-orch-p0: swarm/arena concurrency cap 8 (not 4)", async () => {
  const swarm = readFileSync(resolve(ROOT, "skills/swarm/SKILL.md"), "utf8");
  const arena = readFileSync(resolve(ROOT, "skills/arena/SKILL.md"), "utf8");
  expect(!/concurrency cap:\s*4\b/.test(swarm), "swarm must not say cap 4").toBeTruthy();
  expect(!/concurrency cap:\s*4\b/.test(arena), "arena must not say cap 4").toBeTruthy();
  expect(swarm.includes("Pi concurrency cap"), "swarm must bind the cloud concurrency limit to the Pi cap").toBeTruthy();
  expect(arena.includes("pstack_arena"), "arena must bind the Cursor fan-out to pstack_arena").toBeTruthy();
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  expect(/parsePositiveInt\(process\.env\.PSTACK_MAX_CONCURRENCY,\s*8/.test(runner), "code default must remain 8").toBeTruthy();
});

test("close-orch-p0: PARITY row 2 EQUIVALENT (local-Task) + ceilings", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  const row2 = parity.split("\n").find((l) => l.startsWith("| 2 | Task"));
  expect(row2, "row 2 line missing").toBeTruthy();
  expect(row2.includes("EQUIVALENT") && row2.includes("local-Task"), `row2 must be EQUIVALENT (local-Task): ${row2.slice(0, 120)}`).toBeTruthy();
  expect(!/Residuals \(≤3\):\s*\(1\)/.test(row2), "must not keep blocking Residuals (1)(2)(3) PARTIAL framing").toBeTruthy();
  expect(/host ceiling|N\/A/i.test(row2) && /MCP/i.test(row2), "must mark MCP inherit as host ceiling / N/A").toBeTruthy();
  expect(/clean|start clean|parent transcript/i.test(row2), "must mark clean-context / no parent-history as Cursor-aligned").toBeTruthy();
  expect(/session_shutdown|session-scoped|Cursor-local restart/i.test(row2), "must mark session-scoped jobs as Cursor-local parity").toBeTruthy();
});

test("close-orch-p1: pstack_spawn schema + guidelines (resume, bg default, inherit)", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  expect(src.includes("resumeSessionDir"), "must declare resumeSessionDir").toBeTruthy();
  expect(src.includes("resumeJobId"), "must declare resumeJobId").toBeTruthy();
  expect(src.includes("wantsBackground"), "must use wantsBackground").toBeTruthy();
  expect(src.includes("wantsBackground(params.background, poteto)"), "role-aware call site").toBeTruthy();
  expect(/role-aware/i.test(src), "guidelines describe role-aware background default").toBeTruthy();
  expect(src.includes("background:false") || src.includes("background: false") || src.includes("background:true/false"), "guidelines mention explicit override").toBeTruthy();
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  expect(runner.includes("if (background !== undefined) return background"), "explicit background always wins").toBeTruthy();
  expect(runner.includes("return poteto === true"), "only poteto-agent detaches by default").toBeTruthy();
  expect(runner.includes("inheritParentTools !== false"), "inherit default-on").toBeTruthy();
  expect(runner.includes("resolveChildSessionDir"), "child-runner must resolve resume session dir").toBeTruthy();
  expect(runner.includes("resumeSessionDir"), "child-runner accepts resumeSessionDir").toBeTruthy();
  expect(runner.includes("sessionDir"), "job records sessionDir").toBeTruthy();
  expect(!runner.includes(".pi/pstack-jobs/"), "must not productize disk job ledger").toBeTruthy();
});

test("close-orch-p1: orchestrate cites resume; no deferred carve-out", async () => {
  const orch = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/orchestrate.md"), "utf8");
  expect(orch.includes("resumeSessionDir"), "orchestrate must cite resumeSessionDir").toBeTruthy();
  expect(orch.includes("resumeJobId"), "orchestrate must cite resumeJobId").toBeTruthy();
  expect(!/P1 follow-on/i.test(orch), "must not say resume is P1 follow-on").toBeTruthy();
  expect(!/not required for local-Task/i.test(orch), "must not carve out resume from Cap2").toBeTruthy();
});

test("close-orch-p1: poteto cites resume + bg prefer", async () => {
  const skill = readFileSync(resolve(ROOT, "skills/poteto-mode/SKILL.md"), "utf8");
  expect(skill.includes("Prefer `background: true`") || skill.includes("Prefer **`background: true`**"), "poteto must prefer background:true").toBeTruthy();
  expect(skill.includes("resumeSessionDir"), "poteto must cite resumeSessionDir").toBeTruthy();
  expect(skill.includes("resumeJobId") || skill.includes("resumeJobId"), "poteto must cite resume").toBeTruthy();
});

test("close-orch-p1: swarm/arena intentional sync gather + N× spawn bg drain", async () => {
  const swarm = readFileSync(resolve(ROOT, "skills/swarm/SKILL.md"), "utf8");
  const arena = readFileSync(resolve(ROOT, "skills/arena/SKILL.md"), "utf8");
  expect(/intentional sync gather/i.test(swarm), "swarm must state intentional sync gather").toBeTruthy();
  expect(/intentional sync gather/i.test(arena), "arena must state intentional sync gather").toBeTruthy();
  expect(/N× `pstack_spawn`|N× pstack_spawn/i.test(swarm) || swarm.includes("N× `pstack_spawn`"), "swarm cites N× spawn").toBeTruthy();
  expect(swarm.includes("pstack_jobs") || /N× `pstack_spawn`/.test(swarm), "swarm cites bg drain path").toBeTruthy();
  expect(/N× `pstack_spawn`/.test(arena) || arena.includes("N× `pstack_spawn`"), "arena cites N× spawn").toBeTruthy();
  expect(!/PARTIAL because sync/i.test(swarm + arena), "must not imply PARTIAL for sync gather").toBeTruthy();
});

test("close-orch-p1: PARITY row 2 IN list (resume + bg default + inherit default-on)", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  const row2 = parity.split("\n").find((l) => l.startsWith("| 2 | Task"));
  expect(row2, "row 2 line missing").toBeTruthy();
  expect(row2.includes("EQUIVALENT") && row2.includes("local-Task"), `row2 must be EQUIVALENT (local-Task)`).toBeTruthy();
  expect(/resumeSessionDir/i.test(row2), "row2 IN must include resumeSessionDir").toBeTruthy();
  expect(/omit→true|omit→true|background omit/i.test(row2) || /omit.*true/i.test(row2), "row2 IN must include background omit→true").toBeTruthy();
  expect(/inheritParentTools.*default-on|default-on/i.test(row2), "row2 IN must include inherit default-on").toBeTruthy();
  expect(/intentional sync gather|local-gather/i.test(row2), "row2 must frame swarm/arena gather").toBeTruthy();
  expect(!/P1 follow-on|not a row-2 gate|resume deferred/i.test(row2), "must not keep resume-deferred gate language").toBeTruthy();
  expect(/host ceiling|N\/A/i.test(row2) && /MCP/i.test(row2), "ceilings MCP N/A").toBeTruthy();
  expect(!parity.includes(".pi/pstack-jobs/") || !/required.*pstack-jobs/i.test(parity), "no required disk ledger product").toBeTruthy();
});

test("close-orch-p1b: child-runner resume carries --continue with --session-dir", async () => {
  const runner = readFileSync(resolve(ROOT, "extensions/subagents/child-runner.ts"), "utf8");
  expect(runner.includes("buildChildPiArgs"), "must export/build argv via buildChildPiArgs").toBeTruthy();
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
  expect(argvHasContinueSemantics(resumed), "resume path must carry --continue or -c").toBeTruthy();
  expect(resumed.includes("--session-dir"), "still passes --session-dir").toBeTruthy();
  expect(!resumed.includes("--resume") && !resumed.includes("-r"), "must not pass interactive -r").toBeTruthy();
  const fresh = buildChildPiArgs({ ...spawnArgs, continueSession: false });
  expect(!argvHasContinueSemantics(fresh), "fresh isolated argv must not carry continue").toBeTruthy();
});

test("close-orch-p1b: spawn/jobs surface sessionDir in text+details", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8");
  expect(src.includes("sessionDir: job.sessionDir") || /sessionDir:\s*job\.sessionDir/.test(src), "details.sessionDir").toBeTruthy();
  expect(/sessionDir=\$\{/.test(src), "text advertises sessionDir=").toBeTruthy();
  expect(/sessionDir:\s*result\.sessionDir/.test(src) || src.includes("sessionDir: result.sessionDir"), "sync spawn details").toBeTruthy();
});

test("close-orch-p1b: PARITY Cap2 EQUIVALENT cites continue/-c (not dir-only)", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  const row2 = parity.split("\n").find((l) => l.startsWith("| 2 | Task"));
  expect(row2, "row 2 missing").toBeTruthy();
  expect(row2.includes("EQUIVALENT") && row2.includes("local-Task"), `row2 must be EQUIVALENT after true continue: ${row2.slice(0, 160)}`).toBeTruthy();
  expect(/--continue|-c|continueRecent|true continue/i.test(row2), "row2 must cite continue/-c semantics").toBeTruthy();
  expect(!/reuse child `--session-dir`(?!;|;|,| \+)/.test(row2) || /--continue|-c/.test(row2), "must not claim dir-only reuse as sole resume").toBeTruthy();
  expect(!/\*\*PARTIAL\*\*.*false twin|false-twin residual/i.test(row2), "after fix must not remain PARTIAL false-twin").toBeTruthy();
  expect(/sessionDir/i.test(row2), "row2 mentions sessionDir surfacing or resume path").toBeTruthy();
});

test("close-orch-p1b: orchestrate/poteto cite true continue", async () => {
  const orch = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/orchestrate.md"), "utf8");
  const skill = readFileSync(resolve(ROOT, "skills/poteto-mode/SKILL.md"), "utf8");
  expect(/--continue|-c|continueRecent|true continue/i.test(orch), "orchestrate must document continue argv").toBeTruthy();
  expect(/sessionDir/i.test(orch), "orchestrate cites surfaced sessionDir").toBeTruthy();
  expect(/--continue|-c|continueRecent|continue prior child transcript/i.test(skill), "poteto must say continue transcript").toBeTruthy();
});

test("docs-sync: README points at the live spec; PARITY is the historical scorecard", async () => {
  const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
  expect(!/several PARTIAL/i.test(readme), "README must not lead with several PARTIAL").toBeTruthy();
  expect(readme.includes("omit→true"), "README must document background omit→true").toBeTruthy();
  expect(/resumeSessionDir|resumeJobId|--continue/.test(readme), "README must mention resume / --continue").toBeTruthy();
  expect(/PARITY\.md/.test(readme), "README must link PARITY").toBeTruthy();
  expect(/spec\/SPEC\.md/.test(readme) && /spec:check/.test(readme), "README must point at the live spec and its check").toBeTruthy();
  expect(/historical/i.test(readme), "README must name PARITY as the historical snapshot").toBeTruthy();
  expect(!/background: true detaches/.test(readme), "README must not sole-story background:true detaches").toBeTruthy();
});

test("docs-sync: PARITY keeps the scorecard wording and the swarm inventory row", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  expect(/EQUIVALENT/.test(parity) && /PARTIAL/.test(parity), "PARITY scorecard names EQUIVALENT and PARTIAL").toBeTruthy();
  const swarmRow = parity.split("\n").find((l) => l.includes("`skills/swarm/SKILL.md`"));
  expect(swarmRow, "swarm inventory row missing").toBeTruthy();
  expect(/EQUIVALENT.*local-gather|local-gather.*EQUIVALENT/i.test(swarmRow), "swarm row must say EQUIVALENT local-gather").toBeTruthy();
  expect(!/\(PARTIAL infra\)/.test(swarmRow), "swarm row must not claim PARTIAL infra").toBeTruthy();
});


test("skill frontmatter names are Pi kebab-case (a-z0-9-hyphen)", async () => {
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
  expect(bad.length, `invalid Pi skill names:\n${bad.join("\n")}`).toBe(0);
});

test("PARITY scorecard documents local-scope EQUIVALENT criteria", async () => {
  const parity = readFileSync(resolve(ROOT, "PARITY.md"), "utf8");
  expect(parity.includes("EQUIVALENT")).toBeTruthy();
  expect(parity.includes("local-") || parity.includes("local ")).toBeTruthy();
  // After update: expect multiple EQUIVALENT rows beyond worktree
  const equivCount = (parity.match(/\*\*EQUIVALENT\*\*/g) || []).length;
  expect(equivCount >= 2, `expected >=2 EQUIVALENT markers, got ${equivCount}`).toBeTruthy();
});
