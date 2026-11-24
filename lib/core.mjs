import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "./validation.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
export const map = readJson("reference/source-map.json");
export const catalog = readJson("lib/catalog-data.json");
export const nodes = new Map(map.nodes.map((n) => [n.id, n]));
export const views = new Map(map.views.map((v) => [v.id, v]));
export const edges = new Map(map.edges.map((e) => [e.id, e]));
const outgoing = new Map();
const incoming = new Map();
for (const edge of map.edges) {
  for (const [index, key] of [
    [outgoing, edge.from],
    [incoming, edge.to],
  ]) {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(edge);
  }
}
export const routes = Object.keys(catalog.steps);
export const roles = [
  "feature, refactoring",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "judgment and prose",
  "arena runners",
  "arena cross-judge pool",
  "swarm workers",
  "interrogate reviewers",
];
const panels = new Set(["arena runners", "arena cross-judge pool", "interrogate reviewers"]);
export const budgets = ["large", "medium", "small"];
export const aliases = ["auto", "inherit-parent"];
const levels = ["low", "medium", "high", "xhigh"];
const baseEffort = (role) => (panels.has(role) || role === "swarm workers" ? "high" : "xhigh");
export function effort(role, budget, model = "") {
  const i = budgets.indexOf(budget);
  if (i < 0 || !roles.includes(role)) throw Error("Unknown role or budget");
  return levels[
    Math.max(
      0,
      levels.indexOf(panels.has(role) && /gemini/i.test(model) ? "xhigh" : baseEffort(role)) - i,
    )
  ];
}
export function defaultConfig() {
  return {
    defaults: 3,
    budget: "large",
    roles: Object.fromEntries(
      roles.map((r) => [r, r === "arena cross-judge pool" ? [] : ["inherit-parent"]]),
    ),
  };
}
export function applyConfigPatch(config, patch) {
  if (!isRecord(patch) || ("roles" in patch && !isRecord(patch.roles)))
    throw Error("Invalid model configuration patch");
  return parseModelConfig({ ...config, ...patch, roles: { ...config.roles, ...patch.roles } });
}
export function parseModelConfig(config) {
  if (
    !isRecord(config) ||
    config.defaults !== 3 ||
    !budgets.includes(config.budget) ||
    !isRecord(config.roles) ||
    Object.keys(config.roles).length !== roles.length
  )
    throw Error("Invalid model configuration");
  for (const r of roles) {
    const values = config.roles[r];
    if (
      !Array.isArray(values) ||
      (!panels.has(r) && values.length !== 1) ||
      (r !== "arena cross-judge pool" && values.length === 0) ||
      values.length > 8 ||
      values.some((v) => typeof v !== "string" || !v.trim())
    )
      throw Error(`Invalid selection for ${r}`);
    if (r === "arena cross-judge pool" && values.some((v) => aliases.includes(v)))
      throw Error("Judge pool requires explicit models");
  }
  return { defaults: config.defaults, budget: config.budget, roles: config.roles };
}
export function validateConfig(input, available) {
  const config = parseModelConfig(input);
  const allowed = new Set([...aliases, ...available]);
  for (const r of roles) {
    if (config.roles[r].some((v) => !allowed.has(v))) throw Error(`Unavailable model for ${r}`);
  }
  return config;
}
export function modelFor(value, parent) {
  if (aliases.includes(value)) {
    if (!parent) throw Error("No parent model selected");
    return parent;
  }
  return value;
}
export function vendor(model) {
  const [provider, ...rest] = model.toLowerCase().split("/");
  const id = rest.join("/");
  if (/(^|[/.-])claude|anthropic/.test(id)) return "anthropic";
  if (/(^|[/.-])gemini|google/.test(id)) return "google";
  if (/(^|[/.-])(gpt|o[1-9]|codex)([/.-]|$)|openai/.test(id)) return "openai";
  if (/(^|[/.-])grok|xai/.test(id)) return "xai";
  return provider;
}
export function crossJudge(config, parent, candidates = []) {
  const excluded = new Set([parent, ...candidates].map(vendor));
  return config.roles["arena cross-judge pool"].find((m) => !excluded.has(vendor(m)));
}
export function selectPanel(config, role, count) {
  if (!Number.isInteger(count) || count < 1 || count > 8)
    throw Error("Worker count must be 1 to 8");
  const choices = config.roles[role];
  if (!choices?.length) throw Error(`No models configured for ${role}`);
  return Array.from({ length: count }, (_, i) => choices[i % choices.length]);
}
export function nativeNode(id) {
  const n = nodes.get(id);
  if (!n) throw Error(`Unknown node: ${id}`);
  const [classification, implementation] = catalog.implementations[id];
  const path = catalog.paths[id] ?? implementation.split(" + ")[0];
  const instructionFile = /^(agents|reference)\/[^ ]+\.md$/.test(path) || !!catalog.paths[id];
  return {
    id,
    label: n.label,
    kind: n.kind,
    what: n.what,
    when: n.when,
    classification,
    implementation,
    sources: n.source,
    instructions: instructionFile ? readFileSync(join(root, path), "utf8") : undefined,
    outgoing: outgoing.get(id) ?? [],
    incoming: incoming.get(id) ?? [],
  };
}
export function view(id) {
  const v = views.get(id);
  if (!v) throw Error(`Unknown view: ${id}`);
  return {
    id,
    parent: v.parent,
    title: v.title,
    caption: v.caption,
    children: map.views.filter((x) => x.parent === id).map((x) => x.id),
    nodes: v.nodeIds.map((n) => ({
      id: n,
      label: nodes.get(n).label,
      implementation: catalog.implementations[n][1],
    })),
    edges: v.edges.map((e) => (typeof e === "string" ? edges.get(e) : edges.get(e.id))),
  };
}
export function lookup(query) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return map.nodes
    .filter((n) =>
      words.every((w) => `${n.id} ${n.label} ${n.what} ${n.when}`.toLowerCase().includes(w)),
    )
    .map((n) => ({ id: n.id, kind: n.kind, when: n.when }));
}
export const initialState = () => ({ version: 1, mode: false, goal: "", plan: null, wake: null });
const taskStatuses = new Set(["pending", "active", "done", "blocked", "skipped"]);
export const isTaskStatus = (status) => taskStatuses.has(status);
const isTask = (task, i) =>
  isRecord(task) &&
  task.id === i + 1 &&
  typeof task.text === "string" &&
  isTaskStatus(task.status) &&
  typeof task.evidence === "string";
