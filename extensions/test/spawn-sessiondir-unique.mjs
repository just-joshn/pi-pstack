/**
 * Regression test: resolveChildSessionDir must mint a unique child session
 * dir per call, even when Date.now() is frozen (millisecond collision) and
 * across many calls in the same process.
 * Run via verify-local-partials.mjs or: node --experimental-strip-types extensions/test/spawn-sessiondir-unique.mjs
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function assertMintUnique(mod) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-sessiondir-unique-"));
  const realNow = Date.now;
  try {
    Date.now = () => 1_700_000_000_000;

    const dirs = Array.from({ length: 200 }, (_, i) => {
      const resolved = mod.resolveChildSessionDir({ task: "x" }, dir);
      assert.equal(resolved.sessionMode, "isolated");
      assert.ok(resolved.sessionDir, `call ${i} must mint a sessionDir`);
      return resolved.sessionDir;
    });

    const unique = new Set(dirs);
    assert.equal(
      unique.size,
      dirs.length,
      `all 200 minted session dirs must be distinct; got ${unique.size} unique of ${dirs.length}. Sample collisions: ${JSON.stringify(dirs.slice(0, 6))}`,
    );

    for (const d of dirs) {
      assert.ok(existsSync(d), `minted dir must exist on disk: ${d}`);
      assert.ok(statSync(d).isDirectory(), `minted path must be a directory: ${d}`);
      const base = basename(d);
      assert.ok(!base.includes("/") && !base.includes("\\"), `minted dir basename must not contain a path separator: ${base}`);
    }
  } finally {
    Date.now = realNow;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function assertResumePathUnaffected(mod) {
  const dir2 = mkdtempSync(join(tmpdir(), "pstack-sessiondir-resume-"));
  try {
    const good = join(dir2, "sess-a");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(good, { recursive: true });

    const resumed = mod.resolveChildSessionDir({ task: "t", resumeSessionDir: good }, dir2);
    assert.equal(resumed.sessionMode, "isolated");
    assert.equal(resumed.sessionDir, good);
    assert.equal(resumed.continueSession, true, "resume must set continueSession");

    let threw = false;
    try {
      mod.resolveChildSessionDir({ task: "t", resumeSessionDir: join(dir2, "missing") }, dir2);
    } catch (e) {
      threw = true;
      assert.match(String(e.message), /missing or unreadable/);
    }
    assert.ok(threw, "resumeSessionDir must fail closed on missing dir");

    const eph = mod.resolveChildSessionDir({ task: "t", sessionMode: "ephemeral" }, dir2);
    assert.equal(eph.sessionMode, "ephemeral");
    assert.equal(eph.sessionDir, undefined, "ephemeral must not mint a sessionDir");
    assert.equal(eph.continueSession, false);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}

export async function runSpawnSessionDirUniqueTest() {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  await assertMintUnique(mod);
  await assertResumePathUnaffected(mod);
}

if (import.meta.main) {
  runSpawnSessionDirUniqueTest()
    .then(() => {
      process.stdout.write("PASS spawn-sessiondir-unique\n");
    })
    .catch((err) => {
      console.error("FAIL spawn-sessiondir-unique:", err?.message ?? err);
      process.exit(1);
    });
}
