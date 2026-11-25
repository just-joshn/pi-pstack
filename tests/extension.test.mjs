import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { slashSkills } from "../lib/catalog.ts";
import { configFile, exec, host, readResult, sandbox } from "./host.mjs";

void test("mock host registers all 52 slash skills and 9 native tools", () => {
  const h = host();
  assert.equal(slashSkills.length, 52);
  for (const skill of slashSkills) assert(h.commands.has(skill.label.slice(1)), skill.id);
  assert.equal(h.tools.size, 9);
  assert(h.events.has("before_agent_start"));
  assert(h.events.has("session_shutdown"));
});
void test("command activation, explicit plan, native tool update and restore", async () => {
  const h = host();
  await h.cmd("poteto-mode", "on");
  assert.equal(h.entries.at(-1).data.mode, true);
  assert(
    h.events
      .get("before_agent_start")({ systemPrompt: "base" }, h.ctx)
      .systemPrompt.includes("Native playbook triggers"),
  );
  await h.cmd("pstack-run", "bug-fix repair");
  assert(h.messages.at(-1).includes("Ordered steps"));
  assert.equal(h.entries.at(-1).data.plan.route, "bug-fix");
  await h.call("pstack_plan", { action: "update", task: 1, status: "done", evidence: "red test" });
  assert.equal(h.entries.at(-1).data.plan.tasks[0].status, "done");
  await assert.rejects(() => h.call("pstack_plan", { action: "finish", evidence: "not enough" }));
  await h.events.get("session_tree")({}, h.ctx);
  assert.equal(h.entries.at(-1).data.plan.tasks[0].evidence, "red test");
  await h.cmd("pstack-clear");
  assert.equal(h.entries.at(-1).data.plan, null);
});
void test("model configuration validates available models and saves only after confirmation", async (t) => {
  t.after(() => rm(configFile, { force: true }));
  const h = host({ confirm: false });
  const args = JSON.stringify({
    budget: "small",
    roles: { "arena cross-judge pool": ["google/gemini"] },
  });
  await h.cmd("setup-pstack", args);
  await assert.rejects(() => readFile(configFile));
  const yes = host({ confirm: true, extensionProviders: ["openai"] });
  await yes.cmd("setup-pstack", args);
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.budget, "small");
  assert.deepEqual(config.roles["arena cross-judge pool"], ["google/gemini"]);
  await assert.rejects(() =>
    yes.cmd("setup-pstack", JSON.stringify({ roles: { "bug-fix": ["invalid/model"] } })),
  );
  await assert.rejects(
    () => yes.cmd("setup-pstack", JSON.stringify({ roles: { "bug-fix": ["openai/gpt"] } })),
    /Unavailable model for bug-fix/,
  );
});
void test("interactive setup saves the selected budget and panel without changing the parent model", async (t) => {
  t.after(() => rm(configFile, { force: true }));
  const h = host({ confirm: true, extensionProviders: ["openai"] });
  let panelSeats = 0;
  h.ctx.ui.select = async (label, choices) => {
    if (label === "Reasoning budget") return choices[1];
    if (choices.includes("Keep current")) {
      return label.startsWith("arena runners:") ? "Choose model(s)" : "Keep current";
    }
    assert(!choices.includes("openai/gpt"), "no loaded extension lists this model");
    return ["anthropic/claude", "google/gemini", "Done"][panelSeats++];
  };
  await h.cmd("setup-pstack");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.budget, "medium");
  assert.deepEqual(config.roles["arena runners"], ["anthropic/claude", "google/gemini"]);
  assert.deepEqual(h.ctx.model, { provider: "anthropic", id: "claude" });
});

