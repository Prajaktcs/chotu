import type { LoggedSet, PlanDay, PlannedExercise, WeightUnit, Workout } from "@/api";

import type { QueuedSet } from "./queue/set-queue";
import { clampReps, formatPounds, formatSet, formatWeight, prefillWeight, toPounds } from "./units";

/** One row in Today's sets: a set the server has, or one still on this phone. */
export type SetRow = {
  /** Unique across both sources: `saved:<set id>` or `queued:<request id>`. */
  key: string;
  source: "saved" | "queued";
  /** The server's set id, or the queued set's request id. */
  id: string;
  exercise: string;
  /** Pounds; null is bodyweight. */
  weightLb: number | null;
  reps: number;
  /** `135 lb × 8`, in the profile's unit (a queued set keeps the unit it was logged in). */
  label: string;
  state: "saved" | "pending" | "failed";
  /** When it was tapped; the server doesn't return times for saved sets. */
  performedAt: string | null;
  /** The server's reason, for a failed set. */
  reason: string | null;
};

/**
 * Today's sets: the server's, minus any being undone, then the ones still on
 * this phone. A queued set leaves the queue in the same update that adds it to
 * the server's list, so it is never shown twice.
 */
export function mergeSets(
  serverSets: readonly LoggedSet[],
  queued: readonly QueuedSet[],
  unit: WeightUnit,
  hiddenIds: ReadonlySet<string> = new Set(),
): SetRow[] {
  const saved = serverSets
    .filter((set) => !hiddenIds.has(set.id))
    .map((set): SetRow => ({
      key: `saved:${set.id}`,
      source: "saved",
      id: set.id,
      exercise: set.exercise,
      weightLb: set.weight_lb,
      reps: set.reps,
      label: formatSet(formatPounds(set.weight_lb, unit), set.reps),
      state: "saved",
      performedAt: null,
      reason: null,
    }));
  const local = queued.map((item): SetRow => ({
    key: `queued:${item.requestId}`,
    source: "queued",
    id: item.requestId,
    exercise: item.exercise,
    weightLb: item.weight === null ? null : toPounds(item.weight, item.unit),
    reps: item.reps,
    label: formatSet(formatWeight(item.weight, item.unit), item.reps),
    state: item.status,
    performedAt: item.performedAt,
    reason: item.reason ?? null,
  }));
  return [...saved, ...local];
}

/** `1 set`, `3 sets`. */
export function setsLabel(count: number): string {
  return `${count} ${count === 1 ? "set" : "sets"}`;
}

export function sameExercise(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The rows for one exercise, oldest first. */
export function rowsFor(rows: readonly SetRow[], exercise: string | null): SetRow[] {
  if (exercise === null) return [];
  return rows.filter((row) => sameExercise(row.exercise, exercise));
}

/** Sets that count toward the plan: saved or waiting to send (not failed). */
export function countedSets(rows: readonly SetRow[]): number {
  return rows.filter((row) => row.state !== "failed").length;
}

/** Today's plan: the open workout's, or the one sent before a workout opens. */
export type Plan = { plan_day: PlanDay | null; exercises: PlannedExercise[] };

/** The open workout's plan, else today's `plan` from `GET /v1/workout`, else null. */
export function todaysPlan(workout: Workout | null, plan: Plan | null | undefined): Plan | null {
  if (workout) return { plan_day: workout.plan_day, exercises: workout.exercises };
  return plan ?? null;
}

export function plannedExercise(plan: Plan | null, name: string | null) {
  if (!plan || name === null) return null;
  return plan.exercises.find((exercise) => sameExercise(exercise.name, name)) ?? null;
}

/** The pre-filled next set, in the profile's unit. */
export type NextSet = { weight: number | null; reps: number };

const DEFAULT_REPS = 8;

/**
 * The next set for an exercise:
 * - weight from the plan's target, else the last set logged today, else bodyweight;
 * - reps from the target for this set's index, else the last set logged today,
 *   else the low end of the plan's range (`8-10` is 8).
 */
export function nextSet(
  planned: PlannedExercise | null,
  rows: readonly SetRow[],
  unit: WeightUnit,
): NextSet {
  const done = rows.filter((row) => row.state !== "failed");
  const last = done.at(-1) ?? null;
  const target = planned?.target ?? null;

  const weight = target
    ? prefillWeight(target.weight_lb, unit)
    : prefillWeight(last?.weightLb ?? null, unit);

  const reps = target?.reps[done.length] ?? last?.reps ?? lowerBound(planned?.reps) ?? DEFAULT_REPS;
  return { weight, reps: clampReps(reps) };
}

function lowerBound(range: string | undefined): number | null {
  const match = /\d+/.exec(range ?? "");
  return match ? Number(match[0]) : null;
}

/** `3 sets · next target 135 lb × 8`, for Ready to train. */
export function planSummary(planned: PlannedExercise, unit: WeightUnit): string {
  const sets = `${planned.sets} ${planned.sets === 1 ? "set" : "sets"}`;
  if (!planned.target) return `${sets} · ${planned.reps} reps`;
  const next = nextSet(planned, [], unit);
  return `${sets} · next target ${formatSet(formatWeight(next.weight, unit), next.reps)}`;
}

/** Off-plan lifts logged today, in first-logged order. */
export function offPlanExercises(plan: Plan | null, rows: readonly SetRow[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const planned = plan?.exercises.some((exercise) => sameExercise(exercise.name, row.exercise));
    if (!planned && !names.some((name) => sameExercise(name, row.exercise))) {
      names.push(row.exercise);
    }
  }
  return names;
}
