import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { closedTasks, isPlan, type TaskStatus } from "./lib/state.ts";

const marks: Record<TaskStatus, [mark: string, color: Parameters<Theme["fg"]>[0]]> = {
  pending: ["[ ]", "muted"],
  active: ["[>]", "accent"],
  done: ["[x]", "success"],
  blocked: ["[!]", "error"],
  skipped: ["[-]", "dim"],
};

export function planChecklist(plan: unknown, theme: Theme) {
  if (!isPlan(plan)) return new Text(theme.fg("muted", "No plan"), 0, 0);
  const title = theme.fg("toolTitle", `${plan.route} ${closedTasks(plan)}/${plan.tasks.length}`);
  const lines = plan.tasks.map((t) => {
    const [mark, color] = marks[t.status];
    return theme.fg(color, `${mark} ${t.id}. ${t.text}`);
  });
  const finished = plan.finishedEvidence === undefined ? [] : [theme.fg("success", "Finished")];
  return new Text([title, ...lines, ...finished].join("\n"), 0, 0);
}

export function planCall(
  args: { action: string; route?: string; goal?: string; task?: number; status?: string },
  theme: Theme,
) {
  const change =
    args.action === "update"
      ? `${args.task ?? "?"} → ${args.status ?? "?"}`
      : [args.route, args.goal].filter(Boolean).join(": ");
  const title = theme.fg("toolTitle", `pstack_plan ${args.action}`);
  return new Text(change ? `${title} ${theme.fg("dim", change)}` : title, 0, 0);
}

export function planResult(
  output: { content: { type: string; text?: string }[]; details: unknown },
  isError: boolean,
  theme: Theme,
) {
  if (!isError) return planChecklist(output.details, theme);
  const message = output.content.map((block) => block.text ?? "").join("\n");
  return new Text(theme.fg("error", message), 0, 0);
}
