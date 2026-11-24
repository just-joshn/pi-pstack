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
export interface MapView {
  id: string;
  parent: string | null;
  title: string;
  caption: string;
  nodeIds: string[];
  edges: (string | Edge)[];
}
export const root: string;
export const map: { nodes: NodeRecord[]; edges: Edge[]; views: MapView[]; version: string };
export const catalog: {
  paths: Record<string, string>;
  steps: Record<string, string[]>;
  implementations: Record<string, [string, string]>;
};
export const nodes: Map<string, NodeRecord>;
export const views: Map<string, MapView>;
export const edges: Map<string, Edge>;
export const routes: string[];
export const roles: string[];
export const budgets: string[];
export const aliases: string[];
export type Effort = "low" | "medium" | "high" | "xhigh";
export interface RoleConfig {
  defaults: number;
  budget: string;
  roles: Record<string, string[]>;
}
export function effort(role: string, budget: string, model?: string): Effort;
export function defaultConfig(): RoleConfig;
export function applyConfigPatch(config: RoleConfig, patch: unknown): RoleConfig;
export function parseModelConfig(config: unknown): RoleConfig;
export function validateConfig(config: unknown, available: string[]): RoleConfig;
export function modelFor(value: string, parent: string): string;
export function vendor(model: string): string;
export function crossJudge(
  config: RoleConfig,
  parent: string,
  candidates?: string[],
): string | undefined;
export function selectPanel(config: RoleConfig, role: string, count: number): string[];
export interface NativeNode {
  id: string;
  label: string;
  kind: string;
  what: string;
  when: string;
  classification: string;
  implementation: string;
  sources: string[];
  instructions?: string;
  outgoing: Edge[];
  incoming: Edge[];
}
export function nativeNode(id: string): NativeNode;
export function view(id: string): {
  id: string;
  parent: string | null;
  title: string;
  caption: string;
  children: string[];
  nodes: { id: string; label: string; implementation: string }[];
  edges: Edge[];
};
export function lookup(query: string): { id: string; kind: string; when: string }[];
export type TaskStatus = "pending" | "active" | "done" | "blocked" | "skipped";
export function isTaskStatus(status: unknown): status is TaskStatus;
export interface Task {
  id: number;
  text: string;
  status: TaskStatus;
  evidence: string;
}
export interface Plan {
  route: string;
  goal: string;
  tasks: Task[];
  finishedEvidence?: string;
}
export interface Wake {
  seconds: number;
  max: number;
  predicate: string;
  count: number;
  running: boolean;
  stopEvidence?: string;
}
export interface State {
  version: number;
  mode: boolean;
  goal: string;
  plan: Plan | null;
  wake: Wake | null;
}
export function initialState(): State;
export function restore(entries: readonly unknown[]): State;
export function startPlan(route: string, goal: string, customSteps?: string[]): Plan;
export function updateTask(
  plan: Plan | null,
  id: number,
  status: TaskStatus,
  evidence?: string,
): Plan;
export function planComplete(plan: Plan | null): boolean;
export function wakeConfig(seconds: number, max: number, predicate: string): Wake;
export function tsvRow(values: unknown[]): string;
export type PoolResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: string };
export function pool<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<PoolResult<U>[]>;
export function workerArgs(options: {
  model: string;
  thinking: Effort;
  readOnly: boolean;
  sessionDir: string;
  sessionId: string;
  prompt: string;
}): string[];
export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
}
export function parseWorktrees(text: string): Worktree[];
export interface Proof {
  number: number;
  head: string;
  evidence: string;
  independent: boolean;
}
export interface PullRequestStatus {
  number: number;
  headRefOid: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  statusCheckRollup: { status?: string; conclusion?: string; state?: string }[] | null;
  url: string;
}
export function verifiedPrefix<T extends Proof>(proofs: T[], statuses: PullRequestStatus[]): T[];
export function blindTranscript(raw: string, model: string): string;
export function readPaths(raw: string): string[];
