import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { test } from "vitest";

import {
  catalog,
  lookup,
  map,
  nativeNode,
  nodes,
  routes,
  srcDir,
  view,
  views,
  workflowPrompt,
} from "../src/lib/catalog.ts";
import { startPlan } from "../src/lib/state.ts";
import { shaped } from "./support.ts";

const packaged = (path: string) => readFile(join(srcDir, path), "utf8");
const parity = shaped<{ nodes: { id: string }[]; edges: unknown; views: unknown }>(
  JSON.parse(await packaged("reference/parity.json")),
);

test("all original nodes, edges and views are preserved and mapped", () => {
  assert.equal(nodes.size, 162);
  assert.equal(map.edges.length, 163);
  assert.equal(views.size, 65);
  assert.equal(new Set(parity.nodes.map((n) => n.id)).size, 162);
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

test("77 native skills, 22 ordered playbooks and all conditional links", async () => {
  const skills = Object.entries(catalog.paths).filter(([, p]) => p.endsWith("SKILL.md"));
  assert.equal(skills.length, 77);
  assert.equal(skills.filter(([id]) => id.startsWith("principle-")).length, 24);
  assert.equal(routes.length, 22);
  assert.equal(new Set(skills.map(([, p]) => p)).size, 77);
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
  await Promise.all(Object.values(catalog.paths).map((p) => access(join(srcDir, p))));
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

test("a workflow prompt names its file, so the paths inside it resolve", () => {
  const prompt = workflowPrompt("poteto-mode", "fix it");
  const file = join(srcDir, "skills/poteto-mode/SKILL.md");
  assert(
    prompt.includes(
      `File: ${file}\nRelative paths in it resolve from ${join(srcDir, "skills/poteto-mode")}.`,
    ),
  );
  assert(prompt.endsWith("Operator request:\nfix it"));
});
