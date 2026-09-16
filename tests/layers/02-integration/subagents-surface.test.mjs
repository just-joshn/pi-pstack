import { expect, test } from "vitest";
import { Check } from "typebox/value";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSession } from "../../support/session.mjs";
import { installChildScript, writeStubChild } from "../../support/pi-host.mjs";
import { MAX_CONCURRENCY } from "../../../extensions/subagents/child-runner.ts";

const STUB_CHILD_SOURCE = [
  "const argv = process.argv;",
  "function flagValue(name) {",
  "  const index = argv.indexOf(name);",
  '  return index >= 0 ? argv[index + 1] : "none";',
  "}",
  'const prompt = argv.at(-1) ?? "";',
  'const has = (name) => argv.includes(name);',
  'const verdict = prompt.includes("VERDICT-ISSUES") ? "ISSUES" : "PASS";',
  'const lines = prompt.includes("BIG-OUTPUT")',
  '  ? ["y".repeat(60000)]',
  "  : [",
  '      "stub-child cwd=" + process.cwd(),',
  '      "stub-child model=" + flagValue("--model"),',
  '      "stub-child tools=" + flagValue("--tools"),',
  '      "stub-child no-session=" + has("--no-session"),',
  '      "stub-child continue=" + (has("--continue") || has("-c")),',
  '      "stub-child session-dir=" + flagValue("--session-dir"),',
  '      "stub-child prompt=" + prompt,',
  "      verdict,",
  "    ];",
  'const text = lines.join("\\n");',
  'const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };',
  'process.stdout.write(JSON.stringify(event) + "\\n");',
  "process.exitCode = 0;",
  "",
].join("\n");

function replyText(reply) {
  return reply.content.map((part) => part.text).join("\n");
}

function surfaceExec(f) {
  const baseCtx = f.session._extensionRunner.createContext();
  return {
    ctx: baseCtx,
    call: (name, params, extras = {}) =>
      f.tool(name).definition.execute(name, params, undefined, extras.onUpdate, extras.ctx ?? baseCtx),
  };
}

async function withStubSurface(run) {
  const root = mkdtempSync(join(tmpdir(), "pstack-subagents-surface-"));
  const restoreArgv = installChildScript(writeStubChild(root, STUB_CHILD_SOURCE));
  try {
    return await withSession(run);
  } finally {
    restoreArgv();
    rmSync(root, { recursive: true, force: true });
  }
}

async function foregroundSpawnScenarios(f, exec) {
  mkdirSync(join(f.tmp.cwd, "nested"), { recursive: true });
  const resumeDir = join(f.tmp.cwd, "prior");
  mkdirSync(resumeDir);

  const ephemeral = await exec.call("pstack_spawn", {
    task: "probe-ephemeral",
    model: "inherit-parent",
    inheritParentTools: false,
    sessionMode: "ephemeral",
    timeoutMs: 5000,
  });
  expect(ephemeral.details.result.exitCode).toBe(0);
  expect(ephemeral.details.result.sessionDir).toBe(undefined);
  expect(typeof ephemeral.details.result.model).toBe("string");
  expect(ephemeral.details.readonly).toBe(false);
  expect(replyText(ephemeral)).toContain("stub-child prompt=probe-ephemeral");
  expect(replyText(ephemeral)).toContain("stub-child tools=none");
  expect(replyText(ephemeral)).toContain("stub-child no-session=true");
  expect(replyText(ephemeral)).toContain("stub-child session-dir=none");

  const isolated = await exec.call("pstack_spawn", {
    task: "probe-isolated",
    model: "inherit-parent",
    sessionMode: "isolated",
    cwd: join(f.tmp.cwd, "nested"),
    resumeSessionDir: resumeDir,
  });
  expect(isolated.details.result.sessionDir).toBe(resumeDir);
  expect(replyText(isolated)).toMatch(/stub-child cwd=.*nested/);
  expect(replyText(isolated)).toMatch(/stub-child tools=\S+/);
  expect(replyText(isolated)).toContain("stub-child no-session=false");
  expect(replyText(isolated)).toContain("stub-child continue=true");
  expect(replyText(isolated)).toContain(`stub-child session-dir=${resumeDir}`);

  const bogus = await exec.call("pstack_spawn", {
    task: "probe-bogus",
    model: "inherit-parent",
    sessionMode: "bogus",
  });
  expect(typeof bogus.details.result.sessionDir).toBe("string");
  expect(replyText(bogus)).toContain("stub-child no-session=false");
  expect(replyText(bogus)).toContain("stub-child continue=false");
}

