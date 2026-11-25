import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, test } from "vitest";

import {
  catalog,
  lookup,
  map,
  nativeNode,
  nodes,
  root,
  routes,
  view,
  views,
} from "../lib/catalog.ts";
import {
  crossJudge,
  defaultConfig,
  effort,
  modelFor,
  selectPanel,
  validateConfig,
  vendor,
} from "../lib/models.ts";
import { pool } from "../lib/pool.ts";
import {
  initialState,
  planComplete,
  restore,
  startPlan,
  updateTask,
  wakeConfig,
} from "../lib/state.ts";
import { blindTranscript, readPaths } from "../lib/transcript.ts";
import { workerArgs, workerRoles } from "../src/delegate.ts";
import { verifiedPrefix } from "../src/forge.ts";
import { tsvRow } from "../src/support.ts";
import { parseWorktrees } from "../src/worktrees.ts";
import { flag, shaped } from "./support.ts";

const packaged = (path: string) => readFile(join(root, path), "utf8");
const parity = shaped<{ nodes: { id: string }[]; edges: unknown; views: unknown }>(
  JSON.parse(await packaged("reference/parity.json")),
);
function completedPlan() {
  const plan = startPlan("bug-fix", "repair");
  const [first, ...rest] = plan.tasks;
  assert(first);
  return rest.reduce(
    (p, task) => updateTask(p, task.id, "skipped", "not applicable"),
    updateTask(plan, first.id, "done", "red test output"),
  );
}
const savedState = (data: unknown) => ({ type: "custom", customType: "pstack-state", data });

const proof = (n: number) => ({
  number: n,
  head: `sha${n}`,
  evidence: "actual run",
  independent: true,
});
const pr = (n: number) => ({
  number: n,
  url: `https://example.invalid/pull/${n}`,
  headRefOid: `sha${n}`,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
});

