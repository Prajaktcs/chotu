import type { FitnessOutcome, GoalProgress, Nutrient, StatusResponse } from "@/api";
import { workoutOverline } from "@/workout/time";

// The server rounds every number the way Signal's /status prints it, so these
// only add units: the digits always match the Signal reply for the same day.

export function statusQueryKey(scope: string): readonly ["status", string] {
  return ["status", scope];
}

/** `1840 kcal`, `121.2 g`. */
export function nutrientAmount(nutrient: Nutrient): string {
  const amount =
    nutrient.key === "calories" ? String(Math.round(nutrient.amount)) : nutrient.amount.toFixed(1);
  return `${amount} ${nutrient.unit}`;
}

/** `1840 / 2200 kcal`, `8432 / 10000 steps`. */
export function goalAmount(goal: GoalProgress): string {
  return `${goal.actual} / ${goal.goal} ${goal.unit || goal.key}`;
}

/** Signal's countdown line: `36 days to target (2026-12-01)`. */
export function countdown(fitness: FitnessOutcome): string | null {
  const days = fitness.days_to_target;
  if (days === null) return null;
  const date = fitness.target_date ?? "";
  if (days > 0) return `${days} ${days === 1 ? "day" : "days"} to target (${date})`;
  if (days === 0) return "Target day is today";
  return `Target date ${date} was ${-days} ${days === -1 ? "day" : "days"} ago`;
}

/** Whether anything was logged or synced today. */
export function hasActivity(status: StatusResponse): boolean {
  const { activity } = status;
  return (
    activity.steps > 0 ||
    activity.active_calories > 0 ||
    activity.sleep_hours !== null ||
    activity.energy !== null ||
    status.exercises.length > 0
  );
}

/** `MON, OCT 26` for a `YYYY-MM-DD` household day. */
export function dayOverline(date: string): string {
  // A calendar date, not an instant: noon keeps it on the same day in any zone.
  const day = new Date(`${date}T12:00:00`);
  return Number.isNaN(day.getTime()) ? date : workoutOverline(day, null);
}