async function foregroundReadonlyScenario(exec) {
  let updates = [];
  const readonly = await exec.call(
    "pstack_spawn",
    { task: "probe-readonly", model: "inherit-parent", role: "investigator", sessionMode: "ephemeral", background: false },
    { onUpdate: (update) => { updates = [...updates, update.content[0].text]; } },
  );
  expect(updates[0], "the foreground progress update names the readonly child").toContain("(readonly)");
  expect(readonly.details.readonly).toBe(true);
  expect(replyText(readonly)).toContain("stub-child tools=read,grep,find,ls");
}

async function taskScenarios(exec) {
  const task = await exec.call("pstack_task", {
    prompt: "probe-task",
    model: "inherit-parent",
    subagent_type: "general",
    sessionMode: "ephemeral",
    inheritParentTools: false,
  });
  expect(replyText(task)).toContain("### pstack_task (general,");
  expect(replyText(task)).toContain("policy: ");
  expect(task.details.policy).toBeTruthy();
}

async function spawnRefusalScenarios(exec) {
  await expect(() => exec.call("pstack_spawn", { task: "x", model: "gpt-4o" })).rejects.toThrow(/Refused bare model slug/);
  await expect(() =>
    exec.call("pstack_spawn", { task: "x", model: "inherit-parent", resumeJobId: "bg-missing" }),
  ).rejects.toThrow(/resumeJobId unknown: bg-missing/);
  await expect(() =>
    exec.call("pstack_spawn", { task: "x", model: "inherit-parent", resumeSessionDir: "missing-dir" }),
  ).rejects.toThrow(/resumeSessionDir missing or unreadable/);
  const bareCtx = { ...exec.ctx, model: undefined };
  await expect(() => exec.call("pstack_spawn", { task: "x" }, { ctx: bareCtx })).rejects.toThrow(
    "pstack_spawn requires an active parent model",
  );
}

test("pstack_spawn forwards a real child argv across every session/default arm", async () => {
  await withStubSurface(async (f) => {
    const exec = surfaceExec(f);
    await foregroundSpawnScenarios(f, exec);
    await foregroundReadonlyScenario(exec);
  });
});

test("pstack_task and pstack_spawn reject bad model, resume, and missing-context inputs", async () => {
  await withStubSurface(async (f) => {
    const exec = surfaceExec(f);
    await taskScenarios(exec);
    await spawnRefusalScenarios(exec);
  });
});

async function spawnBackgroundJobs(exec) {
  const ephemeral = await exec.call("pstack_spawn", {
    task: "bg-ephemeral",
    model: "inherit-parent",
    sessionMode: "ephemeral",
    inheritParentTools: false,
    background: true,
  });
  const isolated = await exec.call("pstack_spawn", {
    task: "bg-isolated",
    model: "inherit-parent",
    role: "investigator",
    background: true,
  });
  const big = await exec.call("pstack_spawn", {
    task: "BIG-OUTPUT bg-big",
    model: "inherit-parent",
    background: true,
  });
  const abortable = await exec.call("pstack_spawn", {
    task: "bg-abort",
    model: "inherit-parent",
    sessionMode: "ephemeral",
    background: true,
  });
  expect(ephemeral.details.background).toBe(true);
  expect(isolated.details.readonly).toBe(true);
  expect(ephemeral.details.sessionDir).toBe(undefined);
  expect(typeof isolated.details.sessionDir).toBe("string");
  return { ephemeral, isolated, big, abortable };
}

async function abortAndAwait(exec, jobId) {
  const aborted = await exec.call("pstack_jobs", { action: "abort", id: jobId });
  expect(aborted.details.status).toBe("aborted");
  const status = await exec.call("pstack_jobs", { action: "status", id: jobId });
  expect(replyText(status)).toContain(`${jobId} status=aborted`);
  const awaited = await exec.call("pstack_jobs", { action: "await", id: jobId, timeoutMs: 5000 });
  expect(replyText(awaited)).toContain("(no output)");
}

