/**
 * Unit tests for close-orch-p1b: true resume continue argv + sessionDir surfacing helpers.
 * Run: npx vitest run --project extensions
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function checkContinueSessionFlags(mod, dir, good) {
  const resumed = mod.resolveChildSessionDir({ task: "t", resumeSessionDir: good }, dir);
  expect(resumed.continueSession, "resume must set continueSession").toBe(true);
  expect(resumed.sessionDir).toBe(good);

  const minted = mod.resolveChildSessionDir({ task: "t" }, dir);
  expect(minted.continueSession, "fresh mint must not continue").toBe(false);
  expect(minted.sessionDir).toBeTruthy();

  const pre = mod.resolveChildSessionDir({ task: "t", sessionDir: good }, dir);
  expect(pre.continueSession, "pre-resolved sessionDir is not resume").toBe(false);
  expect(pre.sessionDir).toBe(good);
}

function checkResumeArgvAndDirOnly(mod, good) {
  const resumeArgs = mod.buildChildPiArgs({
    selectedModel: "test/model",
    sessionMode: "isolated",
    sessionDir: good,
    continueSession: true,
    inheritNote: "note",
    prompt: "resume brief",
  });
  expect(resumeArgs.includes("--session-dir"), "resume argv needs --session-dir").toBeTruthy();
  expect(resumeArgs[resumeArgs.indexOf("--session-dir") + 1]).toBe(good);
  expect(mod.argvHasContinueSemantics(resumeArgs), "resume argv MUST include --continue or -c").toBeTruthy();
  expect(resumeArgs.includes("--continue") || resumeArgs.includes("-c")).toBeTruthy();
  expect(!mod.argvIsDirOnlyResume(resumeArgs), "resume argv must NOT be --session-dir alone").toBeTruthy();
  expect(!resumeArgs.includes("--resume") && !resumeArgs.includes("-r"), "no interactive -r").toBeTruthy();
  expect(resumeArgs.includes("-p") && resumeArgs.includes("--mode")).toBeTruthy();
  expect(resumeArgs[resumeArgs.length - 1]).toBe("resume brief");

  const dirOnly = ["--mode", "json", "-p", "--model", "m", "--session-dir", good, "prompt"];
  expect(mod.argvIsDirOnlyResume(dirOnly), "dir-only shape detected").toBeTruthy();
  expect(!mod.argvHasContinueSemantics(dirOnly), "dir-only lacks continue").toBeTruthy();
  expect(resumeArgs.filter((a) => a === "--continue" || a === "-c" || a === "--session-dir" || a === good), "resume must not collapse to session-dir alone").not.toEqual(["--session-dir", good]);
}

async function checkFreshEphemeralAndIndex(mod, dir, good) {
  const minted = mod.resolveChildSessionDir({ task: "t" }, dir);
  const freshArgs = mod.buildChildPiArgs({
    selectedModel: "test/model",
    sessionMode: "isolated",
    sessionDir: minted.sessionDir,
    continueSession: false,
    inheritNote: "note",
    prompt: "fresh brief",
  });
  expect(freshArgs.includes("--session-dir"), "fresh isolated still has --session-dir").toBeTruthy();
  expect(!mod.argvHasContinueSemantics(freshArgs), "fresh spawn must NOT include -c/--continue").toBeTruthy();
  expect(!freshArgs.includes("--resume") && !freshArgs.includes("-r")).toBeTruthy();

  const eph = mod.buildChildPiArgs({
    selectedModel: "test/model",
    sessionMode: "ephemeral",
    continueSession: false,
    inheritNote: "note",
    prompt: "eph",
  });
  expect(eph.includes("--no-session")).toBeTruthy();
  expect(!eph.includes("--session-dir")).toBeTruthy();
  expect(!mod.argvHasContinueSemantics(eph)).toBeTruthy();

  const indexSrc = await import("node:fs").then((fs) =>
    fs.readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8"),
  );
  expect(indexSrc.includes("sessionDir: job.sessionDir") || indexSrc.includes("sessionDir: job.sessionDir,"), "spawn/jobs details must include sessionDir").toBeTruthy();
  expect(/sessionDir=\$\{/.test(indexSrc), "tool text replies must advertise sessionDir=").toBeTruthy();
  expect(indexSrc.includes("--continue") || indexSrc.includes("--continue/-c"), "spawn docs must cite continue argv").toBeTruthy();
}

async function runP1bAssertions(mod) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-p1b-"));
  try {
    const good = join(dir, "sess-resume");
    mkdirSync(good, { recursive: true });

    checkContinueSessionFlags(mod, dir, good);
    checkResumeArgvAndDirOnly(mod, good);
    await checkFreshEphemeralAndIndex(mod, dir, good);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


test("spawn issues --continue with --session-dir only for resumes and documents the argv", async () => {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  await runP1bAssertions(mod);
});
