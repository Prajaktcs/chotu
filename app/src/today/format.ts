import { localDay } from "@/workout/time";
import type { Task } from "@/api";
import { shortDate } from "@/plan/format";

/**
 * Open tasks due on or before the household's `today`, oldest deadline first:
 * the morning brief's rule. `due_date` is already a household calendar day,
 * also for timed tasks, so the phone's timezone never moves a deadline.
 */
export function dueTasks(tasks: readonly Task[], today: string): Task[] {
  return tasks
    .filter((task) => task.status === "open" && task.due_date !== null && task.due_date <= today)
    .toSorted((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
}

/** `Overdue · Mon, Oct 26`, `Due today · 3:00 PM` or `Due today`. */
export function taskDueText(task: Task, today: string): string {
  if (task.due_date !== null && task.due_date < today)
    return `Overdue · ${shortDate(task.due_date)}`;
  if (task.due_has_time && task.due_at) {
    const at = new Date(task.due_at);
    if (!Number.isNaN(at.getTime())) {
      return `Due today · ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    }
  }
  return "Due today";
}

/** The note under a failed refresh that keeps the last loaded data on screen. */
export function keptSince(updatedAt: number): string {
  const at = new Date(updatedAt);
  return `Showing data loaded at ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`;
}

/**
 * Whether an answer loaded at `loadedAt` was loaded on the phone's current
 * date. The phone can't see the household's midnight, so a change of its own
 * date since the load means the answer may be yesterday's.
 */
export function loadedToday(loadedAt: number, now: Date = new Date()): boolean {
  return localDay(loadedAt) === localDay(now);
}