void test("timer does not start without confirmation, is cancelled on shutdown and denied headless", async () => {
  const h = host();
  await h.cmd("pstack-loop", "5 2 done");
  assert.equal(h.entries.length, 0);
  const yes = host({ confirm: true });
  await yes.cmd("pstack-loop", "5 2 done");
  assert.equal(yes.entries.at(-1).data.wake.running, true);
  await yes.cmd("pstack-loop", "stop");
  assert.equal(yes.entries.at(-1).data.wake.running, false);
  await yes.events.get("session_shutdown")({}, yes.ctx);
  const headless = host({ mode: "print" });
  await assert.rejects(() => headless.cmd("pstack-loop", "5 2 done"));
});
for (const mode of ["print", "json"]) {
  void test(`${mode} mode rejects writes, merges, and worktree removal before executing shell`, async () => {
    const h = host({ mode, confirm: true });
    await h.cmd("pstack-run", "shipping Merge reviewed PR");
    await assert.rejects(
      () => h.call("pstack_delegate", { mode: "single", tasks: ["write"], readOnly: false }),
      /Write delegation not authorized/,
    );
    await assert.rejects(
      () =>
        h.call("pstack_ship", {
          proofs: [{ number: 1, head: "a".repeat(40), evidence: "proof", independent: true }],
        }),
      /interactive approval/,
    );
    await assert.rejects(
      () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
      /Removal not authorized/,
    );
    assert.equal(h.executions.length, 0);
  });
}

void test("model setup rejects malformed JSON shapes before saving", async () => {
  const h = host({ confirm: false });
  await Promise.all(
    [null, [], true, { roles: null }, { roles: [] }].map((value) =>
      assert.rejects(
        () => h.cmd("setup-pstack", JSON.stringify(value)),
        /Invalid model configuration/,
      ),
    ),
  );
});

void test("a truncated Git worktree list is not accepted as complete", async () => {
  const h = host({ execute: async () => ({ code: 0, truncated: true, stdout: "", stderr: "" }) });
  await assert.rejects(
    () => h.call("pstack_worktree", { action: "audit" }),
    /git worktree.*truncated/,
  );
});

void test("catalog tools expose routes, views, search results and node instructions", async () => {
  const h = host();
  const call = async (action, id) => readResult(await h.call("pstack_catalog", { action, id }));
  assert((await call("routes")).some((route) => route.id === "bug-fix"));
  assert.equal((await call("view")).id, "root");
  assert(
    (await call("search", "runtime diagnosis")).some((node) => node.id === "pb-runtime-forensics"),
  );
  assert.match((await call("node", "pb-bug-fix")).instructions, /Ordered steps/);
});

void test("RPC shipping pins approved repository URLs and stops before merging a changed head", async () => {
  const head = "a".repeat(40);
  const url = "https://github.com/team/project/pull/";
  let approved = false;
  const merged = new Set();
  const h = host({
    mode: "rpc",
    confirm: (_, message) => {
      assert.deepEqual(
        JSON.parse(message).map((proof) => proof.url),
        [`${url}1`, `${url}2`],
      );
      approved = true;
      return true;
    },
    execute: async (bin, args) => {
      assert.equal(bin, "gh");
      assert.equal(args[0], "pr");
      const number = Number(args[2].split("/").at(-1));
      if (args[1] === "merge") {
        assert.deepEqual(args, ["pr", "merge", `${url}1`, "--merge", "--match-head-commit", head]);
        merged.add(number);
        return { code: 0, stdout: "", stderr: "" };
      }
      assert.equal(args[2], approved ? `${url}${number}` : String(number));
      const status = {
        number,
        url: `${url}${number}`,
        headRefOid: approved && number === 2 ? "b".repeat(40) : head,
        state: merged.has(number) ? "MERGED" : "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      };
      return { code: 0, stdout: JSON.stringify(status), stderr: "" };
    },
  });
  await h.cmd("pstack-run", "shipping Merge checked heads");
  const proofs = [1, 2].map((number) => ({
    number,
    head,
    evidence: "local check",
    independent: true,
  }));
  const outcome = readResult(await h.call("pstack_ship", { proofs }));
  assert.deepEqual(
    outcome.merged.map((entry) => entry.number),
    [1],
  );
  assert.deepEqual(outcome.unmerged, [2]);
  assert.equal(outcome.stopped, 2);
});

void test("RPC shipping refuses duplicates, missing evidence and a declined confirmation without merging", async () => {
  const head = "a".repeat(40);
  const h = host({
    mode: "rpc",
    execute: async (_, args) => {
      assert.equal(args[1], "view");
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          number: 1,
          url: "https://github.com/team/project/pull/1",
          headRefOid: head,
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ state: "SUCCESS" }],
        }),
      };
    },
  });
  await h.cmd("pstack-run", "shipping Merge reviewed head");
  const proof = { number: 1, head, independent: true, evidence: "test passed" };
  await assert.rejects(() => h.call("pstack_ship", { proofs: [proof, proof] }), /Duplicate PR/);
  assert.equal(h.executions.length, 0);
  await assert.rejects(
    () => h.call("pstack_ship", { proofs: [{ ...proof, evidence: "" }] }),
    /No verified merge-ready prefix/,
  );
  await assert.rejects(() => h.call("pstack_ship", { proofs: [proof] }), /Merge not authorized/);
  assert.equal(h.executions.length, 2);
});

