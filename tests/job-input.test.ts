import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { test } from "vitest";

import { configuredModel, type Job, readEvent, readJob } from "../scripts/job-input.ts";
import { sandbox } from "./host.ts";

const secret = "test-secret";
const config = {
  enabled: true,
  slackChannel: "C1",
  tracker: "tracker",
  repository: "repo",
  featureMap: "map",
  controlAdapter: "adapter",
};
const custom = {
  version: 1,
  enabled: true,
  kind: "custom",
  cwd: "/tmp",
  tools: ["read"],
  instructions: "check",
};
const triage = { ...custom, kind: "benny-triage", tools: ["read", "mcp__slack__read"], config };
const repro = { ...triage, kind: "benny-repro" };
const coordinates = { channel: "C1", thread: "T1", eventId: "E1" };
const report = { ...coordinates, type: "report", topLevel: true };
const marker = {
  ...coordinates,
  type: "triage-marker",
  classification: "bug",
  trusted: true,
  ticket: "BUG-1",
};

async function saved(value: unknown) {
  const dir = await mkdtemp(join(sandbox, "job-input-"));
  const path = join(dir, "file.json");
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}
const job = async (value: unknown) => readJob(await saved(value));
const signed = (payload: unknown, key = secret) => {
  const text = JSON.stringify(payload);
  return { payload: text, signature: createHmac("sha256", key).update(text).digest("hex") };
};
const event = async (forJob: Job, envelope: unknown) =>
  readEvent(forJob, await saved(envelope), secret);

test("a reviewed custom job is read with its explicit tools and model options", async () => {
  const read = await job({ ...custom, model: "openai/gpt", thinking: "max" });
  assert.equal(read.kind, "custom");
  assert.deepEqual(read.tools, ["read"]);
  assert.equal(read.thinking, "max");
  assert.equal(configuredModel(read), "openai/gpt");
});

test("a job without review, absolute cwd, instructions, tools or valid options is refused", async () => {
  const invalid = [
    null,
    [],
    { ...custom, version: 2 },
    { ...custom, enabled: false },
    { ...custom, cwd: "relative" },
    { ...custom, cwd: 1 },
    { ...custom, kind: "unknown" },
    { ...custom, instructions: "  " },
    { ...custom, tools: [] },
    { ...custom, tools: ["-bad"] },
    { ...custom, tools: "read" },
    { ...custom, model: "--flag" },
    { ...custom, model: "" },
    { ...custom, thinking: "extreme" },
    { ...custom, thinking: 1 },
  ];
  await Promise.all(
    invalid.map((value) =>
      assert.rejects(job(value), /Job must be reviewed/, JSON.stringify(value)),
    ),
  );
  await assert.rejects(job("{"), /Invalid JSON in job file/);
});

test("Benny configuration must be enabled, complete and well typed", async () => {
  const incomplete = [
    undefined,
    { ...config, enabled: false },
    { ...config, slackChannel: "" },
    { ...config, tracker: undefined },
    { ...config, triageModel: "-x" },
    { ...config, reproModel: 1 },
    { ...config, allowDraftPr: "yes" },
  ];
  await Promise.all(
    incomplete.map((value) =>
      assert.rejects(job({ ...triage, config: value }), /incomplete or disabled/),
    ),
  );
});

test("Benny tool lists stay narrow, scoped and free of command or write tools", async () => {
  const refused: [string[], RegExp][] = [
    [["read"], /explicit scoped MCP/],
    [["bash", "mcp__slack__read"], /narrow native file/],
    [["edit", "mcp__slack__read"], /triage is read-only/],
    [["mcp__github__merge_pr"], /disallows general command/],
    [["mcp__db__run_query"], /disallows general command/],
    [["mcp__hub__searchTools"], /disallows general command/],
    [["mcp__github__create_file"], /disallows general command/],
    [["mcp__github__create_pull_request"], /require benny-repro with allowDraftPr/],
  ];
  await Promise.all(
    refused.map(([tools, reason]) =>
      assert.rejects(job({ ...triage, tools }), reason, tools.join()),
    ),
  );
  const draft = ["edit", "mcp__github__create_pull_request"];
  await assert.rejects(job({ ...repro, tools: draft }), /allowDraftPr/);
  const allowed = await job({
    ...repro,
    tools: draft,
    config: { ...config, allowDraftPr: true },
  });
  assert.equal(allowed.kind, "benny-repro");
});

test("a Benny job uses its own model or the configured model for its kind", async () => {
  const models = { ...config, triageModel: "a/triage", reproModel: "b/repro" };
  assert.equal(configuredModel(await job({ ...triage, config: models })), "a/triage");
  assert.equal(configuredModel(await job({ ...repro, config: models })), "b/repro");
  assert.equal(configuredModel(await job({ ...repro, model: "c/own", config: models })), "c/own");
  assert.equal(configuredModel(await job(custom)), undefined);
});

test("a custom job needs no event, and a Benny job needs a path and a secret", async () => {
  assert.equal(await readEvent(await job(custom), undefined, undefined), null);
  const benny = await job(triage);
  await assert.rejects(readEvent(benny, undefined, secret), /authenticated event/);
  await assert.rejects(readEvent(benny, await saved(signed(report)), ""), /authenticated event/);
});

test("an event must be a well-formed envelope signed with the shared secret", async () => {
  const benny = await job(triage);
  const malformed = [
    null,
    { payload: 1, signature: "a".repeat(64) },
    { payload: "{}", signature: 1 },
    { payload: "{}", signature: "short" },
  ];
  await Promise.all(
    malformed.map((envelope) =>
      assert.rejects(event(benny, envelope), /Invalid signed event envelope/),
    ),
  );
  await assert.rejects(event(benny, signed(report, "other")), /signature rejected/);
  const signature = createHmac("sha256", secret).update("{").digest("hex");
  await assert.rejects(event(benny, { payload: "{", signature }), /Invalid JSON in signed event/);
});

test("a signed event must match the configured channel and the job's event kind", async () => {
  const benny = await job(triage);
  const mismatched = [[], { ...report, channel: "C2" }, { ...report, thread: "" }];
  await Promise.all(
    mismatched.map((payload) =>
      assert.rejects(event(benny, signed(payload)), /immutable thread coordinates/),
    ),
  );
  await assert.rejects(event(benny, signed({ ...report, topLevel: false })), /top-level report/);
  assert.deepEqual(await event(benny, signed(report)), report);
  const reproJob = await job(repro);
  const unconfirmed = [
    report,
    { ...marker, classification: "feature" },
    { ...marker, trusted: false },
    { ...marker, ticket: "" },
  ];
  await Promise.all(
    unconfirmed.map((payload) =>
      assert.rejects(event(reproJob, signed(payload)), /confirmed triage marker/),
    ),
  );
  const performance = { ...marker, classification: "performance" };
  assert.deepEqual(await event(reproJob, signed(performance)), performance);
});
