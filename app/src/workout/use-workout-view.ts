import type { Workout } from "@/api";
import { useProfileSession } from "@/connection";

import {
  isAnswerCurrent,
  mergeSets,
  plannedExercise,
  rowsFor,
  type SetRow,
  todaysPlan,
} from "./model";
import { useWorkoutQuery } from "./queries";
import { useSetQueue } from "./queue/provider";
import { useWorkoutSession } from "./session";

/** The workout as the screens show it: server sets merged with the queue. */
export function useWorkoutView() {
  const { profile, weightUnit: cachedUnit } = useProfileSession();
  const query = useWorkoutQuery();
  const queue = useSetQueue();
  const session = useWorkoutSession();

  // An open workout is always shown; a plan (or "no workout") only while its
  // day is current. See isAnswerCurrent.
  const data = query.data;
  const stale = data !== undefined && !isAnswerCurrent(data, query.dataUpdatedAt);
  const workout: Workout | null = data?.workout ?? null;
  // Before the first set there is no workout, but the server still sends the plan.
  const plan = todaysPlan(workout, stale ? undefined : data?.plan);
  // A workout response is authoritative even while a legacy saved profile's
  // /me refresh is pending. Do not reinterpret its kg target as a default lb.
  const responseUnit =
    plan?.exercises.find((exercise) => exercise.target?.unit)?.target?.unit ??
    workout?.sets.find((set) => set.unit)?.unit;
  const weightUnit = responseUnit ?? cachedUnit;
  const unitReady = responseUnit !== undefined || profile.weight_unit !== undefined;
  const rows: SetRow[] = mergeSets(workout?.sets ?? [], queue.items, weightUnit, [
    session.hiddenSetIds,
    queue.undoingSetIds,
  ]);
  const lastQueued = queue.items.at(-1)?.exercise ?? null;
  const currentExercise =
    session.selectedExercise ??
    workout?.current_exercise ??
    lastQueued ??
    plan?.exercises[0]?.name ??
    null;

  return {
    query,
    queue,
    session,
    weightUnit,
    unitReady,
    /** A cached answer from an earlier day: refetch it, don't show it. */
    stale,
    /** Something to show: an open workout, or a current answer. */
    hasData: data !== undefined && !stale,
    workout,
    plan,
    rows,
    currentExercise,
    currentRows: rowsFor(rows, currentExercise),
    planned: plannedExercise(plan, currentExercise),
  };
}
