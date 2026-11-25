import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord, parseJson } from "./validation.ts";

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

const isText = (value: unknown): value is string => typeof value === "string";
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const hasText = (value: unknown, ...keys: string[]): value is Record<string, unknown> =>
  isRecord(value) && keys.every((key) => isText(value[key]));
const isRecordOf = <T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is Record<string, T> => isRecord(value) && Object.values(value).every(isItem);

const isEdge = (value: unknown): value is Edge =>
  hasText(value, "id", "from", "to", "label", "when", "kind");
const isNode = (value: unknown): value is NodeRecord =>
  hasText(value, "id", "label", "kind", "what", "when", "how") &&
  isTexts(value["source"]) &&
  (value["opensView"] === undefined || isText(value["opensView"]));
const isView = (value: unknown): value is MapView =>
  hasText(value, "id", "title", "caption") &&
  (value["parent"] === null || isText(value["parent"])) &&
  isTexts(value["nodeIds"]) &&
  Array.isArray(value["edges"]) &&
  value["edges"].every((edge) => isText(edge) || isEdge(edge));
const isSourceMap = (value: unknown): value is SourceMap =>
  isRecord(value) &&
  Array.isArray(value["nodes"]) &&
  value["nodes"].every(isNode) &&
  Array.isArray(value["edges"]) &&
  value["edges"].every(isEdge) &&
  Array.isArray(value["views"]) &&
  value["views"].every(isView);
const isMapping = (value: unknown): value is Catalog["implementations"][string] =>
  isTexts(value) && value.length === 2;
const isCatalog = (value: unknown): value is Catalog =>
  isRecord(value) &&
  isRecordOf(value["paths"], isText) &&
  isRecordOf(value["steps"], isTexts) &&
  isRecordOf(value["implementations"], isMapping);

/** The `src` directory, which holds every file the installed extension reads. */
export const root = fileURLToPath(new URL("../", import.meta.url));
export const packageFile = (path: string) => readFileSync(join(root, path), "utf8");
function packageData<T>(path: string, isValid: (value: unknown) => value is T): T {
  const value = parseJson(packageFile(path), path);
  if (!isValid(value)) throw Error(`Invalid ${path}`);
  return value;
}
export const map = packageData("reference/source-map.json", isSourceMap);
export const catalog = packageData("lib/catalog-data.json", isCatalog);
export const nodes = new Map(map.nodes.map((n) => [n.id, n]));
export const views = new Map(map.views.map((v) => [v.id, v]));
const edges = new Map(map.edges.map((e) => [e.id, e]));
const outgoing = Map.groupBy(map.edges, (e) => e.from);
const incoming = Map.groupBy(map.edges, (e) => e.to);
export const routes = Object.keys(catalog.steps);
export const slashSkills = map.nodes.filter(
  (n) =>
    (n.kind === "public" || (n.id.startsWith("kit-") && n.label.startsWith("/"))) &&
    !n.id.startsWith("principle-"),
);

function known(id: string) {
  const n = nodes.get(id);
  if (!n) throw Error(`Unknown node: ${id}`);
  return n;
}
function mapping(id: string) {
  const entry = catalog.implementations[id];
  if (!entry) throw Error(`Unmapped node: ${id}`);
  return entry;
}
export const routeTriggers = () => routes.map((id) => ({ id, when: known("pb-" + id).when }));

export function nativeNode(id: string) {
  const n = known(id);
  const [classification, implementation] = mapping(id);
  const path = catalog.paths[id];
  return {
    id,
    label: n.label,
    kind: n.kind,
    what: n.what,
    when: n.when,
    classification,
    implementation,
    sources: n.source,
    instructions: path ? packageFile(path) : undefined,
    outgoing: outgoing.get(id) ?? [],
    incoming: incoming.get(id) ?? [],
  };
}
export function workflowPrompt(id: string, request: string) {
  const node = nativeNode(id);
  return `Execute the Pi-native workflow ${id} for the operator's request.\n\n${node.instructions ?? node.implementation}\n\nOperator request:\n${request || "(Use the current conversation context.)"}`;
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
      implementation: mapping(n)[1],
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
