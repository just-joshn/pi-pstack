import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, onTestFinished, test } from "vitest";

import { configFile, delegated, fulfilled, host, model } from "./host.ts";
import { flag } from "./support.ts";

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
});