void test("a malformed forge response is rejected rather than treated as merge-ready", async () => {
  const h = host({ execute: async () => ({ code: 0, stdout: '{"number":1}', stderr: "" }) });
  await assert.rejects(() => h.call("pstack_pr", { number: 1 }), /Unexpected GitHub PR response/);
});

void test("PR inspection preserves a null check rollup, but shipping still requires checks", async () => {
  const pr = {
    number: 1,
    url: "https://github.com/team/project/pull/1",
    headRefOid: "a".repeat(40),
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: null,
  };
  const h = host({
    confirm: () => assert.fail("Shipping must not request approval for missing checks"),
    execute: async (bin, args) => {
      assert.equal(bin, "gh");
      assert.equal(args[1], "view");
      return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
    },
  });
  assert.deepEqual(readResult(await h.call("pstack_pr", { number: pr.number })), pr);
  await h.cmd("pstack-run", "shipping Merge reviewed head");
  const proof = {
    number: pr.number,
    head: pr.headRefOid,
    independent: true,
    evidence: "test passed",
  };
  await assert.rejects(
    () => h.call("pstack_ship", { proofs: [proof] }),
    /No verified merge-ready prefix/,
  );
});

void test("arena rejects a judge whose provider appears in the candidate panel", async (t) => {
  t.after(() => rm(configFile, { force: true }));
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

void test("arena sends anonymous transcript files to the independent judge and reports missing reads", async (t) => {
  t.after(() => rm(configFile, { force: true }));
  const messages = [];
  const h = host({
    confirm: true,
    execute: async (bin, args) => {
      if (bin === "git") return { code: 1, stdout: "", stderr: "not a repo" };
      const model = args[args.indexOf("--model") + 1];
      const session = join(args[args.indexOf("--session-dir") + 1], "session.jsonl");
      const prompt = args.at(-1);
      messages.push({ model, prompt });
      const content = [{ type: "text", text: `Compared work for ${model}` }];
      const results = [];
      if (model === "openai/gpt") {
        const [one, two] = prompt.match(/\/[^\s,]+\/candidate-\d\.jsonl/g);
        const projections = await Promise.all([one, two].map((path) => readFile(path, "utf8")));
        assert(
          projections.every((line) =>
            JSON.parse(line).content[0].text.includes("[redacted-model]"),
          ),
        );
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
        [{ role: "assistant", model, content }, ...results]
          .map((message) => JSON.stringify({ type: "message", message }))
          .join("\n"),
      );
      return { code: 0, stdout: "review report", stderr: "" };
    },
  });
  await h.cmd(
    "setup-pstack",
    JSON.stringify({
      roles: {
        "arena runners": ["anthropic/claude", "google/gemini"],
        "arena cross-judge pool": ["google/gemini", "openai/gpt"],
      },
    }),
  );
  const output = readResult(
    await h.call("pstack_delegate", { mode: "arena", tasks: ["shared task"], rubric: "quality" }),
  );
  assert.equal(messages.at(-1).model, "openai/gpt");
  assert.equal(output.outputs.length, 2);
  assert.deepEqual(
    output.judgment.readAudit.map((entry) => entry.read),
    [true, false],
  );
  assert.match(output.judgment.status, /INCONCLUSIVE/);
});

void test("swarm preserves reports, errors, order and read-only tool restrictions", async () => {
  const cwd = sandbox;
  const h = host({
    execute: async (bin, args) => {
      if (bin === "git") {
        const stdout = args[0] === "diff" ? "parent diff" : args[0] === "rev-parse" ? cwd : "";
        return { code: 0, stdout, stderr: "" };
      }
      assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
      assert(args.includes("--no-extensions"));
      assert(args.includes("--no-mcp"));
      assert.equal(args.at(-2), "--");
      const sessionDir = args[args.indexOf("--session-dir") + 1];
      const failed = args.at(-1).includes("task failure");
      await writeFile(join(sessionDir, "session.jsonl"), '{"type":"session"}');
      return { code: failed ? 1 : 0, stdout: failed ? "bad output" : "good output", stderr: "" };
    },
  });
  const output = readResult(
    await h.call("pstack_delegate", {
      mode: "swarm",
      tasks: ["task failure", "task success"],
      concurrency: 2,
    }),
  );
  assert.equal(output.outputs[0].status, "rejected");
  assert.match(output.outputs[0].reason, /failed \(1\)/);
  assert.equal(output.outputs[1].status, "fulfilled");
  assert.equal(await readFile(output.outputs[1].value.report, "utf8"), "good output");
  assert.equal(await readFile(join(output.dir, "parent.diff"), "utf8"), "parent diff");
  assert(output.outputs[1].value.transcript.endsWith("session.jsonl"));
});

void test("a restored or completed wake loop cannot enqueue another turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = host({ confirm: true });
  await h.cmd("pstack-loop", "5 1 green");
  h.events.get("session_tree")({}, h.ctx);
  t.mock.timers.tick(5000);
  assert.equal(h.messages.length, 0);
  await h.cmd("pstack-loop", "5 1 green");
  t.mock.timers.tick(5000);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, /Wake 1\/1/);
  h.events.get("agent_settled")({ aborted: false }, h.ctx);
  t.mock.timers.tick(5000);
  assert.equal(h.messages.length, 1);
  assert.equal(readResult(await h.call("pstack_wake", { action: "show" })).running, false);
});

