/**
 * Regression test: resolveChildSessionDir must mint a unique child session
 * dir per call, even when Date.now() is frozen (millisecond collision) and
 * across many calls in the same process.
 * Run: npx vitest run --project extensions
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function assertMintUnique(mod) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-sessiondir-unique-"));
  const realNow = Date.now;
  try {
    Date.now = () => 1_700_000_000_000;

    const dirs = Array.from({ length: 200 }, (_, i) => {
      const resolved = mod.resolveChildSessionDir({ task: "x" }, dir);
      expect(resolved.sessionMode).toBe("isolated");
      expect(resolved.sessionDir, `call ${i} must mint a sessionDir`).toBeTruthy();
      return resolved.sessionDir;
    });

    const unique = new Set(dirs);
    expect(unique.size, `all 200 minted session dirs must be distinct; got ${unique.size} unique of ${dirs.length}. Sample collisions: ${JSON.stringify(dirs.slice(0, 6))}`).toBe(dirs.length);

    for (const d of dirs) {
      expect(existsSync(d), `minted dir must exist on disk: ${d}`).toBeTruthy();
      expect(statSync(d).isDirectory(), `minted path must be a directory: ${d}`).toBeTruthy();
      const base = basename(d);
      expect(!base.includes("/") && !base.includes("\\"), `minted dir basename must not contain a path separator: ${base}`).toBeTruthy();
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
    expect(resumed.sessionMode).toBe("isolated");
    expect(resumed.sessionDir).toBe(good);
    expect(resumed.continueSession, "resume must set continueSession").toBe(true);

    let threw = false;
    try {
      mod.resolveChildSessionDir({ task: "t", resumeSessionDir: join(dir2, "missing") }, dir2);
    } catch (e) {
      threw = true;
      expect(String(e.message)).toMatch(/missing or unreadable/);
    }
    expect(threw, "resumeSessionDir must fail closed on missing dir").toBeTruthy();

    const eph = mod.resolveChildSessionDir({ task: "t", sessionMode: "ephemeral" }, dir2);
    expect(eph.sessionMode).toBe("ephemeral");
    expect(eph.sessionDir, "ephemeral must not mint a sessionDir").toBe(undefined);
    expect(eph.continueSession).toBe(false);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}

test("minted session dirs stay unique while an explicit resume path is untouched", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  await assertMintUnique(mod);
  await assertResumePathUnaffected(mod);
});
