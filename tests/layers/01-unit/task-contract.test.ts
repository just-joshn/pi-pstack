import { expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";

const MANDATED_PARAMS = [
  "prompt",
  "subagent_type",
  "modelRole",
  "model",
  "thinkingLevel",
  "readonly",
  "run_in_background",
  "environment",
  "cloud_base_branch",
  "cwd",
  "worktree",
  "permissions",
  "isolation",
  "timeoutMs",
  "sessionMode",
  "resumeSessionDir",
  "resumeJobId",
  "tools",
  "persistOutput",
  "inheritParentTools",
];

interface RecordedSpawn {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

let recordedSpawns: RecordedSpawn[] = [];

function messageLine(text: string): string {
  return `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
}

function fakeSpawn(
  _command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: () => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = () => true;
  recordedSpawns = [...recordedSpawns, { args: [...args], cwd: options.cwd ?? "", env: options.env ?? {} }];
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from(messageLine("child ack"), "utf8"));
    child.emit("close", 0);
  });
  return child;
}

const nodeRequire = createRequire(import.meta.url);
const childProcessModule = nodeRequire("node:child_process") as { spawn: unknown };
childProcessModule.spawn = fakeSpawn as unknown;
const childProcessEsm = await import("node:child_process");

/**
 * Patching the CommonJS `node:child_process` binding only reaches the ESM facade
 * while nothing has materialized that facade yet. Vitest does not import
 * `node:child_process` before this file runs, so the patch lands; the guard keeps
 * the test from failing if a runner ever preloads it. spawn-contracts.test.ts
 * carries the same constraint.
 */
const SPAWN_SKIP =
  childProcessEsm.spawn === (fakeSpawn as unknown)
    ? false
    : "node:child_process ESM facade was already materialized (peer-deps preload); run node --test without --import";

/**
 * Real git through the CommonJS binding. Only `spawn` is patched above, so
 * execFileSync still launches a real process and the worktree is real.
 */
interface SyncGitRunner {
  execFileSync: (command: string, args: string[], options: { cwd: string; encoding: "utf8" }) => string;
}

const { execFileSync } = childProcessModule as unknown as SyncGitRunner;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function gitIdentity(): string[] {
  return ["-c", "user.email=harness@example.com", "-c", "user.name=harness"];
}

function initGitRepo(cwd: string): string {
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, [...gitIdentity(), "commit", "-q", "--allow-empty", "-m", "base"]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

function commitFile(cwd: string, name: string, message: string): string {
  writeFileSync(join(cwd, name), `${message}\n`, "utf8");
  git(cwd, ["add", name]);
  git(cwd, [...gitIdentity(), "commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

// Imported after the spawn patch so the child runner binds the fake, matching spawn-contracts.test.ts.
const { compilePolicyFromParams, registerTask } = await import("../../../extensions/agents/task.ts");

interface CapturedTool {
  name: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

function makeHarness(cwd: string, options: { withoutGetActiveTools?: boolean } = {}) {
  // Shadow any developer model config so model resolution is deterministic here.
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pstack-models.json"), JSON.stringify({ version: 1, roles: {} }), "utf8");
  const tools = new Map<string, CapturedTool>();
  const parentTools = {
    getActiveTools() {
      return ["read", "bash", "write", "edit"];
    },
  };
  const pi = {
    on() {},
    registerTool(definition: CapturedTool) {
      tools.set(definition.name, definition);
    },
    ...(options.withoutGetActiveTools ? {} : parentTools),
    sendUserMessage() {},
  };
  registerTask(pi as never);
  const tool = tools.get("pstack_task");
  if (!tool) throw new Error("pstack_task was not registered");
  return { tool, ctx: { model: { provider: "anthropic", id: "claude-parent-4-5" }, cwd, isProjectTrusted: () => true } };
}

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "pstack-task-contract-"));
}

function lastSpawn(): RecordedSpawn {
  const record = recordedSpawns.at(-1);
  if (!record) throw new Error("no child process was spawned");
  return record;
}

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test("pstack_task registers the mandated parameter names", () => {
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    expect(h.tool.name).toBe("pstack_task");
    expect(Object.keys(h.tool.parameters.properties).toSorted()).toEqual([...MANDATED_PARAMS].toSorted());
    expect(Value.Check(h.tool.parameters, { prompt: "brief" })).toBe(true);
    expect(Value.Check(h.tool.parameters, { prompt: "" })).toBe(false);
    expect(Value.Check(h.tool.parameters, {})).toBe(false);
    expect(Value.Check(h.tool.parameters, {
        prompt: "brief",
        subagent_type: "investigator",
        thinkingLevel: "high",
        run_in_background: false,
        environment: "hosted",
        worktree: true,
        permissions: { filesystem: "read-only", integrations: ["browser-ui"] },
      })).toBe(true);
    expect(Value.Check(h.tool.parameters, { prompt: "brief", permissions: { nope: 1 } })).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the investigator shape compiles to a read-only filesystem with inherited integrations", () => {
  const policy = compilePolicyFromParams({ prompt: "brief", subagent_type: "investigator" }, "investigator");
  expect(policy).toEqual({
    filesystem: "read-only",
    shell: "none",
    git: "read",
    network: "none",
    integrations: "inherit",
    environment: "local",
    background: false,
    isolation: "session",
  });
  const readonlyComment = compilePolicyFromParams(
    { prompt: "brief", subagent_type: "comment-sicko" },
    "comment-sicko",
  );
  expect(readonlyComment.integrations).toBe("none");
  const explicit = compilePolicyFromParams(
    {
      prompt: "brief",
      subagent_type: "general",
      readonly: true,
      permissions: { integrations: ["browser-ui"] },
      run_in_background: true,
    },
    "general",
  );
  expect(explicit.filesystem).toBe("read-only");
  expect(explicit.shell).toBe("none");
  expect(explicit.integrations).toEqual(["browser-ui"]);
  expect(explicit.background).toBe(true);
});

test("pstack_task passes the resolved thinking level into child argv", { skip: SPAWN_SKIP }, async () => {
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    const reply = await h.tool.execute(
      "call-1",
      { prompt: "RAW BRIEF", subagent_type: "investigator", thinkingLevel: "high", run_in_background: false },
      undefined,
      undefined,
      h.ctx,
    );
    const args = lastSpawn().args;
    expect(argAfter(args, "--thinking")).toBe("high");
    expect(argAfter(args, "--tools")).toBe("read,grep,find,ls,pstack_integrations,pstack_control_ui,pstack_control_cli");
    const policy = reply.details.policy as Record<string, unknown>;
    expect(policy.filesystem).toBe("read-only");
    expect(policy.integrations).toBe("inherit");
    expect(reply.details.thinkingLevel).toBe("high");
    const envPolicy = JSON.parse(lastSpawn().env.PSTACK_CHILD_POLICY ?? "{}") as Record<string, unknown>;
    expect(envPolicy).toEqual(policy);
    expect(reply.content.at(-1)?.text.includes("thinkingLevel=high")).toBe(true);

    const noLevel = await h.tool.execute(
      "call-2",
      { prompt: "RAW BRIEF", subagent_type: "general", run_in_background: false },
      undefined,
      undefined,
      h.ctx,
    );
    expect(lastSpawn().args.includes("--thinking"), "no level means no flag").toBe(false);
    expect(noLevel.details.thinkingLevel).toBe(null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hosted environment without PSTACK_HOSTED_URL fails closed naming services/worker", async () => {
  const previous = process.env.PSTACK_HOSTED_URL;
  Reflect.deleteProperty(process.env, "PSTACK_HOSTED_URL");
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    const before = recordedSpawns.length;
    await expect(
      h.tool.execute(
        "call-hosted",
        { prompt: "RAW BRIEF", subagent_type: "why", environment: "hosted" },
        undefined,
        undefined,
        h.ctx,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(/services\/worker/);
      expect(message).toMatch(/not parity/);
      expect(message).toMatch(/PSTACK_HOSTED_URL/);
      return true;
    });
    expect(recordedSpawns.length, "hosted never downgrades to a local child").toBe(before);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_HOSTED_URL");
    else process.env.PSTACK_HOSTED_URL = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("hosted environment with PSTACK_HOSTED_URL posts the envelope to /v1/tasks", async () => {
  const previous = process.env.PSTACK_HOSTED_URL;
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; init: RequestInit }> = [];
  process.env.PSTACK_HOSTED_URL = "http://worker.test/";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls = [...calls, { url: String(url), init: init ?? {} }];
    return new Response("hosted worker accepted", { status: 202, statusText: "Accepted" });
  }) as typeof globalThis.fetch;
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    const reply = await h.tool.execute(
      "call-hosted-ok",
      { prompt: "RAW BRIEF", subagent_type: "investigator", environment: "hosted" },
      undefined,
      undefined,
      h.ctx,
    );
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://worker.test/v1/tasks");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.task).toBe("RAW BRIEF");
    expect(body.role).toBe("investigator");
    expect(typeof body.runId).toBe("string");
    expect(body.parentSessionCwd).toBe(cwd);
    expect((body.policy as Record<string, unknown>).integrations).toBe("inherit");
    expect(reply.details.hosted).toBe(true);
    expect(reply.details.status).toBe(202);
    expect(reply.content[0].text).toBe("hosted worker accepted");

    globalThis.fetch = (async () =>
      new Response("worker exploded", { status: 500, statusText: "Server Error" })) as typeof globalThis.fetch;
    await expect(h.tool.execute(
        "call-hosted-fail",
        { prompt: "RAW BRIEF", environment: "hosted" },
        undefined,
        undefined,
        h.ctx,
      )).rejects.toThrow(/HTTP 500/);
  } finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) Reflect.deleteProperty(process.env, "PSTACK_HOSTED_URL");
    else process.env.PSTACK_HOSTED_URL = previous;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inheritParentTools false drops the inherited child tool allowlist", { skip: SPAWN_SKIP }, async () => {
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    await h.tool.execute(
      "call-inherit",
      { prompt: "RAW BRIEF", subagent_type: "general", run_in_background: false },
      undefined,
      undefined,
      h.ctx,
    );
    expect(argAfter(lastSpawn().args, "--tools")).toBe("read,bash,write,edit");
    await h.tool.execute(
      "call-no-inherit",
      { prompt: "RAW BRIEF", subagent_type: "general", run_in_background: false, inheritParentTools: false },
      undefined,
      undefined,
      h.ctx,
    );
    expect(lastSpawn().args.includes("--tools"), "no allowlist means the child keeps its own discovery").toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a parent pi without getActiveTools runs the child without an allowlist", { skip: SPAWN_SKIP }, async () => {
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd, { withoutGetActiveTools: true });
    const reply = await h.tool.execute(
      "call-no-active-tools",
      { prompt: "RAW BRIEF", subagent_type: "general", run_in_background: false },
      undefined,
      undefined,
      h.ctx,
    );
    expect(lastSpawn().args.includes("--tools"), "an absent getActiveTools yields no allowlist").toBe(false);
    expect(reply.details.policy).toEqual({
      filesystem: "workspace-write",
      shell: "full",
      git: "branch-write",
      network: "allowed",
      integrations: "inherit",
      environment: "local",
      background: false,
      isolation: "session",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a context without an active parent model fails before any child spawns", async () => {
  const cwd = tempCwd();
  try {
    const h = makeHarness(cwd);
    const before = recordedSpawns.length;
    await expect(
      h.tool.execute("call-no-model", { prompt: "RAW BRIEF" }, undefined, undefined, {
        cwd,
        model: undefined,
        isProjectTrusted: () => true,
      }),
    ).rejects.toThrow("pstack_task requires an active parent model");
    expect(recordedSpawns.length, "no child starts without a parent model").toBe(before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("worktree true branches the child tree from HEAD and runs the child inside it", { skip: SPAWN_SKIP }, async () => {
  const cwd = tempCwd();
  try {
    const head = initGitRepo(cwd);
    const h = makeHarness(cwd);
    const reply = await h.tool.execute(
      "call-worktree",
      { prompt: "RAW BRIEF", subagent_type: "general", run_in_background: false, worktree: true },
      undefined,
      undefined,
      h.ctx,
    );
    const tree = reply.details.worktree as string;
    expect(existsSync(tree), "the worktree exists on disk").toBe(true);
    expect(lastSpawn().cwd).toBe(tree);
    expect(git(cwd, ["-C", tree, "rev-parse", "HEAD"]).trim()).toBe(head);
    expect(reply.details.worktreeBranch).toBe(`pstack/${basename(tree)}`);
    expect(reply.content.at(-1)?.text).toContain(`worktree=${tree}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("worktree true honors a trimmed cloud_base_branch instead of HEAD", { skip: SPAWN_SKIP }, async () => {
  const cwd = tempCwd();
  try {
    const pinned = initGitRepo(cwd);
    git(cwd, ["branch", "pinned"]);
    const tip = commitFile(cwd, "next.txt", "next");
    expect(tip).not.toBe(pinned);
    const h = makeHarness(cwd);
    const reply = await h.tool.execute(
      "call-worktree-base",
      { prompt: "RAW BRIEF", subagent_type: "general", run_in_background: false, worktree: true, cloud_base_branch: " pinned " },
      undefined,
      undefined,
      h.ctx,
    );
    const tree = reply.details.worktree as string;
    expect(lastSpawn().cwd).toBe(tree);
    expect(git(cwd, ["-C", tree, "rev-parse", "HEAD"]).trim()).toBe(pinned);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
