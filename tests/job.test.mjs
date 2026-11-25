import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readJob } from "../scripts/job-input.ts";

const runner = fileURLToPath(new URL("../scripts/run-job.mjs", import.meta.url));
const report = { channel: "C1", thread: "T1", eventId: "E1", type: "report", topLevel: true };

async function fixture(t, kind = "benny-triage") {
  const dir = await mkdtemp(join(tmpdir(), "pstack-job-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "fake-pi");
  await writeFile(
    fake,
    `#!/usr/bin/env node
const prompt = require("node:fs").readFileSync(0, "utf8");
console.log(JSON.stringify({args:process.argv.slice(2),prompt,secret:process.env.PSTACK_EVENT_SECRET??null}));
process.exitCode = Number(process.env.PSTACK_TEST_EXIT_CODE ?? 0);
`,
    { mode: 0o700 },
  );
  const job = join(dir, "job.json");
  const event = join(dir, "event.json");
  const secret = "test-secret";
  const config = {
    enabled: true,
    slackChannel: "C1",
    tracker: "tracker",
    repository: "repo",
    featureMap: "map",
    controlAdapter: "adapter",
    allowDraftPr: false,
  };
  const enabled = {
    version: 1,
    enabled: true,
    kind,
    cwd: dir,
    tools: ["read", "mcp__slack__read_thread"],
    instructions: "test",
    config,
  };
  const run = (exitCode = 0, bin = fake) =>
    spawnSync(process.execPath, [runner, "--run", job, event], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PSTACK_PI_BIN: bin,
        PSTACK_EVENT_SECRET: secret,
        PSTACK_TEST_EXIT_CODE: String(exitCode),
      },
    });
  const signed = (payload) => ({
    payload,
    signature: createHmac("sha256", secret).update(payload).digest("hex"),
  });
  await writeFile(job, JSON.stringify(enabled));
  return {
    job,
    event,
    enabled,
    config,
    run,
    writeSigned: (value) => writeFile(event, JSON.stringify(signed(JSON.stringify(value)))),
    runs: join(dir, "runs"),
  };
}

void test("unsupported job shapes fail before claiming a run", async (t) => {
  const { job, enabled, run, runs } = await fixture(t);
  for (const invalid of [
    null,
    { ...enabled, enabled: false },
    { ...enabled, cwd: 123 },
    { ...enabled, model: [] },
    { ...enabled, tools: ["-read"] },
  ]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each case rewrites this fixture before dispatch.
    await writeFile(job, JSON.stringify(invalid));
    assert.match(run().stderr, /Job must be reviewed/);
  }
  await writeFile(job, '{"password":"not-for-stderr"');
  const result = run();
  assert.match(result.stderr, /Invalid JSON in job file/);
  assert.doesNotMatch(result.stderr, /not-for-stderr/);
  await assert.rejects(() => readdir(runs), { code: "ENOENT" });
});

void test("Benny refuses disabled config or broad tools before dispatch", async (t) => {
  const { job, enabled, config, run } = await fixture(t);
  const cases = [
    { override: { config: { ...config, enabled: false } }, message: /incomplete or disabled/ },
    { override: { tools: ["read"] }, message: /requires explicit scoped MCP/ },
    { override: { tools: ["bash", "mcp__slack__read_thread"] }, message: /narrow native file/ },
    ...[
      "mcp__slack__delete_thread",
      "mcp__gh__pr_squash",
      "mcp__github__push_files",
      "mcp__github__create_or_update_file",
      "mcp__github__update_pull_request_branch",
      "mcp__github__create_branch",
      "mcp__github__mergePullRequest",
      "mcp__github__PRMerge",
      "mcp__codemode__run",
      "mcp__pi__tool_search",
      "mcp__pi__searchTools",
      "mcp__x__run_command",
      "mcp__x__runScript",
      "mcp__x__bash",
    ].map((tool) => ({
      override: { tools: ["read", tool] },
      message: /disallows general command execution/,
    })),
    ...["write", "edit"].map((tool) => ({
      override: { tools: [tool, "mcp__slack__read_thread"] },
      message: /triage is read-only/,
    })),
    ...["mcp__github__create_pull_request", "mcp__gh__createPullRequest"].map((tool) => ({
      override: { tools: ["read", tool] },
      message: /require benny-repro with allowDraftPr/,
    })),
  ];
  for (const { override, message } of cases) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each case rewrites this fixture before dispatch.
    await writeFile(job, JSON.stringify({ ...enabled, ...override }));
    assert.match(run().stderr, message);
  }
});

void test("Benny accepts read and comment tools, and draft PR tools only when authorized", async (t) => {
  const { job, enabled, config } = await fixture(t, "benny-repro");
  const tools = [
    "read",
    "edit",
    "write",
    "mcp__slack__post_message",
    "mcp__github__add_issue_comment",
    "mcp__github__search_issues",
    "mcp__ci__get_workflow_run",
  ];
  await writeFile(job, JSON.stringify({ ...enabled, tools }));
  assert.deepEqual((await readJob(job)).tools, tools);
  const pr = ["read", "mcp__github__create_pull_request"];
  await writeFile(
    job,
    JSON.stringify({ ...enabled, tools: pr, config: { ...config, allowDraftPr: true } }),
  );
  assert.deepEqual((await readJob(job)).tools, pr);
});

