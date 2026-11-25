import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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

const parity = JSON.parse(readFileSync(join(root, "reference/parity.json"), "utf8"));
void test("all original nodes, edges and views are preserved and mapped", () => {
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
void test("76 native skills, 22 ordered playbooks and all conditional links", () => {
  const skills = Object.entries(catalog.paths).filter(([, p]) => p.endsWith("SKILL.md"));
  assert.equal(skills.length, 76);
  assert.equal(skills.filter(([id]) => id.startsWith("principle-")).length, 24);
  assert.equal(routes.length, 22);
  assert.equal(new Set(skills.map(([, p]) => p)).size, 76);
  for (const [id, p] of skills) {
    const f = readFileSync(join(root, p), "utf8");
    const match = f.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n/);
    assert(match, id);
    assert.equal(match[1], p.split("/")[1]);
    assert(match[1].length <= 64);
    assert(JSON.parse(match[2]).length <= 1024);
    assert(!f.includes("~/.cursor"));
  }
  for (const r of routes) {
    const n = nativeNode("pb-" + r);
    assert(n.instructions.includes("## Ordered steps"));
    assert.equal(startPlan(r, "goal").tasks.length, catalog.steps[r].length);
    for (const e of n.outgoing) assert(n.instructions.includes("`" + e.to + "`"));
  }
  for (const p of Object.values(catalog.paths)) assert(existsSync(join(root, p)), p);
});
void test("catalog nodes return their declared instruction files, not display labels", () => {
  for (const [id, path] of [
    ["benny-setup", "reference/benny/setup.md"],
    ["benny-triage", "reference/benny/triage.md"],
    ["benny-repro", "reference/benny/repro.md"],
    ["kit-quality-agent", "agents/quality-agent.md"],
    ["kit-no-inline-imports", "reference/rules/no-inline-imports.md"],
  ])
    assert.equal(nativeNode(id).instructions, readFileSync(join(root, path), "utf8"), id);
  assert.equal(nativeNode("benny-config").instructions, undefined);
});
void test("search and catalog reject missing references", () => {
  assert(lookup("runtime diagnosis").some((n) => n.id === "pb-runtime-forensics"));
  assert.throws(() => view("unknown"));
  assert.throws(() => nativeNode("unknown"));
});
void test("roles, budget, alias and cross-vendor judge validation", () => {
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
function completedPlan() {
  const plan = startPlan("bug-fix", "repair");
  const [first, ...rest] = plan.tasks;
  return rest.reduce(
    (p, task) => updateTask(p, task.id, "skipped", "not applicable"),
    updateTask(plan, first.id, "done", "red test output"),
  );
}
const savedState = (data) => ({ type: "custom", customType: "pstack-state", data });

void test("a plan needs a goal and known or custom steps", () => {
  assert.throws(() => startPlan("unknown", "goal"));
  assert.throws(() => startPlan("bug-fix", " "));
  assert.throws(() => startPlan("figure-it-out", "goal", []));
  assert.equal(startPlan("figure-it-out", "goal", ["custom"]).tasks.length, 1);
});
void test("closing a task requires evidence and a known task", () => {
  const plan = startPlan("bug-fix", "repair");
  assert(!planComplete(plan));
  assert.throws(() => updateTask(plan, 1, "done"));
  assert.throws(() => updateTask(plan, 100, "done", "proof"));
  assert.throws(() => updateTask(null, 1, "done", "proof"));
  assert(planComplete(completedPlan()));
});
void test("final evidence survives re-recording a task but not a changed status", () => {
  const finished = { ...completedPlan(), finishedEvidence: "green" };
  assert.equal(updateTask(finished, 1, "done", "rerun").finishedEvidence, "green");
  assert.equal(updateTask(finished, 1, "skipped", "never ran").finishedEvidence, undefined);
  const reopened = updateTask(finished, 1, "active");
  assert(!planComplete(reopened));
  assert.equal(reopened.finishedEvidence, undefined);
});
void test("restore takes the latest saved state and pauses its wake loop", () => {
  const state = {
    ...initialState(),
    mode: true,
    plan: completedPlan(),
    wake: wakeConfig(5, 3, "green"),
  };
  const saved = savedState(state);
  assert.equal(restore([saved]).mode, true);
  assert.equal(restore([saved]).wake.running, false);
  assert.equal(state.wake.running, true);
  assert.equal(restore([]).plan, null);
  const unrelated = { type: "custom", customType: "other", data: { version: 1 } };
  assert.equal(restore([saved, null, unrelated]).plan.goal, "repair");
});
void test("restore keeps recorded stop evidence and rejects a malformed one", () => {
  const state = { ...initialState(), plan: completedPlan(), wake: wakeConfig(5, 3, "green") };
  const withEvidence = (stopEvidence) =>
    savedState({ ...state, wake: { ...state.wake, stopEvidence } });
  assert.equal(restore([withEvidence("green")]).wake.stopEvidence, "green");
  assert.equal(restore([withEvidence(1)]).plan, null);
});
void test("an invalid latest state cannot resurrect an earlier shipping plan", () => {
  const data = { ...initialState(), plan: startPlan("shipping", "previous plan") };
  const saved = { type: "custom", customType: "pstack-state", data };
  for (const invalid of [{ ...data, plan: {} }, { ...data, version: 2 }, null]) {
    assert.deepEqual(restore([saved, { ...saved, data: invalid }]), initialState());
  }
});
void test("bounded wakes and TSV escaping", () => {
  assert.equal(wakeConfig(5, 1, "done").count, 0);
  for (const v of [0, 4, 86401, NaN]) assert.throws(() => wakeConfig(v, 1, "done"));
  assert.throws(() => wakeConfig(5, 101, "done"));
  assert.equal(tsvRow(["a\tb", "c\nd", "e\rf"]), "a b\tc d\te f\n");
});
void test("parallel pool limits concurrency, keeps input order and isolates failures", async () => {
  let active = 0,
    peak = 0;
  const output = await pool([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 3));
    active--;
    if (n === 3) throw Error("bad");
    return n * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(
    output.map((x) => (x.status === "fulfilled" ? x.value : x.reason)),
    [2, 4, "bad", 8, 10],
  );
});
void test("worker flags disable nested extensions and MCP, and reviewers cannot write", () => {
  const base = {
    model: "anthropic/claude",
    thinking: "high",
    sessionDir: "/tmp/pstack",
    sessionId: "worker-1",
    prompt: "--not-a-flag",
  };
  const read = workerArgs({ ...base, readOnly: true }),
    write = workerArgs({ ...base, readOnly: false });
  assert(read.includes("--no-mcp"));
  assert(read.includes("--no-extensions"));
  assert.equal(read[read.indexOf("--tools") + 1], "read,grep,find,ls");
  assert.equal(write[write.indexOf("--tools") + 1], "read,grep,find,ls,bash,edit,write");
  assert.deepEqual(read.slice(-2), ["--", "--not-a-flag"]);
  assert(!read.includes("-e"));
  const provided = workerArgs({ ...base, readOnly: true, extension: "/provider.ts" });
  assert.equal(provided[provided.indexOf("-e") + 1], "/provider.ts");
  assert(provided.includes("--no-extensions"));
  assert(provided.indexOf("-e") < provided.indexOf("--"));
});
void test("every worker role with a contract has its file in agents/", () => {
  const contracts = [...workerRoles.values()].flatMap((role) => role.contract ?? []);
  assert.equal(contracts.length, 4);
  for (const contract of contracts) assert(existsSync(join(root, "agents", contract)), contract);
});
void test("worktree porcelain preserves spaces and locked status", () => {
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
void test("NUL-delimited worktree output preserves newline and trailing space in paths", () => {
  const [tree] = parseWorktrees("worktree /a\nb \0HEAD abc\0detached\0\0");
  assert.equal(tree.path, "/a\nb ");
  assert.equal(tree.head, "abc");
});

void test("bare Git worktree entries have no HEAD", () => {
  const [tree] = parseWorktrees("worktree /bare.git\0bare\0\0");
  assert.equal(tree.bare, true);
  assert.equal(tree.head, undefined);
});

const proof = (n) => ({ number: n, head: `sha${n}`, evidence: "actual run", independent: true });
const pr = (n) => ({
  number: n,
  headRefOid: `sha${n}`,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
});

void test("shipping stops at stale head, missing proof, failing checks or noncontiguous prefix", () => {
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
void test("blinded transcript removes model metadata and read audit finds actual read call paths", () => {
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
          { type: "toolCall", id: "ok", name: "read", arguments: { path: "/tmp/candidate.jsonl" } },
          {
            type: "toolCall",
            id: "denied",
            name: "read",
            arguments: { path: "/tmp/denied.jsonl" },
          },
          { type: "toolCall", id: "pending", name: "read", arguments: { path: "/tmp/lost.jsonl" } },
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
