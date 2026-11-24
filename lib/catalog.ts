import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NodeRecord {
  id: string;
  label: string;
  kind: string;
  what: string;
  when: string;
  how: string;
  source: string[];
  opensView?: string;
}
export interface Edge {
  id: string;
  from: string;
  to: string;
  label: string;
  when: string;
  kind: string;
}
interface MapView {
  id: string;
  parent: string | null;
  title: string;
  caption: string;
  nodeIds: string[];
  edges: (string | Edge)[];
}
interface SourceMap {
  nodes: NodeRecord[];
  edges: Edge[];
  views: MapView[];
}
interface Catalog {
  paths: Record<string, string>;
  steps: Record<string, string[]>;
  implementations: Record<string, [classification: string, implementation: string]>;
}

export const root = fileURLToPath(new URL("../", import.meta.url));
export const packageFile = (path: string) => readFileSync(join(root, path), "utf8");
export const map: SourceMap = JSON.parse(packageFile("reference/source-map.json"));
export const catalog: Catalog = JSON.parse(packageFile("lib/catalog-data.json"));
export const nodes = new Map(map.nodes.map((n) => [n.id, n]));
export const views = new Map(map.views.map((v) => [v.id, v]));
const edges = new Map(map.edges.map((e) => [e.id, e]));
const outgoing = Map.groupBy(map.edges, (e) => e.from);
const incoming = Map.groupBy(map.edges, (e) => e.to);
export const routes = Object.keys(catalog.steps);

function known(id: string) {
  const n = nodes.get(id);
  if (!n) throw Error(`Unknown node: ${id}`);
  return n;
}
export const routeTriggers = () => routes.map((id) => ({ id, when: known("pb-" + id).when }));

export function nativeNode(id: string) {
  const n = known(id);
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
    instructions: instructionFile ? packageFile(path) : undefined,
    outgoing: outgoing.get(id) ?? [],
    incoming: incoming.get(id) ?? [],
  };
}
export function view(id: string) {
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
      label: known(n).label,
      implementation: catalog.implementations[n][1],
    })),
    edges: v.edges.map((e) => edges.get(typeof e === "string" ? e : e.id)),
  };
}
export function lookup(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return map.nodes
    .filter((n) =>
      words.every((w) => `${n.id} ${n.label} ${n.what} ${n.when}`.toLowerCase().includes(w)),
    )
    .map((n) => ({ id: n.id, kind: n.kind, when: n.when }));
}
