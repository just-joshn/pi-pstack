import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { onTestFinished, test } from "vitest";

import { workerArgs, workerRoles } from "../src/delegate.ts";
import { srcDir } from "../src/lib/catalog.ts";
import {
  configFile,
  delegated,
  fulfilled,
  type Host,
  host,
  model,
  notARepository,
  sandbox,
  swarm,
} from "./host.ts";
import { audited, git, repo } from "./repo.ts";
import { flag, nth } from "./support.ts";

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

test("a running write worker's worktree is reported active and cannot be removed", async () => {
  const cwd = await repo();
  const seen: (boolean | undefined)[] = [];
  const h: Host = host({
    mode: "rpc",
    cwd,
    realGit: true,
    confirm: true,
    execute: async (_, _args, options) => {
      const path = options?.cwd ?? "";
      const audit = await h.call("pstack_worktree", { action: "audit" });
      seen.push(audited(audit, path)?.activeWorker);
      const name = path.split("/").at(-1);
      await assert.rejects(
        () => h.call("pstack_worktree", { action: "remove", name, base: "HEAD" }),
        /inactive/,
      );
      return { code: 0, stdout: "mock worker", stderr: "" };
    },
  });
  const task = { mode: "single", tasks: ["write"], readOnly: false };
  const worker = fulfilled(delegated(await h.call("pstack_delegate", task)).outputs);
  assert.deepEqual(seen, [true]);
  const after = audited(await h.call("pstack_worktree", { action: "audit" }), worker.path);
  assert.equal(after?.activeWorker, false);
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

test("worker flags disable nested extensions, MCP for readers, and writes for reviewers", () => {
  const base = {
    model: "anthropic/claude",
    thinking: "high" as const,
    sessionDir: "/tmp/pstack",
    sessionId: "worker-1",
    prompt: "--not-a-flag",
  };
  const read = workerArgs({ ...base, readOnly: true }),
    write = workerArgs({ ...base, readOnly: false });
  assert(read.includes("--no-mcp"));
  assert(
    !write.includes("--no-mcp"),
    "a writing worker keeps MCP tools, as upstream's agent mode does",
  );
  assert(write.includes("--no-extensions"));
  assert(read.includes("--no-extensions"));
  assert.equal(flag(read, "--tools"), "read,grep,find,ls");
  assert.equal(flag(write, "--tools"), "read,grep,find,ls,bash,edit,write");
  assert.deepEqual(read.slice(-2), ["--", "--not-a-flag"]);
  assert(!read.includes("-e"));
  const provided = workerArgs({ ...base, readOnly: true, extension: "/provider.ts" });
  assert.equal(flag(provided, "-e"), "/provider.ts");
  assert(provided.includes("--no-extensions"));
  assert(provided.indexOf("-e") < provided.indexOf("--"));
});

test("every worker role with a contract has its file in agents/", async () => {
  const contracts = [...workerRoles.values()].flatMap((role) => role.contract ?? []);
  assert.equal(contracts.length, 4);
  await Promise.all(contracts.map((contract) => access(join(srcDir, "agents", contract))));
});

function recordingHost() {
  const runs: { args: string[]; cwd: string | undefined }[] = [];
  const h = host({
    execute: async (bin, args, options) => {
      if (bin === "git") return notARepository;
      runs.push({ args, cwd: options?.cwd });
      await writeFile(join(flag(args, "--session-dir") ?? "", "session.jsonl"), "{}");
      return { code: 0, stdout: `report ${runs.length}`, stderr: "" };
    },
  });
  return { h, runs };
}

test("the kickoff starts with worker.md and adds no rule that overrides it", async () => {
  const { h, runs } = recordingHost();
  await h.call("pstack_delegate", { mode: "single", tasks: ["open the PR"] });
  const prompt = nth(runs, 0).args.at(-1) ?? "";
  const worker = join(srcDir, "skills", "poteto-mode", "worker.md");
  assert(prompt.startsWith(`Read ${worker} before anything else.\n`));
  assert(prompt.includes(await readFile(worker, "utf8")));
  assert(
    prompt.includes(await readFile(join(srcDir, "skills", "poteto-mode", "SKILL.md"), "utf8")),
  );
  assert.doesNotMatch(prompt, /external side effects/);
});

test("a worker runs on the model and thinking level its caller passes; panels keep theirs", async () => {
  const { h, runs } = recordingHost();
  await h.call("pstack_delegate", {
    mode: "swarm",
    tasks: ["a", "b"],
    model: "inherit-parent",
    thinking: "low",
  });
  for (const { args } of runs) {
    assert.equal(flag(args, "--model"), "anthropic/claude");
    assert.equal(flag(args, "--thinking"), "low");
  }
  await Promise.all(
    [{ model: "openai/gpt" }, { thinking: "high" }].map((extra) =>
      assert.rejects(
        () => h.call("pstack_delegate", { mode: "interrogate", tasks: ["review"], ...extra }),
        /Panel seats use their configured models/,
      ),
    ),
  );
  assert.equal(runs.length, 2);
});

test("resume continues a worker's own session in its own checkout with the follow-up only", async () => {
  const { h, runs } = recordingHost();
  const first = fulfilled(
    delegated(
      await h.call("pstack_delegate", { mode: "single", tasks: ["start"], thinking: "medium" }),
    ).outputs,
  );
  const resumed = fulfilled(
    delegated(
      await h.call("pstack_delegate", {
        mode: "single",
        tasks: ["now fix the failing test"],
        resume: first.sessionDir,
      }),
    ).outputs,
  );
  const [start, follow] = [nth(runs, 0), nth(runs, 1)];
  for (const name of ["--session-dir", "--session-id", "--model", "--thinking", "--tools"])
    assert.equal(flag(follow.args, name), flag(start.args, name), name);
  assert.equal(follow.cwd, start.cwd);
  assert.equal(follow.args.at(-1), "now fix the failing test");
  assert.equal(await readFile(resumed.report, "utf8"), "report 2");
  assert.equal(resumed.sessionDir, first.sessionDir);

  await assert.rejects(
    () => h.call("pstack_delegate", { mode: "single", tasks: ["x"], resume: "/tmp" }),
    /Resume a worker session under/,
  );
  await Promise.all(
    [{ mode: "swarm" }, { model: "openai/gpt" }].map((bad) =>
      assert.rejects(
        () =>
          h.call("pstack_delegate", {
            mode: "single",
            tasks: ["x"],
            resume: first.sessionDir,
            ...bad,
          }),
        /Resume takes mode single/,
      ),
    ),
  );
  assert.equal(runs.length, 2);
});