void test("triage authenticates and claims one report per thread without leaking the signing secret", async (t) => {
  const { event, run, writeSigned, runs } = await fixture(t);
  await writeFile(
    event,
    JSON.stringify({ payload: JSON.stringify(report), signature: "0".repeat(64) }),
  );
  assert.match(run().stderr, /Event signature rejected/);
  await writeFile(event, "null");
  assert.match(run().stderr, /Invalid signed event envelope/);
  await writeSigned(null);
  assert.match(run().stderr, /immutable thread coordinates/);
  await writeSigned({ ...report, topLevel: false });
  assert.match(run().stderr, /top-level report/);
  await writeSigned(report);
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(await readFile(JSON.parse(first.stdout).log, "utf8"));
  assert.equal(output.secret, null);
  assert(output.args.includes("builtin:mcp"));
  assert(output.args.includes("read,mcp__slack__read_thread"));
  assert(!output.args.includes("--no-skills"));
  assert(!output.args.includes("--no-prompt-templates"));
  await writeSigned({ ...report, eventId: "E2" });
  assert.notEqual(run().status, 0, "duplicate same thread must fail closed");
  assert.equal((await readdir(runs)).length, 1);
});

void test("reproduction requires a confirmed marker and preserves child failure status", async (t) => {
  const { job, enabled, config, run, writeSigned } = await fixture(t, "benny-repro");
  await writeFile(
    job,
    JSON.stringify({ ...enabled, config: { ...config, reproModel: "dev/test" }, thinking: "low" }),
  );
  const marker = {
    ...report,
    type: "triage-marker",
    classification: "bug",
    trusted: true,
    ticket: "BUG-1",
  };
  await writeSigned({ ...marker, trusted: false });
  assert.match(run().stderr, /authenticated confirmed triage marker/);
  await writeSigned(marker);
  const failed = run(7);
  assert.equal(failed.status, 7, failed.stderr);
  const { log, runDir } = JSON.parse(failed.stdout);
  const receipt = JSON.parse(await readFile(join(runDir, "result.json"), "utf8"));
  assert.equal(receipt.status, "exited");
  assert.equal(receipt.code, 7);
  const output = JSON.parse(await readFile(log, "utf8"));
  assert.equal(output.args[output.args.indexOf("--model") + 1], "dev/test");
  assert.equal(output.args[output.args.indexOf("--thinking") + 1], "low");
  assert.match(output.prompt, /BUG-1/);
  assert(output.args.every((arg) => !arg.includes("BUG-1")));
});

void test("a child startup failure does not print the event or the child argument list", async (t) => {
  const { run, writeSigned, runs } = await fixture(t);
  await writeSigned({ ...report, text: "private-report-text" });
  const failed = run(0, join(tmpdir(), "nonexistent-pstack-pi"));
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Unable to start Pi/);
  assert.doesNotMatch(failed.stderr, /private-report-text|spawnargs/);
  const [claim] = await readdir(runs);
  const dir = join(runs, claim);
  const receipt = await readFile(join(dir, "result.json"), "utf8");
  const result = JSON.parse(receipt);
  assert.equal(result.status, "not-started");
  assert.equal(result.code, failed.status);
  assert.equal(result.eventId, report.eventId);
  assert.match(result.error, /ENOENT/);
  assert.equal(JSON.parse(failed.stdout).runDir, dir);
  assert.doesNotMatch(receipt + failed.stdout, /private-report-text|spawnargs|test-secret/);
  assert.match(run().stderr, /EEXIST/);
  assert.equal(await readFile(join(dir, "result.json"), "utf8"), receipt);
});

void test("custom jobs pass Pi's max thinking level through to the child", async (t) => {
  const { job, enabled, run } = await fixture(t, "custom");
  await writeFile(job, JSON.stringify({ ...enabled, tools: ["read"], thinking: "max" }));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const { args } = JSON.parse(await readFile(JSON.parse(result.stdout).log, "utf8"));
  const thinking = args.indexOf("--thinking");
  assert.notEqual(thinking, -1);
  assert.equal(args[thinking + 1], "max");
});

void test("custom jobs need no event and preserve their explicit native tool allowlist", async (t) => {
  const { job, enabled, run, runs } = await fixture(t, "custom");
  await writeFile(job, JSON.stringify({ ...enabled, tools: ["read"], model: "inherit-parent" }));
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const output = JSON.parse(await readFile(JSON.parse(first.stdout).log, "utf8"));
  assert(output.args.includes("--no-mcp"));
  assert(!output.args.includes("--no-skills"));
  assert(!output.args.includes("--no-prompt-templates"));
  assert(!output.args.includes("--model"));
  assert.equal(output.prompt, enabled.instructions);
  assert(!output.args.includes(enabled.instructions));
  assert.equal(run().status, 0);
  assert.equal((await readdir(runs)).length, 2);
});