void test("the plan tool accepts custom steps only through the custom action", async () => {
  const h = host();
  await assert.rejects(
    () =>
      h.call("pstack_plan", {
        action: "start",
        route: "figure-it-out",
        goal: "verify",
        steps: ["check"],
      }),
    /known playbook/,
  );
  assert.equal(h.entries.length, 0);
  const made = readResult(
    await h.call("pstack_plan", { action: "custom", goal: "verify", steps: ["check"] }),
  );
  assert.equal(made.state.complete, false);
});

async function finishedPlan() {
  const h = host();
  await h.call("pstack_plan", { action: "custom", goal: "verify", steps: ["check"] });
  await h.call("pstack_plan", { action: "update", task: 1, status: "done", evidence: "passed" });
  const done = readResult(await h.call("pstack_plan", { action: "finish", evidence: "green" }));
  return { h, done };
}

void test("a finished plan records its evidence and leaves the system prompt alone", async () => {
  const { h, done } = await finishedPlan();
  assert.equal(done.state.plan.finishedEvidence, "green");
  assert.equal(h.events.get("before_agent_start")({ systemPrompt: "base" }, h.ctx), undefined);
});

void test("clearing state keeps the resume note written by a pause", async () => {
  const { h } = await finishedPlan();
  await h.cmd("pstack-goal", "keep progress");
  await h.cmd("pstack-pause");
  const history = readResult(await h.call("pstack_history", { limit: 1 }));
  assert.equal(history.entries.length, 1);
  const path = join(history.artifacts, "resume.json");
  assert.equal(JSON.parse(await readFile(path, "utf8")).goal, "keep progress");
  await h.cmd("pstack-clear");
  assert.equal(readResult(await h.call("pstack_plan", { action: "show" })).plan, null);
  assert.equal(JSON.parse(await readFile(path, "utf8")).goal, "keep progress");
});

void test("the decision log escapes tabs into one TSV row", async () => {
  const h = host();
  const r = await h.call("pstack_log", {
    phase: "test",
    decision: "a\tb",
    reason: "why",
    evidence: "proof",
    result: "green",
  });
  const path = r.content[0].text;
  assert((await readFile(path, "utf8")).includes("test\ta b\twhy\tproof\tgreen"));
});

