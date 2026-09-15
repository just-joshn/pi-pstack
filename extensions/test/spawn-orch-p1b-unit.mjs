/**
 * Unit tests for close-orch-p1b: true resume continue argv + sessionDir surfacing helpers.
 * Run via verify-local-partials.mjs or: bun extensions/test/spawn-orch-p1b-unit.mjs
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function checkContinueSessionFlags(mod, dir, good) {
  const resumed = mod.resolveChildSessionDir({ task: "t", resumeSessionDir: good }, dir);
  assert.equal(resumed.continueSession, true, "resume must set continueSession");
  assert.equal(resumed.sessionDir, good);

  const minted = mod.resolveChildSessionDir({ task: "t" }, dir);
  assert.equal(minted.continueSession, false, "fresh mint must not continue");
  assert.ok(minted.sessionDir);

  const pre = mod.resolveChildSessionDir({ task: "t", sessionDir: good }, dir);
  assert.equal(pre.continueSession, false, "pre-resolved sessionDir is not resume");
  assert.equal(pre.sessionDir, good);
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
  assert.ok(resumeArgs.includes("--session-dir"), "resume argv needs --session-dir");
  assert.equal(resumeArgs[resumeArgs.indexOf("--session-dir") + 1], good);
  assert.ok(mod.argvHasContinueSemantics(resumeArgs), "resume argv MUST include --continue or -c");
  assert.ok(resumeArgs.includes("--continue") || resumeArgs.includes("-c"));
  assert.ok(!mod.argvIsDirOnlyResume(resumeArgs), "resume argv must NOT be --session-dir alone");
  assert.ok(!resumeArgs.includes("--resume") && !resumeArgs.includes("-r"), "no interactive -r");
  assert.ok(resumeArgs.includes("-p") && resumeArgs.includes("--mode"));
  assert.equal(resumeArgs[resumeArgs.length - 1], "resume brief");

  const dirOnly = ["--mode", "json", "-p", "--model", "m", "--session-dir", good, "prompt"];
  assert.ok(mod.argvIsDirOnlyResume(dirOnly), "dir-only shape detected");
  assert.ok(!mod.argvHasContinueSemantics(dirOnly), "dir-only lacks continue");
  assert.notDeepEqual(
    resumeArgs.filter((a) => a === "--continue" || a === "-c" || a === "--session-dir" || a === good),
    ["--session-dir", good],
    "resume must not collapse to session-dir alone",
  );
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
  assert.ok(freshArgs.includes("--session-dir"), "fresh isolated still has --session-dir");
  assert.ok(!mod.argvHasContinueSemantics(freshArgs), "fresh spawn must NOT include -c/--continue");
  assert.ok(!freshArgs.includes("--resume") && !freshArgs.includes("-r"));

  const eph = mod.buildChildPiArgs({
    selectedModel: "test/model",
    sessionMode: "ephemeral",
    continueSession: false,
    inheritNote: "note",
    prompt: "eph",
  });
  assert.ok(eph.includes("--no-session"));
  assert.ok(!eph.includes("--session-dir"));
  assert.ok(!mod.argvHasContinueSemantics(eph));

  const indexSrc = await import("node:fs").then((fs) =>
    fs.readFileSync(resolve(ROOT, "extensions/subagents/index.ts"), "utf8"),
  );
  assert.ok(
    indexSrc.includes("sessionDir: job.sessionDir") || indexSrc.includes("sessionDir: job.sessionDir,"),
    "spawn/jobs details must include sessionDir",
  );
  assert.ok(/sessionDir=\$\{/.test(indexSrc), "tool text replies must advertise sessionDir=");
  assert.ok(indexSrc.includes("--continue") || indexSrc.includes("--continue/-c"), "spawn docs must cite continue argv");
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


export async function runSpawnOrchP1bUnits() {
  const mod = await import(pathToFileURL(resolve(ROOT, "extensions/subagents/child-runner.ts")).href);
  await runP1bAssertions(mod);
}

if (import.meta.main) {
  runSpawnOrchP1bUnits()
    .then(() => {
      process.stdout.write("PASS spawn-orch-p1b-unit\n");
    })
    .catch((err) => {
      console.error("FAIL spawn-orch-p1b-unit:", err?.message ?? err);
      process.exit(1);
    });
}
