import type { PlanDayKind, PlanProgress, Target, WeekPlanExercise, WeightUnit } from "@/api";
import { formatPounds } from "@/workout/units";

// Text for the Plan screen, from the same values Signal's /plan prints.

export function planQueryKey(scope: string): readonly ["plan", string] {
  return ["plan", scope];
}

/** `Strength`, `Rest`. */
export function kindLabel(kind: PlanDayKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Sets and reps as the plan writes them: `3 × 10-12`, `30 min easy` (one
 * set), `3 sets`, or empty. The same cases as Signal's `/plan` lines.
 */
export function prescription(exercise: Pick<WeekPlanExercise, "sets" | "reps">): string {
  const reps = exercise.reps.trim();
  if (exercise.sets <= 1) return reps;
  return reps ? `${exercise.sets} × ${reps}` : `${exercise.sets} sets`;
}

/**
 * The next target, as Signal's `@ 190 lb, aim 10/10/10 (+10 lb)`:
 * `190 lb · aim 10/10/10 · +10 lb`. Weights in the profile's unit. Null
 * without a target (timed work).
 */
export function targetText(target: Target | null, unit: WeightUnit): string | null {
  if (!target) return null;
  const note = target.note?.trim() ?? "";
  if (target.reps.length === 0) return note || null;
  const aim = `aim ${target.reps.join("/")}`;
  const parts = target.weight_lb === null ? [aim] : [formatPounds(target.weight_lb, unit), aim];
  if (note) parts.push(note);
  return parts.join(" · ");
}

/** Signal's `📊 This week so far` line, one fact per entry. */
export function progressLines(progress: PlanProgress): string[] {
  const lines = [
    progress.sessions_planned > 0
      ? `${progress.sessions_matched} of ${progress.sessions_planned} planned sessions done`
      : "No sessions planned yet this week",
    `${progress.cardio_minutes} min cardio logged`,
  ];
  if (progress.planned_cardio_minutes > 0 || progress.sessions_planned > 0) {
    lines.push(`${progress.planned_cardio_minutes} min on planned cardio or mixed days`);
  }
  return lines;
}

/** `Mon, Oct 26` for a `YYYY-MM-DD` day. */
export function shortDate(date: string): string {
  const day = new Date(`${date}T12:00:00`);
  if (Number.isNaN(day.getTime())) return date;
  return `${WEEKDAYS[day.getDay()]}, ${MONTHS[day.getMonth()]} ${day.getDate()}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