const isPlan = (plan) =>
  isRecord(plan) &&
  typeof plan.route === "string" &&
  typeof plan.goal === "string" &&
  Array.isArray(plan.tasks) &&
  plan.tasks.length > 0 &&
  plan.tasks.every(isTask) &&
  (plan.finishedEvidence === undefined || typeof plan.finishedEvidence === "string");
const isWake = (wake) =>
  isRecord(wake) &&
  Number.isInteger(wake.seconds) &&
  wake.seconds >= 5 &&
  wake.seconds <= 86400 &&
  Number.isInteger(wake.max) &&
  wake.max >= 1 &&
  wake.max <= 100 &&
  Number.isInteger(wake.count) &&
  wake.count >= 0 &&
  wake.count <= wake.max &&
  typeof wake.predicate === "string" &&
  typeof wake.running === "boolean" &&
  (wake.stopEvidence === undefined || typeof wake.stopEvidence === "string");
const isState = (state) =>
  isRecord(state) &&
  state.version === 1 &&
  typeof state.mode === "boolean" &&
  typeof state.goal === "string" &&
  (state.plan === null || isPlan(state.plan)) &&
  (state.wake === null || isWake(state.wake));
export function restore(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pstack-state")
      continue;
    if (!isState(entry.data)) return initialState();
    const state = structuredClone(entry.data);
    if (state.wake) state.wake.running = false;
    return state;
  }
  return initialState();
}
export function startPlan(route, goal, customSteps) {
  if (!goal.trim()) throw Error("A goal is required");
  const steps = route === "figure-it-out" ? customSteps : catalog.steps[route];
  if (
    !Array.isArray(steps) ||
    !steps.length ||
    steps.some((s) => typeof s !== "string" || !s.trim())
  )
    throw Error("Choose a known playbook or supply custom steps");
  return {
    route,
    goal,
    tasks: steps.map((text, i) => ({ id: i + 1, text, status: "pending", evidence: "" })),
  };
}
export function updateTask(plan, id, status, evidence = "") {
  if (!plan) throw Error("No active plan");
  if (!isTaskStatus(status)) throw Error("Invalid task status");
  if (!plan.tasks.some((t) => t.id === id)) throw Error("Unknown task");
  if (["done", "blocked", "skipped"].includes(status) && !evidence.trim())
    throw Error("Evidence or a reason is required");
  const { finishedEvidence: _, ...open } = plan;
  const unchanged = plan.tasks.some((t) => t.id === id && t.status === status);
  const tasks = plan.tasks.map((t) => (t.id === id ? { ...t, status, evidence } : t));
  const next = { ...open, tasks };
  return unchanged && plan.finishedEvidence !== undefined
    ? { ...next, finishedEvidence: plan.finishedEvidence }
    : next;
}
export function planComplete(plan) {
  return !!plan && plan.tasks.every((t) => ["done", "skipped"].includes(t.status));
}
export function wakeConfig(seconds, max, predicate) {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 5 ||
    seconds > 86400 ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 100 ||
    !predicate.trim()
  )
    throw Error("Wake requires 5–86400 seconds, 1–100 iterations, and a predicate");
  return { seconds, max, predicate, count: 0, running: true };
}
export function tsvRow(values) {
  return (
    values
      .map((v) => String(v).replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " "))
      .join("\t") + "\n"
  );
}
export async function pool(items, concurrency, fn) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw Error("Concurrency must be 1 to 8");
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- One item at a time per worker.
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (error) {
        results[i] = {
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, worker));
  return results;
}
export function workerArgs({ model, thinking, readOnly, sessionDir, sessionId, prompt }) {
  return [
    "--print",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--tools",
    readOnly ? "read,grep,find,ls" : "read,grep,find,ls,bash,edit,write",
    "--session-dir",
    sessionDir,
    "--session-id",
    sessionId,
    "--model",
    model,
    "--thinking",
    thinking,
    "--",
    prompt,
  ];
}
export function parseWorktrees(text) {
  const separator = text.includes("\0") ? "\0" : "\n";
  return text
    .split(separator.repeat(2))
    .filter(Boolean)
    .map((block) => {
      const fields = Object.fromEntries(
        block
          .split(separator)
          .filter(Boolean)
          .map((line) => {
            const i = line.indexOf(" ");
            return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
          }),
      );
      return {
        path: fields.worktree,
        head: fields.HEAD,
        branch: fields.branch,
        locked: !!fields.locked,
        prunable: !!fields.prunable,
        bare: !!fields.bare,
      };
    });
}
export function verifiedPrefix(proofs, statuses) {
  const byNumber = new Map(statuses.map((status) => [status.number, status]));
  const result = [];
  for (const proof of proofs) {
    const pr = byNumber.get(proof.number);
    if (
      !pr ||
      !proof.evidence?.trim() ||
      !proof.independent ||
      proof.head !== pr.headRefOid ||
      pr.state !== "OPEN" ||
      pr.isDraft ||
      pr.mergeable !== "MERGEABLE" ||
      pr.mergeStateStatus !== "CLEAN" ||
      !pr.statusCheckRollup?.length ||
      !pr.statusCheckRollup.every((c) =>
        c.status === "COMPLETED"
          ? ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)
          : c.state === "SUCCESS",
      )
    )
      break;
    result.push(proof);
  }
  return result;
}

function sessionMessages(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((e) => e.type === "message" && e.message)
    .map((e) => e.message);
}
export function blindTranscript(raw, model) {
  return sessionMessages(raw)
    .map((m) =>
      JSON.stringify({
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        isError: m.isError,
      })
        .replaceAll(model, "[redacted-model]")
        .replaceAll(model.split("/").slice(1).join("/"), "[redacted-model]"),
    )
    .join("\n");
}
export function readPaths(raw) {
  const messages = sessionMessages(raw);
  const succeeded = new Set(
    messages
      .filter((m) => m.role === "toolResult" && m.isError !== true && m.toolCallId)
      .map((m) => m.toolCallId),
  );
  return messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content
          .filter(
            (c) =>
              c.type === "toolCall" &&
              c.name === "read" &&
              typeof c.arguments?.path === "string" &&
              succeeded.has(c.id),
          )
          .map((c) => c.arguments.path)
      : [],
  );
}
