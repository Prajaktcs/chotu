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
  const { weightUnit } = useProfileSession();
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
  const rows: SetRow[] = mergeSets(
    workout?.sets ?? [],
    queue.items,
    weightUnit,
    session.hiddenSetIds,
  );
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