void test("an automation draft is written disabled and runs nothing", async () => {
  const h = host();
  await h.cmd("pstack-automation", "benny-triage");
  const draft = JSON.parse(
    await readFile(
      join(
        sandbox,
        "pstack",
        "sessions",
        h.ctx.sessionManager.getSessionId(),
        "benny-triage.job.json",
      ),
      "utf8",
    ),
  );
  assert.equal(draft.enabled, false);
  assert.equal(draft.config.enabled, false);
  assert.equal(h.executions.length, 0);
});
function commit(cwd, message) {
  return exec(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      message,
    ],
    { cwd },
  );
}

async function repo() {
  const cwd = await mkdtemp(join(sandbox, "repo-"));
  await exec("git", ["init", "-q"], { cwd });
  await commit(cwd, "initial");
  return cwd;
}

void test("real Git detached worktree audit and approved RPC removal; dirty tree is protected", async () => {
  const cwd = await repo();
  const h = host({ mode: "rpc", confirm: true, cwd, realGit: true });
  const made = readResult(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
  const audit = readResult(await h.call("pstack_worktree", { action: "audit" }));
  assert(
    audit.some(
      (x) =>
        x.status === "fulfilled" &&
        x.value.path === made.path &&
        x.value.merged === true &&
        x.value.dirty === false,
    ),
  );
  const dirty = join(made.path, "dirty.txt");
  await writeFile(dirty, "keep");
  await exec("git", ["config", "status.showUntrackedFiles", "no"], { cwd });
  const dirtyAudit = readResult(await h.call("pstack_worktree", { action: "audit" }));
  assert.equal(dirtyAudit.find((entry) => entry.value?.path === made.path).value.dirty, true);
  await assert.rejects(
    () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
    /uncommitted/,
  );
  await unlink(dirty);
  const removal = readResult(
    await h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
  );
  assert.equal(removal.removed, made.path);
});
void test("RPC write delegation runs in a real detached worktree only after confirmation", async () => {
  const cwd = await repo();
  let approved = false;
  const h = host({
    mode: "rpc",
    cwd,
    realGit: true,
    confirm: () => {
      assert.equal(h.executions.length, 0, "No process runs before approval");
      return approved;
    },
    execute: async (_, args, options) => {
      assert.notEqual(options.cwd, cwd);
      assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,bash,edit,write");
      return { code: 0, stdout: "mock worker", stderr: "" };
    },
  });
  const task = { mode: "single", tasks: ["write"], readOnly: false };
  await assert.rejects(() => h.call("pstack_delegate", task), /Write delegation not authorized/);
  assert.equal(h.executions.length, 0);
  approved = true;
  const {
    outputs: [worker],
  } = readResult(await h.call("pstack_delegate", task));
  assert.equal(worker.status, "fulfilled", JSON.stringify(worker));
  assert.equal(
    (await exec("git", ["branch", "--show-current"], { cwd: worker.value.path })).stdout,
    "",
  );
});

void test("worktree removal stops if the target ref changes during approval", async () => {
  const cwd = await repo();
  const h = host({
    cwd,
    realGit: true,
    confirm: async () => {
      await commit(cwd, "new target after approval was requested");
      return true;
    },
  });
  const tree = readResult(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
  await assert.rejects(
    () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
    /target ref changed after approval/,
  );
  assert.equal(
    (await exec("git", ["rev-parse", "HEAD"], { cwd: tree.path })).stdout.trim(),
    tree.base,
  );
});

void test("worktree removal will not delete a tree that is no longer detached", async () => {
  const cwd = await repo();
  const h = host({ cwd, realGit: true, confirm: true });
  const tree = readResult(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
  await exec("git", ["switch", "-c", "keep-this-branch"], { cwd: tree.path });
  await assert.rejects(
    () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
    /detached tree/,
  );
  assert.equal(
    (await exec("git", ["branch", "--show-current"], { cwd: tree.path })).stdout.trim(),
    "keep-this-branch",
  );
});

void test("worktree removal rejects a non-branch target such as the worktree's own commit", async () => {
  const cwd = await repo();
  const h = host({ cwd, realGit: true, confirm: true });
  const tree = readResult(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
  await commit(tree.path, "only in the worktree");
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: tree.path })).stdout.trim();
  await exec("git", ["tag", "unique", head], { cwd });
  const remove = (base) => h.call("pstack_worktree", { action: "remove", name: "fixture", base });
  await assert.rejects(() => remove(head), /must be a branch/);
  await assert.rejects(() => remove("unique"), /must be a branch/);
  await assert.rejects(() => remove("HEAD"), /merge-base failed/);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: tree.path })).stdout.trim(), head);
});

