/**
 * Unit tests for close-orch-p1: resume / role-aware background default / inherit default-on.
 * Run: npx vitest run --project extensions
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function assertBackgroundAndTools(mod) {
  expect(mod.wantsBackground(undefined, false), "omit + non-poteto role → sync").toBe(false);
  expect(mod.wantsBackground(undefined, true), "omit + poteto-agent → background").toBe(true);
  expect(mod.wantsBackground(undefined), "omit with no poteto flag → sync").toBe(false);
  expect(mod.wantsBackground(true, false), "explicit true wins even for non-poteto role").toBe(true);
  expect(mod.wantsBackground(false, true), "explicit false wins even for poteto-agent").toBe(false);

  // --- inheritParentTools default-on ---
  const parent = ["read", "bash", "edit"];
  expect(mod.resolveTools("general", {}, parent), "default-on inherits when tools unset").toEqual(parent);
  expect(mod.resolveTools("general", { inheritParentTools: false }, parent), "explicit false disables inherit").toBe(undefined);
  expect(mod.resolveTools("general", { tools: ["read", "grep"] }, parent), "explicit tools wins").toEqual(["read", "grep"]);
  expect(mod.resolveTools("investigator", {}, parent), "readonly role forces READONLY_TOOLS").toEqual([...mod.READONLY_TOOLS]);
  expect(mod.resolveTools("comment-sicko", { inheritParentTools: true }, parent), "auto-readonly overrides inherit").toEqual([...mod.READONLY_TOOLS]);
  expect(mod.resolveTools("general", {}, undefined)).toBe(undefined);
  expect(mod.resolveTools("general", {}, [])).toBe(undefined);
}

function checkResumeResolve(mod, dir, good) {
  const resumed = mod.resolveChildSessionDir({ task: "t", resumeSessionDir: good }, dir);
  expect(resumed.sessionMode).toBe("isolated");
  expect(resumed.sessionDir).toBe(good);
  expect(resumed.continueSession, "resume sets continueSession").toBe(true);

  const rel = mod.resolveChildSessionDir({ task: "t", resumeSessionDir: "sess-a" }, dir);
  expect(rel.sessionDir).toBe(good);

  let threw = false;
  try {
    mod.resolveChildSessionDir({ task: "t", resumeSessionDir: join(dir, "missing-dir") }, dir);
  } catch (e) {
    threw = true;
    expect(String(e.message)).toMatch(/missing or unreadable/);
  }
  expect(threw, "missing resume path must fail closed").toBeTruthy();

  threw = false;
  try {
    mod.resolveChildSessionDir({ task: "t", resumeSessionDir: good, sessionMode: "ephemeral" }, dir);
  } catch (e) {
    threw = true;
    expect(String(e.message)).toMatch(/ephemeral/);
  }
  expect(threw, "resume+ephemeral must reject").toBeTruthy();
}

function checkMintAndJobs(mod, dir, good) {
  const minted = mod.resolveChildSessionDir({ task: "t" }, dir);
  expect(minted.sessionMode).toBe("isolated");
  expect(minted.sessionDir && minted.sessionDir.includes("pstack-child-sessions")).toBeTruthy();
  expect(minted.continueSession, "fresh mint does not continue").toBe(false);

  mod.__resetBackgroundJobsForTests();
  mod.__seedBackgroundJobForTests({ id: "bg-test-1", sessionDir: good });
  expect(mod.resolveResumeSessionDirParam({ resumeJobId: "bg-test-1" })).toBe(good);
  expect(mod.resolveResumeSessionDirParam({ resumeSessionDir: good, resumeJobId: "ignored" }), "explicit resumeSessionDir wins over job id").toBe(good);

  let threw = false;
  try {
    mod.resolveResumeSessionDirParam({ resumeJobId: "bg-nope" });
  } catch (e) {
    threw = true;
    expect(String(e.message)).toMatch(/unknown/);
  }
  expect(threw, "unknown resumeJobId fails closed").toBeTruthy();
}

function checkJobNoSessionAndEphemeral(mod, good) {
  let threw = false;
  mod.__seedBackgroundJobForTests({ id: "bg-nosess", sessionDir: undefined });
  try {
    mod.resolveResumeSessionDirParam({ resumeJobId: "bg-nosess" });
  } catch (e) {
    threw = true;
    expect(String(e.message)).toMatch(/no recorded sessionDir/);
  }
  expect(threw, "job without sessionDir fails closed").toBeTruthy();

  threw = false;
  try {
    mod.resolveResumeSessionDirParam({ resumeSessionDir: good, sessionMode: "ephemeral" });
  } catch (e) {
    threw = true;
    expect(String(e.message)).toMatch(/ephemeral/);
  }
  expect(threw, "resume param + ephemeral rejected").toBeTruthy();

  mod.__resetBackgroundJobsForTests();
}

async function assertResumeAndMint(mod) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-resume-"));
  try {
    const good = join(dir, "sess-a");
    mkdirSync(good, { recursive: true });
    writeFileSync(join(good, "marker"), "ok");

    checkResumeResolve(mod, dir, good);
    checkMintAndJobs(mod, dir, good);
    checkJobNoSessionAndEphemeral(mod, good);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("spawn defaults the background flag by role and inherits the parent tool list by default", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  await assertBackgroundAndTools(mod);
});

test("resume, mint, and ephemeral session dirs resolve through the child session rules", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  await assertResumeAndMint(mod);
});
