import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { configFile, host, readResult } from "./host.mjs";

async function runArena(t, judges, judgeCode) {
  t.after(() => rm(configFile, { force: true }));
  const judge = "google/gemini";
  const h = host({
    confirm: true,
    execute: async (bin, args) => {
      if (bin === "git") return { code: 128, stdout: "", stderr: "not a repository" };
      const model = args[args.indexOf("--model") + 1];
      if (model === judge && judgeCode)
        return { code: judgeCode, stdout: "", stderr: "judge offline" };
      const session = join(args[args.indexOf("--session-dir") + 1], "session.jsonl");
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
  h.ctx.scopedModels = [{ model: h.ctx.model }, { model: { provider: "google", id: "gemini" } }];
  return readResult(
    await h.call("pstack_delegate", { mode: "arena", tasks: ["review"], rubric: "evidence" }),
  );
}

void test("a failed arena judge returns the completed candidate reports", async (t) => {
  const { outputs, dir, judgment } = await runArena(t, ["google/gemini"], 7);
  assert.equal(outputs.length, 2);
  await Promise.all(
    outputs.map(async ({ status, value }) => {
      assert.equal(status, "fulfilled");
      assert.equal(dirname(value.report), dir);
      assert.equal(await readFile(value.report, "utf8"), "fixture report");
    }),
  );
  assert.match(judgment.status, /inconclusive/i);
  assert.match(judgment.error, /failed \(7\)/);
});

void test("judge selection skips both unavailable and same-vendor pool entries", async (t) => {
  const result = await runArena(t, ["openai/gpt", "anthropic/claude", "google/gemini"], 0);
  assert.equal(result.judgment.model, "google/gemini");
});
