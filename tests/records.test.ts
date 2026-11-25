import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, test } from "vitest";

import { type Host, host, resultText, sandbox } from "./host.ts";
import { shaped } from "./support.ts";

/** Where the extension keeps the files of one host's session. */
const artifacts = (h: Host) =>
  join(sandbox, "pstack", "sessions", h.ctx.sessionManager.getSessionId());
const decision = {
  phase: "plan",
  decision: "first",
  reason: "why",
  evidence: "proof",
  result: "ok",
};

describe("records", () => {
  test("an automation draft needs a known job kind and writes nothing without one", async () => {
    const h = host();
    await h.cmd("pstack-automation", "nightly");
    await h.cmd("pstack-automation");
    assert.deepEqual(
      h.notifications,
      Array(2).fill("Choose benny-triage, benny-repro, or custom."),
    );
    await assert.rejects(() => readdir(artifacts(h)), { code: "ENOENT" });
  });

  test("a custom automation draft asks for explicit instructions and carries no Benny configuration", async () => {
    const h = host();
    await h.cmd("pstack-automation", " custom ");
    const path = join(artifacts(h), "custom.job.json");
    assert.deepEqual(shaped<unknown>(JSON.parse(await readFile(path, "utf8"))), {
      version: 1,
      enabled: false,
      kind: "custom",
      cwd: h.ctx.cwd,
      tools: [],
      instructions: "Supply explicit task, approved tools, trigger and finish predicate.",
    });
    assert.deepEqual(h.notifications, [
      `Disabled draft: ${path}. No scheduler or service was enabled.`,
    ]);
    assert.equal(h.executions.length, 0);
  });

  test("a second draft of the same kind does not overwrite the first", async () => {
    const h = host();
    await h.cmd("pstack-automation", "custom");
    const path = join(artifacts(h), "custom.job.json");
    const first = await readFile(path, "utf8");
    h.ctx.cwd = join(sandbox, "elsewhere");
    await assert.rejects(() => h.cmd("pstack-automation", "custom"), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), first);
  });

  test("later decisions are appended under the one header", async () => {
    const h = host();
    const path = resultText(await h.call("pstack_log", decision));
    const again = resultText(await h.call("pstack_log", { ...decision, decision: "second" }));
    assert.equal(again, path);
    assert.equal(path, join(artifacts(h), "decisions.tsv"));
    const [header, ...rows] = (await readFile(path, "utf8")).trimEnd().split("\n");
    assert.equal(header, "time\tphase\tdecision\treason\tevidence\tresult");
    assert.deepEqual(
      rows.map((row) => row.split("\t").slice(1)),
      [
        ["plan", "first", "why", "proof", "ok"],
        ["plan", "second", "why", "proof", "ok"],
      ],
    );
  });
});
