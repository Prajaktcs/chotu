import type { Task, TasksResponse } from "@/api";

import type { TaskAction } from "./actions";

export type TaskListTab = "today" | "upcoming";
export type TaskGroup = { title: string; tasks: Task[] };

/** `YYYY-MM-DD` for this phone's day; only for servers that don't send theirs. */
function phoneDay(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** The household's today from `GET /v1/tasks`; older servers omit it. */
export function todayOf(response: TasksResponse | undefined, now = new Date()): string {
  return response?.date ?? phoneDay(now);
}

const byDue = (a: Task, b: Task) =>
  (a.due_at ?? a.due_date ?? "").localeCompare(b.due_at ?? b.due_date ?? "");

/**
 * Splits active tasks between the two list tabs so none falls between them:
 * Today has overdue, due-today and undated open tasks; Upcoming has open tasks
 * due later and every snoozed task. `due_date` is a household day.
 */
export function groupTasks(tasks: readonly Task[], today: string, tab: TaskListTab): TaskGroup[] {
  const open = tasks.filter((task) => task.status === "open");
  if (tab === "today") {
    return [
      {
        title: "Overdue",
        tasks: open.filter((t) => t.due_date !== null && t.due_date < today).sort(byDue),
      },
      { title: "Today", tasks: open.filter((t) => t.due_date === today).sort(byDue) },
      { title: "No due date", tasks: open.filter((t) => t.due_date === null) },
    ];
  }
  return [
    {
      title: "Scheduled",
      tasks: open.filter((t) => t.due_date !== null && t.due_date > today).sort(byDue),
    },
    { title: "Snoozed", tasks: tasks.filter((t) => t.status === "snoozed").sort(byDue) },
  ];
}

/** A task's deadline: date and time when it has one, else the calendar date. */
export function taskDate(task: Task): string {
  if (task.due_has_time && task.due_at) {
    return new Date(task.due_at).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  // Date-only deadlines are calendar dates, not UTC instants.
  return task.due_date
    ? new Date(`${task.due_date}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "No due date";
}

/** What a retry would resend, for the Retry unchanged explanation. */
export function actionText(action: TaskAction): string {
  if (action.kind === "complete") return "completion";
  if (action.kind === "snooze") return `${action.days}-day snooze`;
  if (action.kind === "reopen") return "unsnooze";
  return "assignment";
}