async function jobsListAndStatus(exec, jobs) {
  const listed = await exec.call("pstack_jobs", { action: "list" });
  expect(listed.details.jobs.length).toBe(4);
  expect(replyText(listed)).toContain(`${jobs.abortable.details.jobId} status=`);
  expect(listed.details.concurrency.cap).toBe(MAX_CONCURRENCY);

  await exec.call("pstack_jobs", { action: "await", id: jobs.ephemeral.details.jobId, timeoutMs: 30000 });
  await exec.call("pstack_jobs", { action: "await", id: jobs.isolated.details.jobId, timeoutMs: 30000 });
  await exec.call("pstack_jobs", { action: "await", id: jobs.big.details.jobId, timeoutMs: 30000 });

  const isolatedStatus = await exec.call("pstack_jobs", { action: "status", id: jobs.isolated.details.jobId });
  expect(replyText(isolatedStatus)).toContain("sessionDir=");
  expect(replyText(isolatedStatus)).toContain("exit 0");
  const bigStatus = await exec.call("pstack_jobs", { action: "status", id: jobs.big.details.jobId });
  expect(replyText(bigStatus)).toContain("full=");
  expect(bigStatus.details.job.result.outputPath).toMatch(/pstack-child-output/);
  const doneList = await exec.call("pstack_jobs", { action: "list" });
  expect(replyText(doneList)).toContain("finished=");
  expect(replyText(doneList)).toMatch(/sessionDir=/);
}

async function resumeFromJob(exec, jobs) {
  const resumed = await exec.call("pstack_spawn", {
    task: "probe-resume",
    model: "inherit-parent",
    resumeJobId: jobs.isolated.details.jobId,
    sessionMode: "isolated",
  });
  expect(resumed.details.result.sessionDir).toBe(jobs.isolated.details.sessionDir);
}

test("pstack_spawn background jobs surface through pstack_jobs list, status, await, and abort", async () => {
  await withStubSurface(async (f) => {
    const exec = surfaceExec(f);
    const empty = await exec.call("pstack_jobs", { action: "list" });
    expect(replyText(empty)).toBe(`concurrency 0/${MAX_CONCURRENCY} waiting=0\n(no background jobs)`);

    const jobs = await spawnBackgroundJobs(exec);
    const running = await exec.call("pstack_jobs", { action: "list" });
    expect(running.details.jobs.length, "every detached child stays queryable").toBe(4);
    await abortAndAwait(exec, jobs.abortable.details.jobId);
    await jobsListAndStatus(exec, jobs);

    const cancelled = await exec.call("pstack_jobs", { action: "cancel", id: jobs.ephemeral.details.jobId });
    expect(cancelled.details.id).toBe(jobs.ephemeral.details.jobId);
    await resumeFromJob(exec, jobs);
  });
});

const JOB_REFUSALS = [
  [{ action: "abort" }, "id required for abort"],
  [{ action: "status" }, "id required for status|await"],
  [{ action: "await" }, "id required for status|await"],
  [{ action: "status", id: "ghost" }, "unknown job: ghost"],
  [{ action: "abort", id: "ghost" }, "unknown job: ghost"],
  [{ action: "await", id: "ghost", timeoutMs: 1000 }, "unknown background job: ghost"],
  [{ action: "explode", id: "ghost" }, "action must be list|status|await|abort|cancel"],
];

test.each(JOB_REFUSALS)("pstack_jobs refuses %o with %s", async (params, message) => {
  await withSession(async (f) => {
    await expect(() => surfaceExec(f).call("pstack_jobs", params)).rejects.toThrow(message);
  });
});

test("pstack_swarm and pstack_arena pin their worker and candidate parameter bounds", async () => {
  await withSession(async (f) => {
    const swarm = f.tool("pstack_swarm").definition.parameters;
    const arena = f.tool("pstack_arena").definition.parameters;
    expect(Check(swarm, { workers: [] }), "empty workers fail minItems").toBe(false);
    expect(Check(swarm, { workers: [{ task: "probe" }] }), "one worker is valid").toBe(true);
    expect(Check(swarm, { workers: [{ task: "probe" }], selection: "nope" }), "selection is enum-bounded").toBe(false);
    expect(Check(arena, { prompt: "p", candidates: [] }), "empty candidates fail minItems").toBe(false);
    expect(Check(arena, { prompt: "p", candidates: [{ label: "a" }] }), "one candidate is valid").toBe(true);
    expect(Check(arena, { prompt: "p", candidates: [{ label: "a" }], crossJudge: "yes" }), "crossJudge is boolean-bounded").toBe(false);
  });
});