describe("core", () => {
  test("all original nodes, edges and views are preserved and mapped", () => {
    assert.equal(nodes.size, 161);
    assert.equal(map.edges.length, 163);
    assert.equal(views.size, 65);
    assert.equal(new Set(parity.nodes.map((n) => n.id)).size, 161);
    assert.deepEqual(parity.edges, map.edges);
    assert.deepEqual(
      parity.views,
      map.views.map((v) => v.id),
    );
    assert.deepEqual(new Set(parity.nodes.map((n) => n.id)), new Set(nodes.keys()));
    for (const e of map.edges) {
      assert(nodes.has(e.from));
      assert(nodes.has(e.to));
      assert(nativeNode(e.from).outgoing.some((x) => x.id === e.id));
      assert(nativeNode(e.to).incoming.some((x) => x.id === e.id));
    }
    for (const v of map.views) {
      const resolved = view(v.id);
      assert.equal(resolved.nodes.length, v.nodeIds.length);
      assert(resolved.edges.every(Boolean));
      if (v.parent) assert(views.has(v.parent));
    }
    assert.equal(view("all-dependencies").edges.length, 163);
  });
  test("76 native skills, 22 ordered playbooks and all conditional links", async () => {
    const skills = Object.entries(catalog.paths).filter(([, p]) => p.endsWith("SKILL.md"));
    assert.equal(skills.length, 76);
    assert.equal(skills.filter(([id]) => id.startsWith("principle-")).length, 24);
    assert.equal(routes.length, 22);
    assert.equal(new Set(skills.map(([, p]) => p)).size, 76);
    await Promise.all(
      skills.map(async ([id, p]) => {
        const f = await packaged(p);
        const [, name = "", description = ""] =
          /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n/.exec(f) ?? [];
        assert(name, id);
        assert.equal(name, p.split("/")[1]);
        assert(name.length <= 64);
        const described: unknown = JSON.parse(description);
        assert(typeof described === "string" && described.length <= 1024);
        assert(!f.includes("~/.cursor"));
      }),
    );
    for (const r of routes) {
      const n = nativeNode("pb-" + r);
      assert(n.instructions?.includes("## Ordered steps"));
      assert.equal(startPlan(r, "goal").tasks.length, catalog.steps[r]?.length);
      for (const e of n.outgoing) assert(n.instructions?.includes("`" + e.to + "`"));
    }
    await Promise.all(Object.values(catalog.paths).map((p) => access(join(root, p))));
  });
  test("catalog nodes return their declared instruction files, not display labels", async () => {
    const declared = {
      "benny-setup": "reference/benny/setup.md",
      "benny-triage": "reference/benny/triage.md",
      "benny-repro": "reference/benny/repro.md",
      "kit-quality-agent": "agents/quality-agent.md",
      "kit-no-inline-imports": "reference/rules/no-inline-imports.md",
    };
    await Promise.all(
      Object.entries(declared).map(async ([id, path]) =>
        assert.equal(nativeNode(id).instructions, await packaged(path), id),
      ),
    );
    assert.equal(nativeNode("benny-config").instructions, undefined);
  });
  test("search and catalog reject missing references", () => {
    assert(lookup("runtime diagnosis").some((n) => n.id === "pb-runtime-forensics"));
    assert.throws(() => view("unknown"));
    assert.throws(() => nativeNode("unknown"));
  });
  test("roles, budget, alias and cross-vendor judge validation", () => {
    const cfg = defaultConfig();
    assert.equal(cfg.defaults, 3);
    assert.equal(cfg.budget, "large");
    assert.equal(Object.keys(cfg.roles).length, 9);
    validateConfig(cfg, []);
    const a = "anthropic/claude-sonnet",
      b = "google/gemini-pro",
      c = "openai/gpt-5";
    cfg.roles["arena runners"] = [a, b, c];
    cfg.roles["arena cross-judge pool"] = [a, b];
    validateConfig(cfg, [a, b, c]);
    assert.equal(modelFor("auto", a), a);
    assert.equal(modelFor("inherit-parent", a), a);
    assert.equal(crossJudge(cfg, a, [], new Set([a, b, c])), b);
    assert.equal(vendor("openrouter/anthropic/claude-sonnet"), "anthropic");
    assert.equal(vendor("openrouter/openai/gpt-5"), "openai");
    assert.equal(effort("feature, refactoring", "large"), "xhigh");
    assert.equal(effort("feature, refactoring", "medium"), "high");
    assert.equal(effort("feature, refactoring", "small"), "medium");
    assert.deepEqual(selectPanel(cfg, "arena runners", 4), [a, b, c, a]);
    assert.throws(() => validateConfig(cfg, [a]));
    cfg.roles["arena cross-judge pool"] = ["auto"];
    assert.throws(() => validateConfig(cfg, [a, b, c]));
    assert.throws(() => modelFor("auto", ""));
  });
  test("a plan needs a goal and known or custom steps", () => {
    assert.throws(() => startPlan("unknown", "goal"));
    assert.throws(() => startPlan("bug-fix", " "));
    assert.throws(() => startPlan("figure-it-out", "goal", []));
    assert.equal(startPlan("figure-it-out", "goal", ["custom"]).tasks.length, 1);
  });
  test("closing a task requires evidence and a known task", () => {
    const plan = startPlan("bug-fix", "repair");
    assert(!planComplete(plan));
    assert.throws(() => updateTask(plan, 1, "done"));
    assert.throws(() => updateTask(plan, 100, "done", "proof"));
    assert.throws(() => updateTask(null, 1, "done", "proof"));
    assert(planComplete(completedPlan()));
  });
  test("final evidence survives re-recording a task but not a changed status", () => {
    const finished = { ...completedPlan(), finishedEvidence: "green" };
    assert.equal(updateTask(finished, 1, "done", "rerun").finishedEvidence, "green");
    assert.equal(updateTask(finished, 1, "skipped", "never ran").finishedEvidence, undefined);
    const reopened = updateTask(finished, 1, "active");
    assert(!planComplete(reopened));
    assert.equal(reopened.finishedEvidence, undefined);
  });
  test("restore takes the latest saved state and pauses its wake loop", () => {
    const state = {
      ...initialState(),
      mode: true,
      plan: completedPlan(),
      wake: wakeConfig(5, 3, "green"),
    };
    const saved = savedState(state);
    assert.equal(restore([saved]).mode, true);
    assert.equal(restore([saved]).wake?.running, false);
    assert.equal(state.wake.running, true);
    assert.equal(restore([]).plan, null);
    const unrelated = { type: "custom", customType: "other", data: { version: 1 } };
    assert.equal(restore([saved, null, unrelated]).plan?.goal, "repair");
  });
  test("restore keeps recorded stop evidence and rejects a malformed one", () => {
    const state = { ...initialState(), plan: completedPlan(), wake: wakeConfig(5, 3, "green") };
    const withEvidence = (stopEvidence: unknown) =>
      savedState({ ...state, wake: { ...state.wake, stopEvidence } });
    assert.equal(restore([withEvidence("green")]).wake?.stopEvidence, "green");
    assert.equal(restore([withEvidence(1)]).plan, null);
  });
  test("an invalid latest state cannot resurrect an earlier shipping plan", () => {
    const data = { ...initialState(), plan: startPlan("shipping", "previous plan") };
    for (const invalid of [{ ...data, plan: {} }, { ...data, version: 2 }, null]) {
      assert.deepEqual(restore([savedState(data), savedState(invalid)]), initialState());
    }
  });
  test("bounded wakes and TSV escaping", () => {
    assert.equal(wakeConfig(5, 1, "done").count, 0);
    for (const v of [0, 4, 86401, NaN]) assert.throws(() => wakeConfig(v, 1, "done"));
    assert.throws(() => wakeConfig(5, 101, "done"));
    assert.equal(tsvRow(["a\tb", "c\nd", "e\rf"]), "a b\tc d\te f\n");
  });
  test("parallel pool limits concurrency, keeps input order and isolates failures", async () => {
    let active = 0,
      peak = 0,
      calls = 0;
    const output = await pool([1, 2, 3, 4, 5], 2, async (n) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 3));
      active--;
      if (n === 3) throw Error("bad");
      return n * 2;
    });
    assert.equal(peak, 2);
    assert.equal(calls, 5);
    assert.deepEqual(
      output.map((x) => (x.status === "fulfilled" ? x.value : x.reason)),
      [2, 4, "bad", 8, 10],
    );
  });
  test("worker flags disable nested extensions and MCP, and reviewers cannot write", () => {
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
    await Promise.all(contracts.map((contract) => access(join(root, "agents", contract))));
  });
  test("worktree porcelain preserves spaces and locked status", () => {
    assert.deepEqual(
      parseWorktrees(
        "worktree /a b\nHEAD abc\nbranch refs/heads/main\n\nworktree /c\nHEAD def\ndetached\nlocked reason\n",
      ),
      [
        {
          path: "/a b",
          head: "abc",
          branch: "refs/heads/main",
          locked: false,
          prunable: false,
          bare: false,
        },
        { path: "/c", head: "def", branch: undefined, locked: true, prunable: false, bare: false },
      ],
    );
  });
  test("NUL-delimited worktree output preserves newline and trailing space in paths", () => {
    const [tree] = parseWorktrees("worktree /a\nb \0HEAD abc\0detached\0\0");
    assert.equal(tree?.path, "/a\nb ");
    assert.equal(tree.head, "abc");
  });
  test("bare Git worktree entries have no HEAD", () => {
    const [tree] = parseWorktrees("worktree /bare.git\0bare\0\0");
    assert.equal(tree?.bare, true);
    assert.equal(tree.head, undefined);
  });
  test("shipping stops at stale head, missing proof, failing checks or noncontiguous prefix", () => {
    const proofs = [proof(1), proof(2), proof(3)],
      statuses = [pr(1), pr(2), pr(3)];
    assert.equal(verifiedPrefix(proofs, statuses).length, 3);
    for (const patch of [
      { headRefOid: "changed" },
      { statusCheckRollup: [] },
      { mergeStateStatus: "BLOCKED" },
      { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
      { isDraft: true },
    ])
      assert.equal(verifiedPrefix(proofs, [pr(1), { ...pr(2), ...patch }, pr(3)]).length, 1);
    assert.equal(verifiedPrefix([{ ...proof(1), independent: false }], statuses).length, 0);
    assert.equal(verifiedPrefix([{ ...proof(1), evidence: "" }], statuses).length, 0);
  });
  test("blinded transcript removes model metadata and read audit finds actual read call paths", () => {
    const raw = [
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
    const blind = blindTranscript(raw, "anthropic/claude");
    assert(!blind.includes("anthropic"));
    assert(!blind.includes("claude"));
    assert(blind.includes("actual artifact"));
    assert.deepEqual(readPaths(raw), ["/tmp/candidate.jsonl"]);
  });
});
