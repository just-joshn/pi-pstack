/**
 * Scripted checks for close-local-partials Stage 2 (no full Pi runtime required).
 * Run: node --experimental-strip-types extensions/test/verify-local-partials.mjs
 *   or: bun extensions/test/verify-local-partials.mjs
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

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
  const body = mod.loadPotetoStickyBody();
  assert.ok(body.includes("Non-negotiables"), "missing Non-negotiables");
  assert.ok(body.length > 500, `sticky body too short (${body.length})`);
  const prompt = mod.buildPotetoStickyPrompt("BASE");
  assert.ok(prompt.startsWith("BASE"));
  assert.ok(prompt.includes("sticky"));
  assert.ok(prompt.includes("Non-negotiables"));
});

await check("index.ts wires sticky + session readonly", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/index.ts"), "utf8");
  assert.ok(src.includes("buildPotetoStickyPrompt"));
  assert.ok(src.includes("pstack-readonly"));
  assert.ok(src.includes("pstack-session-readonly"));
  assert.ok(src.includes('tool_call'));
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

await check("child-runner truncate + persist + concurrency exports", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  assert.ok(mod.MAX_CONCURRENCY >= 1 && mod.MAX_CONCURRENCY <= 32);
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
});

await check("heartbeat coalesces dynamic double-fire", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/heartbeat/index.ts"), "utf8");
  assert.ok(src.includes("DYNAMIC_COALESCE_MS"));
  assert.match(src, /clearTimer\(state\)/);
  assert.ok(src.includes("lastFireAt"));
});

await check("deslop has applySafe + structured suggestions", async () => {
  const src = readFileSync(resolve(ROOT, "extensions/companions/index.ts"), "utf8");
  assert.ok(src.includes("applySafe"));
  assert.ok(src.includes("safeDelete"));
  assert.ok(src.includes("does not require cursor-team-kit") || src.includes("Never require cursor-team-kit"));
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

await check("babysit documents dynamic coalesce + modes", async () => {
  const src = readFileSync(resolve(ROOT, "skills/poteto-mode/playbooks/babysit.md"), "utf8");
  assert.ok(src.includes("dynamic"));
  assert.ok(src.includes("coalesced") || src.includes("2.5"));
  assert.ok(src.includes("interval") && src.includes("watcher") && src.includes("settle"));
});

console.log(failed ? `\n${failed} failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
