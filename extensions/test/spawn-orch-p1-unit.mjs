/**
 * Unit tests for close-orch-p1: resume / background omit→true / inherit default-on.
 * Run via verify-local-partials.mjs or: bun extensions/test/spawn-orch-p1-unit.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function runSpawnOrchP1Units() {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);

  // --- background omit → true ---
  assert.equal(mod.wantsBackground(undefined), true, "omit → background");
  assert.equal(mod.wantsBackground(true), true, "true → background");
  assert.equal(mod.wantsBackground(false), false, "false → sync");

  // --- inheritParentTools default-on ---
  const parent = ["read", "bash", "edit"];
  assert.deepEqual(
    mod.resolveTools("general", {}, parent),
    parent,
    "default-on inherits when tools unset",
  );
  assert.equal(
    mod.resolveTools("general", { inheritParentTools: false }, parent),
    undefined,
    "explicit false disables inherit",
  );
  assert.deepEqual(
    mod.resolveTools("general", { tools: ["read", "grep"] }, parent),
    ["read", "grep"],
    "explicit tools wins",
  );
  assert.deepEqual(
    mod.resolveTools("investigator", {}, parent),
    [...mod.READONLY_TOOLS],
    "readonly role forces READONLY_TOOLS",
  );
  assert.deepEqual(
    mod.resolveTools("comment-sicko", { inheritParentTools: true }, parent),
    [...mod.READONLY_TOOLS],
    "auto-readonly overrides inherit",
  );
  assert.equal(mod.resolveTools("general", {}, undefined), undefined);
  assert.equal(mod.resolveTools("general", {}, []), undefined);

  // --- resumeSessionDir fail closed + mint + resumeJobId ---
  const dir = mkdtempSync(join(tmpdir(), "pstack-resume-"));
  try {
    const good = join(dir, "sess-a");
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "marker"), "ok");

    const resumed = mod.resolveChildSessionDir({ task: "t", resumeSessionDir: good }, dir);
    assert.equal(resumed.sessionMode, "isolated");
    assert.equal(resumed.sessionDir, good);

    const rel = mod.resolveChildSessionDir({ task: "t", resumeSessionDir: "sess-a" }, dir);
    assert.equal(rel.sessionDir, good);

    let threw = false;
    try {
      mod.resolveChildSessionDir({ task: "t", resumeSessionDir: join(dir, "missing-dir") }, dir);
    } catch (e) {
      threw = true;
      assert.match(String(e.message), /missing or unreadable/);
    }
    assert.ok(threw, "missing resume path must fail closed");

    threw = false;
    try {
      mod.resolveChildSessionDir(
        { task: "t", resumeSessionDir: good, sessionMode: "ephemeral" },
        dir,
      );
    } catch (e) {
      threw = true;
      assert.match(String(e.message), /ephemeral/);
    }
    assert.ok(threw, "resume+ephemeral must reject");

    const minted = mod.resolveChildSessionDir({ task: "t" }, dir);
    assert.equal(minted.sessionMode, "isolated");
    assert.ok(minted.sessionDir && minted.sessionDir.includes("pstack-child-sessions"));

    mod.__resetBackgroundJobsForTests();
    mod.__seedBackgroundJobForTests({ id: "bg-test-1", sessionDir: good });
    assert.equal(mod.resolveResumeSessionDirParam({ resumeJobId: "bg-test-1" }), good);
    assert.equal(
      mod.resolveResumeSessionDirParam({ resumeSessionDir: good, resumeJobId: "ignored" }),
      good,
      "explicit resumeSessionDir wins over job id",
    );

    threw = false;
    try {
      mod.resolveResumeSessionDirParam({ resumeJobId: "bg-nope" });
    } catch (e) {
      threw = true;
      assert.match(String(e.message), /unknown/);
    }
    assert.ok(threw, "unknown resumeJobId fails closed");

    threw = false;
    mod.__seedBackgroundJobForTests({ id: "bg-nosess", sessionDir: undefined });
    try {
      mod.resolveResumeSessionDirParam({ resumeJobId: "bg-nosess" });
    } catch (e) {
      threw = true;
      assert.match(String(e.message), /no recorded sessionDir/);
    }
    assert.ok(threw, "job without sessionDir fails closed");

    threw = false;
    try {
      mod.resolveResumeSessionDirParam({ resumeSessionDir: good, sessionMode: "ephemeral" });
    } catch (e) {
      threw = true;
      assert.match(String(e.message), /ephemeral/);
    }
    assert.ok(threw, "resume param + ephemeral rejected");

    mod.__resetBackgroundJobsForTests();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runSpawnOrchP1Units()
    .then(() => {
      console.log("PASS spawn-orch-p1-unit");
    })
    .catch((err) => {
      console.error("FAIL spawn-orch-p1-unit:", err?.message ?? err);
      process.exit(1);
    });
}
