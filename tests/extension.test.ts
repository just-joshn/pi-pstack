import assert from "node:assert/strict";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, onTestFinished, test, vi } from "vitest";

import { root, slashSkills } from "../lib/catalog.ts";
import type { RoleConfig } from "../lib/models.ts";
import type { Wake } from "../lib/state.ts";
import { isRecord } from "../lib/validation.ts";
import {
  configFile,
  delegated,
  fulfilled,
  type Host,
  host,
  type HostOptions,
  model,
  planned,
  readResult,
  resultText,
  type Run,
  sandbox,
  shipped,
  type Summary,
  type ToolResponse,
} from "./host.ts";
import { audited, commit, created, git, removed, repo } from "./repo.ts";
import { flag, nth, shaped } from "./support.ts";

const swarm = { mode: "swarm", tasks: ["review"] };
const notARepository = { code: 128, stdout: "", stderr: "not a repo" };
const savedConfig = async () => shaped<RoleConfig>(JSON.parse(await readFile(configFile, "utf8")));
const woke = (response: ToolResponse) => shaped<Wake>(readResult(response));
const firstText = (line: string) =>
  shaped<{ content: { text: string }[] }>(JSON.parse(line)).content[0]?.text;

async function finishedPlan() {
  const h = host();
  await h.call("pstack_plan", { action: "custom", goal: "verify", steps: ["check"] });
  await h.call("pstack_plan", { action: "update", task: 1, status: "done", evidence: "passed" });
  const done = planned(await h.call("pstack_plan", { action: "finish", evidence: "green" }));
  return { h, done };
}