void test("worktree removal inventories ignored directory contents and rechecks after approval", async () => {
  const cwd = await repo();
  await writeFile(join(cwd, ".gitignore"), ".env*\nbuild/\n");
  await exec("git", ["add", ".gitignore"], { cwd });
  await commit(cwd, "ignore secrets");
  const prompts = [];
  let approve;
  const h = host({
    cwd,
    realGit: true,
    confirm: (title, message) => {
      prompts.push(`${title}\n${message}`);
      return approve?.() ?? false;
    },
  });
  const tree = readResult(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
  const secret = join(tree.path, ".env");
  await mkdir(join(tree.path, "build"));
  await writeFile(join(tree.path, "build", "first.txt"), "first");
  const late = join(tree.path, "build", "second.txt");
  await writeFile(secret, "SECRET");
  const audit = readResult(await h.call("pstack_worktree", { action: "audit" }));
  const entry = audit.find((item) => item.value?.path === tree.path).value;
  assert.equal(entry.dirty, false);
  assert.equal(entry.ignored, 2);
  const remove = () =>
    h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" });
  await assert.rejects(remove, /Removal not authorized/);
  assert.match(prompts[0], /ignored files\?/);
  assert.match(prompts[0], /2 ignored path\(s\)[^]*\.env/);
  assert.match(prompts[0], /build\/first\.txt/);
  approve = async () => {
    await writeFile(late, "LATE");
    return true;
  };
  await assert.rejects(remove, /changed after approval/);
  assert.equal(await readFile(secret, "utf8"), "SECRET");
  await unlink(late);
  approve = () => true;
  assert.equal(readResult(await remove()).removed, tree.path);
  await assert.rejects(() => readFile(secret), { code: "ENOENT" });
});

void test("the parent diff includes root-relative tracked and untracked paths from a subdirectory", async () => {
  const cwd = await repo();
  const subdir = join(cwd, "pkg");
  await mkdir(subdir);
  await writeFile(join(subdir, "local.txt"), "old\n");
  await writeFile(join(cwd, "tracked.txt"), "one\n");
  await exec("git", ["add", "."], { cwd });
  await commit(cwd, "tracked");
  await exec("git", ["config", "diff.relative", "true"], { cwd });
  await writeFile(join(subdir, "local.txt"), "new\n");
  await writeFile(join(cwd, "tracked.txt"), "two\n");
  await writeFile(join(cwd, "fresh.txt"), "brand new\n");
  const prompts = [];
  const h = host({
    cwd: subdir,
    realGit: true,
    execute: async (_, args) => {
      prompts.push(args.at(-1));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  const output = readResult(await h.call("pstack_delegate", { mode: "swarm", tasks: ["review"] }));
  const diff = await readFile(join(output.dir, "parent.diff"), "utf8");
  assert.match(diff, /diff --git a\/pkg\/local\.txt b\/pkg\/local\.txt/);
  assert.match(diff, /\+two/);
  assert.match(diff, /fresh\.txt/);
  assert.match(diff, /\+brand new/);
  assert.match(prompts[0], /tracked changes and untracked files/);
  assert.doesNotMatch(prompts[0], /omitted/);
});

void test("a worker is told when the parent diff could not be captured", async () => {
  const prompts = [];
  const h = host({
    execute: async (bin, args) => {
      if (bin === "git") return { code: 128, stdout: "", stderr: "not a repo" };
      prompts.push(args.at(-1));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });
  await h.call("pstack_delegate", { mode: "swarm", tasks: ["review"] });
  assert.match(prompts[0], /Parent diff artifact unavailable/);
});

void test("delegation checks the selected workers and judge, not unused roles", async (t) => {
  t.after(() => rm(configFile, { force: true }));
  const h = host({
    confirm: true,
    execute: async (bin) =>
      bin === "git"
        ? { code: 128, stdout: "", stderr: "not a repo" }
        : { code: 0, stdout: "worker report", stderr: "" },
  });
  await h.cmd(
    "setup-pstack",
    JSON.stringify({
      roles: {
        "arena runners": ["auto", "inherit-parent"],
        "arena cross-judge pool": ["openai/gpt"],
      },
    }),
  );
  h.ctx.scopedModels = [{ model: h.ctx.model }];
  const tasks = ["review"];
  const result = readResult(await h.call("pstack_delegate", { mode: "single", tasks }));
  assert.equal(result.outputs[0].value.model, "anthropic/claude");
  const runs = h.executions.length;
  await assert.rejects(
    () => h.call("pstack_delegate", { mode: "arena", tasks, rubric: "quality" }),
    /openai\/gpt/,
  );
  assert.equal(h.executions.length, runs, "do not start an arena without a usable judge");
});

const modelTable = (...models) => {
  const rows = models.map((model) => {
    const [provider, ...id] = model.split("/");
    return [provider, id.join("/"), "1K"];
  });
  rows.unshift(["provider", "model", "context"]);
  const width = (column) => Math.max(...rows.map((row) => row[column].length));
  const stdout = rows
    .map(([provider, id, size]) => `${provider.padEnd(width(0))}  ${id.padEnd(width(1))}  ${size}`)
    .join("\n");
  return { code: 0, stderr: "", stdout };
};
const listsModels = (args) => args.includes("--list-models");
const loadedBy = (args) => args.filter((_, i) => args[i - 1] === "-e");
const swarm = { mode: "swarm", tasks: ["review"] };

void test("a worker loads only the extension that lists its model", async () => {
  const provider = "/extensions/provider.ts";
  const others = ["/extensions/before.ts", "/extensions/after.ts"];
  const workers = [];
  const h = host({
    extensionProviders: ["anthropic"],
    loadedExtensions: [others[0], provider, others[1]],
    execute: async (bin, args) => {
      if (bin === "git") return { code: 128, stdout: "", stderr: "not a repo" };
      if (!listsModels(args)) {
        workers.push(args);
        return { code: 0, stdout: "worker report", stderr: "" };
      }
      assert(args.includes("--no-extensions") && !args.includes("--print"));
      const [extension, ...more] = loadedBy(args);
      assert.deepEqual(more, [], "a listing loads at most one extension");
      if (extension === provider) return modelTable("anthropic/claude", "google/gemini");
      if (others.includes(extension)) return modelTable("anthropic/other");
      assert.equal(extension, undefined, "only loaded extensions are listed");
      return modelTable("openai/gpt");
    },
  });
  await h.cmd("setup-pstack", "show");
  const shown = JSON.parse(h.notifications.at(-1));
  assert.deepEqual(shown.available, ["anthropic/claude", "google/gemini", "openai/gpt"]);
  assert.equal(shown.warning, undefined);

  const provided = readResult(await h.call("pstack_delegate", swarm));
  assert.equal(provided.outputs[0].value.model, "anthropic/claude");
  assert.deepEqual(loadedBy(workers[0]), [provider]);
  assert(workers[0].includes("--no-extensions"));
  assert.equal(workers[0][workers[0].indexOf("--tools") + 1], "read,grep,find,ls");

  h.ctx.model = { provider: "google", id: "gemini" };
  const builtIn = readResult(await h.call("pstack_delegate", swarm));
  assert.equal(builtIn.outputs[0].value.model, "google/gemini");
  assert.deepEqual(loadedBy(workers[1]), []);
});

const unlisted = {
  "no loaded extension registers a command": { loadedExtensions: [] },
  "Pi lists the provider without the extension": {
    execute: async () => modelTable("anthropic/claude"),
  },
  "the extension lists only a longer model id": {
    execute: async (_, args) =>
      args.includes("-e") ? modelTable("anthropic/claude extra") : modelTable("google/gemini"),
  },
  "the extension's listing fails": {
    execute: async (_, args) =>
      args.includes("-e") ? { ...modelTable("anthropic/claude"), code: 1 } : modelTable(),
  },
};
for (const [reason, options] of Object.entries(unlisted)) {
  void test(`delegation refuses an extension model before spawning when ${reason}`, async () => {
    const h = host({
      extensionProviders: ["anthropic"],
      loadedExtensions: ["/extensions/provider.ts"],
      ...options,
    });
    await h.cmd("setup-pstack", "show");
    const shown = JSON.parse(h.notifications.at(-1));
    assert.deepEqual(shown.available, ["google/gemini", "openai/gpt"]);
    assert.match(shown.warning, /inherit-parent.*anthropic\/claude/);
    await assert.rejects(
      () => h.call("pstack_delegate", swarm),
      /Unavailable in the current worker scope: anthropic\/claude/,
    );
    assert(h.executions.every(([, args]) => listsModels(args)));
  });
}

const unknownScope = {
  "exits with an error": { code: 1, stdout: "", stderr: "spawn pi ENOENT" },
  "is stopped before it answers": { code: 0, killed: true, stdout: "", stderr: "" },
};
for (const [failure, listing] of Object.entries(unknownScope)) {
  void test(`nothing is offered or spawned when the listing without extensions ${failure}`, async () => {
    const h = host({
      extensionProviders: ["anthropic"],
      loadedExtensions: ["/extensions/provider.ts"],
      execute: async (_, args) =>
        args.includes("-e") ? modelTable("anthropic/claude", "google/gemini") : listing,
    });
    h.ctx.model = { provider: "google", id: "gemini" };
    await assert.rejects(() => h.cmd("setup-pstack", "show"), /could not list worker models/i);
    await assert.rejects(() => h.call("pstack_delegate", swarm), /could not list worker models/i);
    assert(h.executions.every(([, args]) => listsModels(args)));
  });
}

void test("a model id with spaces and slashes keeps its extension", async () => {
  const model = { provider: "local ai", id: "org/big model" };
  const workers = [];
  const h = host({
    extensionProviders: [model.provider],
    loadedExtensions: ["/extensions/provider.ts"],
    execute: async (bin, args) => {
      if (bin === "git") return { code: 128, stdout: "", stderr: "not a repo" };
      if (listsModels(args))
        return args.includes("-e") ? modelTable("local ai/org/big model") : modelTable();
      workers.push(args);
      return { code: 0, stdout: "worker report", stderr: "" };
    },
  });
  h.ctx.model = model;
  h.ctx.scopedModels = [{ model }];
  const output = readResult(await h.call("pstack_delegate", swarm));
  assert.equal(output.outputs[0].value.model, "local ai/org/big model");
  assert.deepEqual(loadedBy(workers[0]), ["/extensions/provider.ts"]);
});

void test("cancelling while worker models are listed reports the cancellation", async () => {
  const cancel = new AbortController();
  const h = host({
    extensionProviders: ["anthropic"],
    loadedExtensions: ["/extensions/provider.ts"],
    execute: async () => {
      cancel.abort();
      return { code: 143, killed: true, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(() => h.call("pstack_delegate", swarm, cancel.signal), /Cancelled/);
});

void test("the agent cannot select a merge-capable route without operator approval", async () => {
  const start = { action: "start", route: "shipping", goal: "Merge reviewed PR" };
  for (const h of [host({ confirm: false }), host({ mode: "print", confirm: true })]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each host is checked in turn.
    await assert.rejects(() => h.call("pstack_plan", start), /operator approval/);
    assert.equal(h.entries.length, 0);
  }
  const approved = host({ confirm: true });
  const made = readResult(await approved.call("pstack_plan", start));
  assert.equal(made.state.plan.route, "shipping");
  const other = host({ confirm: () => assert.fail("Other routes need no approval") });
  await other.call("pstack_plan", { action: "start", route: "bug-fix", goal: "repair" });
});

void test("stopping a wake loop records why it stopped", async () => {
  const h = host({ confirm: true });
  await h.cmd("pstack-loop", "5 2 green");
  await assert.rejects(() => h.call("pstack_wake", { action: "stop", evidence: " " }), /evidence/);
  const stopped = readResult(
    await h.call("pstack_wake", { action: "stop", evidence: "CI green on abc123" }),
  );
  assert.equal(stopped.running, false);
  assert.equal(stopped.stopEvidence, "CI green on abc123");
  assert.equal(h.entries.at(-1).data.wake.stopEvidence, "CI green on abc123");
  await h.cmd("pstack-loop", "5 2 green");
  assert.equal(h.entries.at(-1).data.wake.stopEvidence, undefined);
  await h.events.get("session_shutdown")({}, h.ctx);
});
