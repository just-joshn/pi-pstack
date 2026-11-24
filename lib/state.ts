import { catalog } from "./catalog.ts";
import { isRecord } from "./validation.ts";

export const taskStatuses = ["pending", "active", "done", "blocked", "skipped"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
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
  version: 1;
  mode: boolean;
  goal: string;
  plan: Plan | null;
  wake: Wake | null;
}

export const initialState = (): State => ({
  version: 1,
  mode: false,
  goal: "",
  plan: null,
  wake: null,
});
export const isTaskStatus = (status: unknown): status is TaskStatus =>
  taskStatuses.some((known) => known === status);
const optionalText = (value: unknown) => value === undefined || typeof value === "string";
const isTask = (task: unknown, i: number): task is Task =>
  isRecord(task) &&
  task.id === i + 1 &&
  typeof task.text === "string" &&
  isTaskStatus(task.status) &&
  typeof task.evidence === "string";
const isPlan = (plan: unknown): plan is Plan =>
  isRecord(plan) &&
  typeof plan.route === "string" &&
  typeof plan.goal === "string" &&
  Array.isArray(plan.tasks) &&
  plan.tasks.length > 0 &&
  plan.tasks.every(isTask) &&
  optionalText(plan.finishedEvidence);
const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const isWake = (wake: unknown): wake is Wake =>
  isRecord(wake) &&
  inRange(wake.seconds, 5, 86400) &&
  inRange(wake.max, 1, 100) &&
  inRange(wake.count, 0, wake.max) &&
  typeof wake.predicate === "string" &&
  typeof wake.running === "boolean" &&
  optionalText(wake.stopEvidence);
const isState = (state: unknown): state is State =>
  isRecord(state) &&
  state.version === 1 &&
  typeof state.mode === "boolean" &&
  typeof state.goal === "string" &&
  (state.plan === null || isPlan(state.plan)) &&
  (state.wake === null || isWake(state.wake));

export const stateType = "pstack-state";
export const stopped = (wake: Wake | null, stopEvidence?: string): Wake | null =>
  wake && { ...wake, running: false, ...(stopEvidence === undefined ? {} : { stopEvidence }) };
export function restore(entries: readonly unknown[]): State {
  const saved = entries.findLast(
    (entry) => isRecord(entry) && entry.type === "custom" && entry.customType === stateType,
  );
  if (!isRecord(saved) || !isState(saved.data)) return initialState();
  const state = structuredClone(saved.data);
  return { ...state, wake: stopped(state.wake) };
}

export function startPlan(route: string, goal: string, customSteps?: string[]): Plan {
  if (!goal.trim()) throw Error("A goal is required");
  const steps = route === "figure-it-out" ? customSteps : catalog.steps[route];
  if (!steps?.length || steps.some((s) => !s.trim()))
    throw Error("Choose a known playbook or supply custom steps");
  return {
    route,
    goal,
    tasks: steps.map((text, i) => ({ id: i + 1, text, status: "pending", evidence: "" })),
  };
}
export function updateTask(plan: Plan | null, id: number, status: TaskStatus, evidence = ""): Plan {
  if (!plan) throw Error("No active plan");
  const current = plan.tasks.find((t) => t.id === id);
  if (!current) throw Error("Unknown task");
  if (["done", "blocked", "skipped"].includes(status) && !evidence.trim())
    throw Error("Evidence or a reason is required");
  const { finishedEvidence, ...open } = plan;
  const tasks = plan.tasks.map((t) => (t.id === id ? { ...t, status, evidence } : t));
  return current.status === status && finishedEvidence !== undefined
    ? { ...open, tasks, finishedEvidence }
    : { ...open, tasks };
}
export function planComplete(plan: Plan | null) {
  return !!plan && plan.tasks.every((t) => t.status === "done" || t.status === "skipped");
}
export const summary = (state: State) => ({
  mode: state.mode,
  goal: state.goal,
  plan: state.plan,
  wake: state.wake,
  complete: planComplete(state.plan),
});
export function wakeConfig(seconds: number, max: number, predicate: string): Wake {
  if (!inRange(seconds, 5, 86400) || !inRange(max, 1, 100) || !predicate.trim())
    throw Error("Wake requires 5–86400 seconds, 1–100 iterations, and a predicate");
  return { seconds, max, predicate, count: 0, running: true };
}