/** `pi --list-models` output for the given `provider/id` models. */
function modelTable(...models: string[]): Run {
  const rows = models.map((listed) => {
    const [provider = "", ...id] = listed.split("/");
    return [provider, id.join("/"), "1K"] as const;
  });
  const table = [["provider", "model", "context"] as const, ...rows];
  const width = (column: 0 | 1) => Math.max(...table.map((row) => row[column].length));
  const stdout = table
    .map(([provider, id, size]) => `${provider.padEnd(width(0))}  ${id.padEnd(width(1))}  ${size}`)
    .join("\n");
  return { code: 0, stderr: "", stdout };
}
const listsModels = (args: readonly string[]) => args.includes("--list-models");
const loadedBy = (args: readonly string[]) => args.filter((_, i) => args[i - 1] === "-e");
const unlisted: Record<string, HostOptions> = {
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
const unknownScope: Record<string, Run> = {
  "exits with an error": { code: 1, stdout: "", stderr: "spawn pi ENOENT" },
  "is stopped before it answers": { code: 0, killed: true, stdout: "", stderr: "" },
};

describe("extension", () => {
  test("mock host registers all 52 slash skills and 9 native tools", () => {
    const h = host();
    assert.equal(slashSkills.length, 52);
    for (const skill of slashSkills) assert(h.commands.has(skill.label.slice(1)), skill.id);
    assert.equal(h.tools.size, 9);
    assert(h.events.has("before_agent_start"));
    assert(h.events.has("session_shutdown"));
  });
  test("command activation, explicit plan, native tool update and restore", async () => {
    const h = host();
    await h.cmd("poteto-mode", "on");
    assert.equal(h.state().mode, true);
    const started = h.emit("before_agent_start", { systemPrompt: "base" });
    const prompt = isRecord(started) ? started["systemPrompt"] : undefined;
    assert(typeof prompt === "string" && prompt.includes("Native playbook triggers"));
    await h.cmd("pstack-run", "bug-fix repair");
    assert(h.messages.at(-1)?.includes("Ordered steps"));
    assert.equal(h.state().plan?.route, "bug-fix");
    await h.call("pstack_plan", {
      action: "update",
      task: 1,
      status: "done",
      evidence: "red test",
    });
    assert.equal(h.state().plan?.tasks[0]?.status, "done");
    await assert.rejects(() => h.call("pstack_plan", { action: "finish", evidence: "not enough" }));
    h.emit("session_tree");
    assert.equal(h.state().plan?.tasks[0]?.evidence, "red test");
    await h.cmd("pstack-clear");
    assert.equal(h.state().plan, null);
  });
  test("model configuration validates available models and saves only after confirmation", async () => {
    onTestFinished(() => rm(configFile, { force: true }));
    const h = host({ confirm: false });
    const args = JSON.stringify({
      budget: "small",
      roles: { "arena cross-judge pool": ["google/gemini"] },
    });
    await h.cmd("setup-pstack", args);
    await assert.rejects(() => readFile(configFile));
    const yes = host({ confirm: true, extensionProviders: ["openai"] });
    await yes.cmd("setup-pstack", args);
    const config = await savedConfig();
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
  test("interactive setup saves the selected budget and panel without changing the parent model", async () => {
    onTestFinished(() => rm(configFile, { force: true }));
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
    const config = await savedConfig();
    assert.equal(config.budget, "medium");
    assert.deepEqual(config.roles["arena runners"], ["anthropic/claude", "google/gemini"]);
    assert.deepEqual(h.ctx.model, { provider: "anthropic", id: "claude" });
  });

  test("timer does not start without confirmation, is cancelled on shutdown and denied headless", async () => {
    const h = host();
    await h.cmd("pstack-loop", "5 2 done");
    assert.equal(h.entries.length, 0);
    const yes = host({ confirm: true });
    await yes.cmd("pstack-loop", "5 2 done");
    assert.equal(yes.state().wake?.running, true);
    await yes.cmd("pstack-loop", "stop");
    assert.equal(yes.state().wake?.running, false);
    yes.emit("session_shutdown");
    const headless = host({ mode: "print" });
    await assert.rejects(() => headless.cmd("pstack-loop", "5 2 done"));
  });
  for (const mode of ["print", "json"] as const)
    test(`${mode} mode rejects writes, merges, and worktree removal before executing shell`, async () => {
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

  test("model setup rejects malformed JSON shapes before saving", async () => {
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

  test("setup lists each worker model once, in sorted order", async () => {
    const h = host();
    h.ctx.modelRegistry.getAvailable = () => [
      model("openai", "gpt"),
      model("anthropic", "claude"),
      model("openai", "gpt"),
    ];
    await h.cmd("setup-pstack", "show");
    assert.deepEqual(h.shown().available, ["anthropic/claude", "openai/gpt"]);
  });

  test("a truncated Git worktree list is not accepted as complete", async () => {
    const h = host({
      execute: async () => ({ code: 0, truncated: true, stdout: "", stderr: "" }),
    });
    await assert.rejects(
      () => h.call("pstack_worktree", { action: "audit" }),
      /git worktree.*truncated/,
    );
  });

  test("catalog tools expose routes, views, search results and node instructions", async () => {
    const h = host();
    const read = async (action: string, id?: string) =>
      readResult(await h.call("pstack_catalog", { action, id }));
    const listed = async (action: string, id?: string) =>
      shaped<{ id: string }[]>(await read(action, id));
    const one = async (action: string, id?: string) =>
      shaped<{ id: string; instructions?: string }>(await read(action, id));
    assert((await listed("routes")).some((route) => route.id === "bug-fix"));
    assert.equal((await one("view")).id, "root");
    assert(
      (await listed("search", "runtime diagnosis")).some(
        (node) => node.id === "pb-runtime-forensics",
      ),
    );
    assert.match((await one("node", "pb-bug-fix")).instructions ?? "", /Ordered steps/);
  });

  test("RPC shipping pins approved repository URLs and stops before merging a changed head", async () => {
    const head = "a".repeat(40);
    const url = "https://github.com/team/project/pull/";
    let approved = false;
    const merged = new Set<number>();
    const h = host({
      mode: "rpc",
      confirm: (_, message) => {
        assert.deepEqual(
          shaped<{ url: string }[]>(JSON.parse(message)).map((proof) => proof.url),
          [`${url}1`, `${url}2`],
        );
        approved = true;
        return true;
      },
      execute: async (bin, args) => {
        assert.equal(bin, "gh");
        assert.equal(args[0], "pr");
        const number = Number(args[2]?.split("/").at(-1));
        if (args[1] === "merge") {
          assert.deepEqual(args, [
            "pr",
            "merge",
            `${url}1`,
            "--merge",
            "--match-head-commit",
            head,
          ]);
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
    const outcome = shipped(await h.call("pstack_ship", { proofs }));
    assert.deepEqual(
      outcome.merged.map((entry) => entry.number),
      [1],
    );
    assert.deepEqual(outcome.unmerged, [2]);
    assert.equal(outcome.stopped, 2);
  });

  test("RPC shipping refuses duplicates, missing evidence and a declined confirmation without merging", async () => {
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

  test("a malformed forge response is rejected rather than treated as merge-ready", async () => {
    const h = host({ execute: async () => ({ code: 0, stdout: '{"number":1}', stderr: "" }) });
    await assert.rejects(() => h.call("pstack_pr", { number: 1 }), /Unexpected GitHub PR response/);
  });

  test("PR inspection preserves a null check rollup, but shipping still requires checks", async () => {
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
    const h = host({
      confirm: true,
      execute: async (bin, args) => {
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

  test("swarm preserves reports, errors, order and read-only tool restrictions", async () => {
    const cwd = sandbox;
    const h = host({
      execute: async (bin, args) => {
        if (bin === "git") {
          const stdout = args[0] === "diff" ? "parent diff" : args[0] === "rev-parse" ? cwd : "";
          return { code: 0, stdout, stderr: "" };
        }
        assert.equal(flag(args, "--tools"), "read,grep,find,ls");
        assert(args.includes("--no-extensions"));
        assert(args.includes("--no-mcp"));
        assert.equal(args.at(-2), "--");
        const failed = args.at(-1)?.includes("task failure");
        await writeFile(
          join(flag(args, "--session-dir") ?? "", "session.jsonl"),
          '{"type":"session"}',
        );
        return { code: failed ? 1 : 0, stdout: failed ? "bad output" : "good output", stderr: "" };
      },
    });
    const output = delegated(
      await h.call("pstack_delegate", {
        mode: "swarm",
        tasks: ["task failure", "task success"],
        concurrency: 2,
      }),
    );
    const [first] = output.outputs;
    assert.match(first?.status === "rejected" ? first.reason : "", /failed \(1\)/);
    const second = fulfilled(output.outputs, 1);
    assert.equal(await readFile(second.report, "utf8"), "good output");
    assert.equal(await readFile(join(output.dir, "parent.diff"), "utf8"), "parent diff");
    assert(second.transcript?.endsWith("session.jsonl"));
  });

  test("a worker that leaves several session files reports no single transcript", async () => {
    const h = host({
      execute: async (bin, args) => {
        if (bin === "git") return notARepository;
        const sessionDir = flag(args, "--session-dir") ?? "";
        await Promise.all(
          ["one.jsonl", "two.jsonl"].map((name) => writeFile(join(sessionDir, name), "{}")),
        );
        return { code: 0, stdout: "worker report", stderr: "" };
      },
    });
    const output = delegated(await h.call("pstack_delegate", swarm));
    assert.equal(fulfilled(output.outputs).transcript, null);
  });

  test("a restored or completed wake loop cannot enqueue another turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const h = host({ confirm: true });
    await h.cmd("pstack-loop", "5 1 green");
    h.emit("session_tree");
    vi.advanceTimersByTime(5000);
    assert.equal(h.messages.length, 0);
    await h.cmd("pstack-loop", "5 1 green");
    vi.advanceTimersByTime(5000);
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0] ?? "", /Wake 1\/1/);
    h.emit("agent_settled", { aborted: false });
    vi.advanceTimersByTime(5000);
    assert.equal(h.messages.length, 1);
    assert.equal(woke(await h.call("pstack_wake", { action: "show" })).running, false);
  });

  test("the plan tool accepts custom steps only through the custom action", async () => {
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
    const made = planned(
      await h.call("pstack_plan", { action: "custom", goal: "verify", steps: ["check"] }),
    );
    assert.equal(made.complete, false);
  });

  test("a finished plan records its evidence and leaves the system prompt alone", async () => {
    const { h, done } = await finishedPlan();
    assert.equal(done.plan?.finishedEvidence, "green");
    assert.equal(h.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  });

  test("clearing state keeps the resume note written by a pause", async () => {
    const { h } = await finishedPlan();
    await h.cmd("pstack-goal", "keep progress");
    await h.cmd("pstack-pause");
    const history = shaped<{ entries: unknown[]; artifacts: string }>(
      readResult(await h.call("pstack_history", { limit: 1 })),
    );
    assert.equal(history.entries.length, 1);
    const path = join(history.artifacts, "resume.json");
    const resumeGoal = async () =>
      shaped<{ goal: string }>(JSON.parse(await readFile(path, "utf8"))).goal;
    assert.equal(await resumeGoal(), "keep progress");
    await h.cmd("pstack-clear");
    const shown = shaped<Summary>(readResult(await h.call("pstack_plan", { action: "show" })));
    assert.equal(shown.plan, null);
    assert.equal(await resumeGoal(), "keep progress");
  });

  test("the decision log escapes tabs into one TSV row", async () => {
    const h = host();
    const path = resultText(
      await h.call("pstack_log", {
        phase: "test",
        decision: "a\tb",
        reason: "why",
        evidence: "proof",
        result: "green",
      }),
    );
    assert((await readFile(path, "utf8")).includes("test\ta b\twhy\tproof\tgreen"));
  });

  test("an automation draft is written disabled and runs nothing", async () => {
    const h = host();
    await h.cmd("pstack-automation", "benny-triage");
    const draft = shaped<{ enabled: boolean; instructions: string; config: { enabled: boolean } }>(
      JSON.parse(await readFile(join(h.artifacts, "benny-triage.job.json"), "utf8")),
    );
    assert.equal(draft.enabled, false);
    assert.equal(draft.config.enabled, false);
    assert.equal(
      draft.instructions,
      await readFile(join(root, "reference/benny/triage.md"), "utf8"),
    );
    assert.equal(h.executions.length, 0);
  });

  test("real Git detached worktree audit and approved RPC removal; dirty tree is protected", async () => {
    const cwd = await repo();
    const h = host({ mode: "rpc", confirm: true, cwd, realGit: true });
    const made = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
    const clean = audited(await h.call("pstack_worktree", { action: "audit" }), made.path);
    assert.equal(clean?.merged, true);
    assert.equal(clean.dirty, false);
    const dirty = join(made.path, "dirty.txt");
    await writeFile(dirty, "keep");
    await git(cwd, "config", "status.showUntrackedFiles", "no");
    const changed = audited(await h.call("pstack_worktree", { action: "audit" }), made.path);
    assert.equal(changed?.dirty, true);
    await assert.rejects(
      () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
      /uncommitted/,
    );
    await unlink(dirty);
    assert.equal(
      removed(await h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" })),
      made.path,
    );
  });
  test("RPC write delegation runs in a real detached worktree only after confirmation", async () => {
    const cwd = await repo();
    let approved = false;
    const launchedIn: (string | undefined)[] = [];
    const h: Host = host({
      mode: "rpc",
      cwd,
      realGit: true,
      confirm: () => {
        assert.equal(h.executions.length, 0, "No process runs before approval");
        return approved;
      },
      execute: async (_, args, options) => {
        launchedIn.push(options?.cwd);
        assert.equal(flag(args, "--tools"), "read,grep,find,ls,bash,edit,write");
        return { code: 0, stdout: "mock worker", stderr: "" };
      },
    });
    const task = { mode: "single", tasks: ["write"], readOnly: false };
    await assert.rejects(() => h.call("pstack_delegate", task), /Write delegation not authorized/);
    assert.equal(h.executions.length, 0);
    approved = true;
    const worker = fulfilled(delegated(await h.call("pstack_delegate", task)).outputs);
    assert.notEqual(worker.path, cwd);
    assert.deepEqual(launchedIn, [worker.path]);
    assert.equal(await git(worker.path, "branch", "--show-current"), "");
  });

  test("worktree removal stops if the target ref changes during approval", async () => {
    const cwd = await repo();
    const h = host({
      cwd,
      realGit: true,
      confirm: async () => {
        await commit(cwd, "new target after approval was requested");
        return true;
      },
    });
    const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
    await assert.rejects(
      () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
      /target ref changed after approval/,
    );
    assert.equal((await git(tree.path, "rev-parse", "HEAD")).trim(), tree.base);
  });

  test("worktree removal will not delete a tree that is no longer detached", async () => {
    const cwd = await repo();
    const h = host({ cwd, realGit: true, confirm: true });
    const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
    await git(tree.path, "switch", "-c", "keep-this-branch");
    await assert.rejects(
      () => h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" }),
      /detached tree/,
    );
    assert.equal((await git(tree.path, "branch", "--show-current")).trim(), "keep-this-branch");
  });

  test("worktree removal rejects a non-branch target such as the worktree's own commit", async () => {
    const cwd = await repo();
    const h = host({ cwd, realGit: true, confirm: true });
    const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
    await commit(tree.path, "only in the worktree");
    const head = (await git(tree.path, "rev-parse", "HEAD")).trim();
    await git(cwd, "tag", "unique", head);
    const remove = (base: string) =>
      h.call("pstack_worktree", { action: "remove", name: "fixture", base });
    await assert.rejects(() => remove(head), /must be a branch/);
    await assert.rejects(() => remove("unique"), /must be a branch/);
    await assert.rejects(() => remove("HEAD"), /merge-base failed/);
    assert.equal((await git(tree.path, "rev-parse", "HEAD")).trim(), head);
  });

  test("worktree removal inventories ignored directory contents and rechecks after approval", async () => {
    const cwd = await repo();
    await writeFile(join(cwd, ".gitignore"), ".env*\nbuild/\n");
    await git(cwd, "add", ".gitignore");
    await commit(cwd, "ignore secrets");
    const prompts: string[] = [];
    let approve: (() => boolean | Promise<boolean>) | undefined;
    const h = host({
      cwd,
      realGit: true,
      confirm: (title, message) => {
        prompts.push(`${title}\n${message}`);
        return approve?.() ?? false;
      },
    });
    const tree = created(await h.call("pstack_worktree", { action: "create", name: "fixture" }));
    const secret = join(tree.path, ".env");
    await mkdir(join(tree.path, "build"));
    await writeFile(join(tree.path, "build", "first.txt"), "first");
    const late = join(tree.path, "build", "second.txt");
    await writeFile(secret, "SECRET");
    const entry = audited(await h.call("pstack_worktree", { action: "audit" }), tree.path);
    assert.equal(entry?.dirty, false);
    assert.equal(entry.ignored, 2);
    const remove = () =>
      h.call("pstack_worktree", { action: "remove", name: "fixture", base: "HEAD" });
    await assert.rejects(remove, /Removal not authorized/);
    const prompt = nth(prompts, 0);
    assert.match(prompt, /ignored files\?/);
    assert.match(prompt, /2 ignored path\(s\)[^]*\.env/);
    assert.match(prompt, /build\/first\.txt/);
    approve = async () => {
      await writeFile(late, "LATE");
      return true;
    };
    await assert.rejects(remove, /changed after approval/);
    assert.equal(await readFile(secret, "utf8"), "SECRET");
    await unlink(late);
    approve = () => true;
    assert.equal(removed(await remove()), tree.path);
    await assert.rejects(() => readFile(secret), { code: "ENOENT" });
  });

  test("the parent diff includes root-relative tracked and untracked paths from a subdirectory", async () => {
    const cwd = await repo();
    const subdir = join(cwd, "pkg");
    await mkdir(subdir);
    await writeFile(join(subdir, "local.txt"), "old\n");
    await writeFile(join(cwd, "tracked.txt"), "one\n");
    await git(cwd, "add", ".");
    await commit(cwd, "tracked");
    await git(cwd, "config", "diff.relative", "true");
    await writeFile(join(subdir, "local.txt"), "new\n");
    await writeFile(join(cwd, "tracked.txt"), "two\n");
    await writeFile(join(cwd, "fresh.txt"), "brand new\n");
    const prompts: string[] = [];
    const h = host({
      cwd: subdir,
      realGit: true,
      execute: async (_, args) => {
        prompts.push(args.at(-1) ?? "");
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    const output = delegated(await h.call("pstack_delegate", swarm));
    const diff = await readFile(join(output.dir, "parent.diff"), "utf8");
    assert.match(diff, /diff --git a\/pkg\/local\.txt b\/pkg\/local\.txt/);
    assert.match(diff, /\+two/);
    assert.match(diff, /fresh\.txt/);
    assert.match(diff, /\+brand new/);
    assert.match(nth(prompts, 0), /tracked changes and untracked files/);
    assert.doesNotMatch(nth(prompts, 0), /omitted/);
  });

  test("a worker is told when the parent diff could not be captured", async () => {
    const prompts: string[] = [];
    const h = host({
      execute: async (bin, args) => {
        if (bin === "git") return notARepository;
        prompts.push(args.at(-1) ?? "");
        return { code: 0, stdout: "ok", stderr: "" };
      },
    });
    await h.call("pstack_delegate", swarm);
    assert.match(nth(prompts, 0), /Parent diff artifact unavailable/);
  });

  test("delegation checks the selected workers and judge, not unused roles", async () => {
    onTestFinished(() => rm(configFile, { force: true }));
    const h = host({
      confirm: true,
      execute: async (bin) =>
        bin === "git" ? notARepository : { code: 0, stdout: "worker report", stderr: "" },
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
    h.ctx.scopedModels = [{ model: model("anthropic", "claude") }];
    const tasks = ["review"];
    const result = delegated(await h.call("pstack_delegate", { mode: "single", tasks }));
    assert.equal(fulfilled(result.outputs).model, "anthropic/claude");
    const runs = h.executions.length;
    await assert.rejects(
      () => h.call("pstack_delegate", { mode: "arena", tasks, rubric: "quality" }),
      /openai\/gpt/,
    );
    assert.equal(h.executions.length, runs, "do not start an arena without a usable judge");
  });

  test("a worker loads only the extension that lists its model", async () => {
    const provider = "/extensions/provider.ts";
    const others = ["/extensions/before.ts", "/extensions/after.ts"];
    const workers: string[][] = [];
    const h = host({
      extensionProviders: ["anthropic"],
      loadedExtensions: [...others.slice(0, 1), provider, ...others.slice(1)],
      execute: async (bin, args) => {
        if (bin === "git") return notARepository;
        if (!listsModels(args)) {
          workers.push(args);
          return { code: 0, stdout: "worker report", stderr: "" };
        }
        assert(args.includes("--no-extensions") && !args.includes("--print"));
        const [extension, ...more] = loadedBy(args);
        assert.deepEqual(more, [], "a listing loads at most one extension");
        if (extension === provider) return modelTable("anthropic/claude", "google/gemini");
        if (extension !== undefined && others.includes(extension))
          return modelTable("anthropic/other");
        assert.equal(extension, undefined, "only loaded extensions are listed");
        return modelTable("openai/gpt");
      },
    });
    await h.cmd("setup-pstack", "show");
    const shown = h.shown();
    assert.deepEqual(shown.available, ["anthropic/claude", "google/gemini", "openai/gpt"]);
    assert.equal(shown.warning, undefined);

    const provided = delegated(await h.call("pstack_delegate", swarm));
    assert.equal(fulfilled(provided.outputs).model, "anthropic/claude");
    assert.deepEqual(loadedBy(nth(workers, 0)), [provider]);
    assert(nth(workers, 0).includes("--no-extensions"));
    assert.equal(flag(nth(workers, 0), "--tools"), "read,grep,find,ls");

    h.ctx.model = model("google", "gemini");
    const builtIn = delegated(await h.call("pstack_delegate", swarm));
    assert.equal(fulfilled(builtIn.outputs).model, "google/gemini");
    assert.deepEqual(loadedBy(nth(workers, 1)), []);
  });

  for (const [reason, options] of Object.entries(unlisted))
    test(`delegation refuses an extension model before spawning when ${reason}`, async () => {
      const h = host({
        extensionProviders: ["anthropic"],
        loadedExtensions: ["/extensions/provider.ts"],
        ...options,
      });
      await h.cmd("setup-pstack", "show");
      const shown = h.shown();
      assert.deepEqual(shown.available, ["google/gemini", "openai/gpt"]);
      assert.match(shown.warning ?? "", /inherit-parent.*anthropic\/claude/);
      await assert.rejects(
        () => h.call("pstack_delegate", swarm),
        /Unavailable in the current worker scope: anthropic\/claude/,
      );
      assert(h.executions.every(([, args]) => listsModels(args)));
    });

  for (const [failure, listing] of Object.entries(unknownScope))
    test(`nothing is offered or spawned when the listing without extensions ${failure}`, async () => {
      const h = host({
        extensionProviders: ["anthropic"],
        loadedExtensions: ["/extensions/provider.ts"],
        execute: async (_, args) =>
          args.includes("-e") ? modelTable("anthropic/claude", "google/gemini") : listing,
      });
      h.ctx.model = model("google", "gemini");
      await assert.rejects(() => h.cmd("setup-pstack", "show"), /could not list worker models/i);
      await assert.rejects(() => h.call("pstack_delegate", swarm), /could not list worker models/i);
      assert(h.executions.every(([, args]) => listsModels(args)));
    });

  test("a model id with spaces and slashes keeps its extension", async () => {
    const wide = model("local ai", "org/big model");
    const workers: string[][] = [];
    const h = host({
      extensionProviders: [wide.provider],
      loadedExtensions: ["/extensions/provider.ts"],
      execute: async (bin, args) => {
        if (bin === "git") return notARepository;
        if (listsModels(args))
          return args.includes("-e") ? modelTable("local ai/org/big model") : modelTable();
        workers.push(args);
        return { code: 0, stdout: "worker report", stderr: "" };
      },
    });
    h.ctx.model = wide;
    h.ctx.scopedModels = [{ model: wide }];
    const output = delegated(await h.call("pstack_delegate", swarm));
    assert.equal(fulfilled(output.outputs).model, "local ai/org/big model");
    assert.deepEqual(loadedBy(nth(workers, 0)), ["/extensions/provider.ts"]);
  });

  test("cancelling while worker models are listed reports the cancellation", async () => {
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

  test("the agent cannot select a merge-capable route without operator approval", async () => {
    const start = { action: "start", route: "shipping", goal: "Merge reviewed PR" };
    for (const h of [host({ confirm: false }), host({ mode: "print", confirm: true })]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The hosts are independent; a plain loop is simpler than Promise.all.
      await assert.rejects(() => h.call("pstack_plan", start), /operator approval/);
      assert.equal(h.entries.length, 0);
    }
    const approved = host({ confirm: true });
    const made = planned(await approved.call("pstack_plan", start));
    assert.equal(made.plan?.route, "shipping");
    const other = host({ confirm: () => assert.fail("Other routes need no approval") });
    await other.call("pstack_plan", { action: "start", route: "bug-fix", goal: "repair" });
  });

  test("stopping a wake loop records why it stopped", async () => {
    const h = host({ confirm: true });
    await h.cmd("pstack-loop", "5 2 green");
    await assert.rejects(
      () => h.call("pstack_wake", { action: "stop", evidence: " " }),
      /evidence/,
    );
    const stopped = woke(
      await h.call("pstack_wake", { action: "stop", evidence: "CI green on abc123" }),
    );
    assert.equal(stopped.running, false);
    assert.equal(stopped.stopEvidence, "CI green on abc123");
    assert.equal(h.state().wake?.stopEvidence, "CI green on abc123");
    await h.cmd("pstack-loop", "5 2 green");
    assert.equal(h.state().wake?.running, true);
    assert.equal(h.state().wake?.stopEvidence, undefined);
    h.emit("session_shutdown");
  });
});
