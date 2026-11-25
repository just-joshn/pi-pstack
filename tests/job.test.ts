import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, onTestFinished, test } from "vitest";

import { readJob } from "../scripts/job-input.ts";
import { flag, shaped, spawned } from "./support.ts";

const runner = fileURLToPath(new URL("../scripts/run-job.mjs", import.meta.url));
const report = { channel: "C1", thread: "T1", eventId: "E1", type: "report", topLevel: true };
interface Child {
  args: string[];
  prompt: string;
  secret: string | null;
}
interface Receipt {
  status: string;
  code: number;
  eventId?: string;
  error?: string;
}
/** What the runner prints on stdout. */
const outcome = (stdout: string) =>
  shaped<{ code: number; runDir: string; log: string }>(JSON.parse(stdout));
/** What the fake Pi received, as recorded in the run log. */
const child = async (log: string) => shaped<Child>(JSON.parse(await readFile(log, "utf8")));
const receipt = (saved: string) => shaped<Receipt>(JSON.parse(saved));

async function fixture(kind = "benny-triage") {
  const dir = await mkdtemp(join(tmpdir(), "pstack-job-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
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
    spawned(process.execPath, [runner, "--run", job, event], {
      timeout: 5000,
      env: {
        ...process.env,
        PSTACK_PI_BIN: bin,
        PSTACK_EVENT_SECRET: secret,
        PSTACK_TEST_EXIT_CODE: String(exitCode),
      },
    });
  const signed = (payload: string) => ({
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
    /** Rewrites the job file, dispatches it and returns what the runner printed on stderr. */
    refused: async (value: unknown) => {
      await writeFile(job, JSON.stringify(value));
      return (await run()).stderr;
    },
    writeSigned: (value: unknown) =>
      writeFile(event, JSON.stringify(signed(JSON.stringify(value)))),
    runs: join(dir, "runs"),
  };
}

describe("job runner", () => {
  test("unsupported job shapes fail before claiming a run", async () => {
    const { job, enabled, run, refused, runs } = await fixture();
    for (const invalid of [
      null,
      { ...enabled, enabled: false },
      { ...enabled, cwd: 123 },
      { ...enabled, model: [] },
      { ...enabled, tools: ["-read"] },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each case rewrites this fixture before dispatch.
      assert.match(await refused(invalid), /Job must be reviewed/);
    }
    await writeFile(job, '{"password":"not-for-stderr"');
    const result = await run();
    assert.match(result.stderr, /Invalid JSON in job file/);
    assert.doesNotMatch(result.stderr, /not-for-stderr/);
    await assert.rejects(() => readdir(runs), { code: "ENOENT" });
  });
  test("Benny refuses disabled config or broad tools before dispatch", async () => {
    const { enabled, config, refused } = await fixture();
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
      assert.match(await refused({ ...enabled, ...override }), message);
    }
  });
  test("Benny accepts read and comment tools, and draft PR tools only when authorized", async () => {
    const { job, enabled, config } = await fixture("benny-repro");
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
  test("triage authenticates and claims one report per thread without leaking the signing secret", async () => {
    const { event, run, writeSigned, runs } = await fixture();
    await writeFile(
      event,
      JSON.stringify({ payload: JSON.stringify(report), signature: "0".repeat(64) }),
    );
    assert.match((await run()).stderr, /Event signature rejected/);
    await writeFile(event, "null");
    assert.match((await run()).stderr, /Invalid signed event envelope/);
    await writeSigned(null);
    assert.match((await run()).stderr, /immutable thread coordinates/);
    await writeSigned({ ...report, topLevel: false });
    assert.match((await run()).stderr, /top-level report/);
    await writeSigned(report);
    const first = await run();
    assert.equal(first.status, 0, first.stderr);
    const output = await child(outcome(first.stdout).log);
    assert.equal(output.secret, null);
    assert(output.args.includes("builtin:mcp"));
    assert(output.args.includes("read,mcp__slack__read_thread"));
    assert(!output.args.includes("--no-skills"));
    assert(!output.args.includes("--no-prompt-templates"));
    await writeSigned({ ...report, eventId: "E2" });
    assert.notEqual((await run()).status, 0, "duplicate same thread must fail closed");
    assert.equal((await readdir(runs)).length, 1);
  });
  test("reproduction requires a confirmed marker and preserves child failure status", async () => {
    const { job, enabled, config, run, writeSigned } = await fixture("benny-repro");
    await writeFile(
      job,
      JSON.stringify({
        ...enabled,
        config: { ...config, reproModel: "dev/test" },
        thinking: "low",
      }),
    );
    const marker = {
      ...report,
      type: "triage-marker",
      classification: "bug",
      trusted: true,
      ticket: "BUG-1",
    };
    await writeSigned({ ...marker, trusted: false });
    assert.match((await run()).stderr, /authenticated confirmed triage marker/);
    await writeSigned(marker);
    const failed = await run(7);
    assert.equal(failed.status, 7, failed.stderr);
    const { log, runDir } = outcome(failed.stdout);
    const result = receipt(await readFile(join(runDir, "result.json"), "utf8"));
    assert.equal(result.status, "exited");
    assert.equal(result.code, 7);
    const output = await child(log);
    assert.equal(flag(output.args, "--model"), "dev/test");
    assert.equal(flag(output.args, "--thinking"), "low");
    assert.match(output.prompt, /BUG-1/);
    assert(output.args.every((arg) => !arg.includes("BUG-1")));
  });
  test("a child startup failure does not print the event or the child argument list", async () => {
    const { run, writeSigned, runs } = await fixture();
    await writeSigned({ ...report, text: "private-report-text" });
    const failed = await run(0, join(tmpdir(), "nonexistent-pstack-pi"));
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Unable to start Pi/);
    assert.doesNotMatch(failed.stderr, /private-report-text|spawnargs/);
    const [claim = ""] = await readdir(runs);
    const dir = join(runs, claim);
    const saved = await readFile(join(dir, "result.json"), "utf8");
    const result = receipt(saved);
    assert.equal(result.status, "not-started");
    assert.equal(result.code, failed.status);
    assert.equal(result.eventId, report.eventId);
    assert.match(result.error ?? "", /ENOENT/);
    assert.equal(outcome(failed.stdout).runDir, dir);
    assert.doesNotMatch(saved + failed.stdout, /private-report-text|spawnargs|test-secret/);
    assert.match((await run()).stderr, /EEXIST/);
    assert.equal(await readFile(join(dir, "result.json"), "utf8"), saved);
  });
  test("custom jobs pass Pi's max thinking level through to the child", async () => {
    const { job, enabled, run } = await fixture("custom");
    await writeFile(job, JSON.stringify({ ...enabled, tools: ["read"], thinking: "max" }));
    const result = await run();
    assert.equal(result.status, 0, result.stderr);
    const { args } = await child(outcome(result.stdout).log);
    assert(args.includes("--thinking"));
    assert.equal(flag(args, "--thinking"), "max");
  });
  test("custom jobs need no event and preserve their explicit native tool allowlist", async () => {
    const { job, enabled, run, runs } = await fixture("custom");
    await writeFile(job, JSON.stringify({ ...enabled, tools: ["read"], model: "inherit-parent" }));
    const first = await run();
    assert.equal(first.status, 0, first.stderr);
    const output = await child(outcome(first.stdout).log);
    assert(output.args.includes("--no-mcp"));
    assert(!output.args.includes("--no-skills"));
    assert(!output.args.includes("--no-prompt-templates"));
    assert(!output.args.includes("--model"));
    assert.equal(output.prompt, enabled.instructions);
    assert(!output.args.includes(enabled.instructions));
    assert.equal((await run()).status, 0);
    assert.equal((await readdir(runs)).length, 2);
  });
});
