import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, onTestFinished, test } from "vitest";

import { blindTranscript, readPaths } from "../lib/transcript.ts";
import { configFile, delegated, fulfilled, host, type HostOptions, model } from "./host.ts";
import { flag, shaped } from "./support.ts";

const firstText = (line: string) =>
  shaped<{ content: { text: string }[] }>(JSON.parse(line)).content[0]?.text;

async function runArena(judges: string[], judgeCode: number) {
  onTestFinished(() => rm(configFile, { force: true }));
  const judge = "google/gemini";
  const h = host({
    confirm: true,
    execute: async (bin, args) => {
      if (bin === "git") return { code: 128, stdout: "", stderr: "not a repository" };
      if (flag(args, "--model") === judge && judgeCode)
        return { code: judgeCode, stdout: "", stderr: "judge offline" };
      const session = join(flag(args, "--session-dir") ?? "", "session.jsonl");
      await writeFile(
        session,
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "evidence" }] },
        }),
      );
      return { code: 0, stdout: "fixture report", stderr: "" };
    },
  });
  await h.cmd(
    "setup-pstack",
    JSON.stringify({
      roles: {
        "arena runners": ["auto", "inherit-parent"],
        "arena cross-judge pool": judges,
      },
    }),
  );
  h.ctx.scopedModels = [
    { model: model("anthropic", "claude") },
    { model: model("google", "gemini") },
  ];
  return delegated(
    await h.call("pstack_delegate", { mode: "arena", tasks: ["review"], rubric: "evidence" }),
  );
}

/** A fake Pi worker; the judge reads the first candidate and fails to read the second. */
function judgingWorkers(judged: string[]): NonNullable<HostOptions["execute"]> {
  return async (bin, args) => {
    if (bin === "git") return { code: 1, stdout: "", stderr: "not a repo" };
    const worker = flag(args, "--model") ?? "";
    const session = join(flag(args, "--session-dir") ?? "", "session.jsonl");
    const prompt = args.at(-1) ?? "";
    judged.push(worker);
    const content: object[] = [{ type: "text", text: `Compared work for ${worker}` }];
    const results: object[] = [];
    if (worker === "openai/gpt") {
      const [one = "", two = ""] = prompt.match(/\/[^\s,]+\/candidate-\d\.jsonl/g) ?? [];
      const projections = await Promise.all([one, two].map((path) => readFile(path, "utf8")));
      assert(projections.every((line) => firstText(line)?.includes("[redacted-model]")));
      content.push(
        { type: "toolCall", id: "r1", name: "read", arguments: { path: one } },
        { type: "toolCall", id: "r2", name: "read", arguments: { path: two } },
      );
      results.push(
        { role: "toolResult", toolCallId: "r1", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", toolCallId: "r2", isError: true, content: [] },
      );
    }
    await writeFile(
      session,
      [{ role: "assistant", model: worker, content }, ...results]
        .map((message) => JSON.stringify({ type: "message", message }))
        .join("\n"),
    );
    return { code: 0, stdout: "review report", stderr: "" };
  };
}

/** A worker session with one successful, one denied and one unanswered read. */
const workerTranscript = [
  { type: "session", id: "worker" },
  {
    type: "message",
    message: {
      role: "assistant",
      model: "claude",
      provider: "anthropic",
      content: [
        { type: "text", text: "claude result" },
        {
          type: "toolCall",
          id: "ok",
          name: "read",
          arguments: { path: "/tmp/candidate.jsonl" },
        },
        {
          type: "toolCall",
          id: "denied",
          name: "read",
          arguments: { path: "/tmp/denied.jsonl" },
        },
        {
          type: "toolCall",
          id: "pending",
          name: "read",
          arguments: { path: "/tmp/lost.jsonl" },
        },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "ok",
      toolName: "read",
      content: [{ type: "text", text: "actual artifact" }],
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "denied",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "Permission denied" }],
    },
  },
]
  .map((x) => JSON.stringify(x))
  .join("\n");

describe("arena", () => {
  test("a failed arena judge returns the completed candidate reports", async () => {
    const { outputs, dir, judgment } = await runArena(["google/gemini"], 7);
    assert.equal(outputs.length, 2);
    await Promise.all(
      outputs.map(async (_, i) => {
        const report = fulfilled(outputs, i).report;
        assert.equal(dirname(report), dir);
        assert.equal(await readFile(report, "utf8"), "fixture report");
      }),
    );
    assert.match(judgment?.status ?? "", /inconclusive/i);
    assert.match(judgment?.error ?? "", /failed \(7\)/);
  });
  test("judge selection skips both unavailable and same-vendor pool entries", async () => {
    const result = await runArena(["openai/gpt", "anthropic/claude", "google/gemini"], 0);
    assert.equal(result.judgment?.model, "google/gemini");
  });

  test("arena rejects a judge whose provider appears in the candidate panel", async () => {
    onTestFinished(() => rm(configFile, { force: true }));
    const h = host({ confirm: true });
    await h.cmd(
      "setup-pstack",
      JSON.stringify({
        roles: {
          "arena runners": ["anthropic/claude", "google/gemini"],
          "arena cross-judge pool": ["google/gemini"],
        },
      }),
    );
    await assert.rejects(
      () => h.call("pstack_delegate", { mode: "arena", tasks: ["compare"], rubric: "quality" }),
      /judge from another provider/,
    );
    assert.equal(h.executions.length, 0);
  });

  test("arena sends anonymous transcript files to the independent judge and reports missing reads", async () => {
    onTestFinished(() => rm(configFile, { force: true }));
    const judged: string[] = [];
    const h = host({ confirm: true, execute: judgingWorkers(judged) });
    await h.cmd(
      "setup-pstack",
      JSON.stringify({
        roles: {
          "arena runners": ["anthropic/claude", "google/gemini"],
          "arena cross-judge pool": ["google/gemini", "openai/gpt"],
        },
      }),
    );
    const output = delegated(
      await h.call("pstack_delegate", {
        mode: "arena",
        tasks: ["shared task"],
        rubric: "quality",
      }),
    );
    assert.equal(judged.at(-1), "openai/gpt");
    assert.deepEqual(
      output.outputs.map((_, i) => fulfilled(output.outputs, i).model),
      ["anthropic/claude", "google/gemini"],
    );
    assert.deepEqual(
      output.judgment?.readAudit?.map((entry) => entry.read),
      [true, false],
    );
    assert.match(output.judgment.status, /INCONCLUSIVE/);
  });

  test("blinded transcript removes model metadata and read audit finds actual read call paths", () => {
    const raw = workerTranscript;
    const blind = blindTranscript(raw, "anthropic/claude");
    assert(!blind.includes("anthropic"));
    assert(!blind.includes("claude"));
    assert(blind.includes("actual artifact"));
    assert.deepEqual(readPaths(raw), ["/tmp/candidate.jsonl"]);
  });
});
