import type { Workout } from "@/api";
import { useProfileSession } from "@/connection";

import { mergeSets, plannedExercise, rowsFor, type SetRow, todaysPlan } from "./model";
import { useWorkoutQuery } from "./queries";
import { useSetQueue } from "./queue/provider";
import { useWorkoutSession } from "./session";
import { isSameLocalDay } from "./time";

/** The workout as the screens show it: server sets merged with the queue. */
export function useWorkoutView() {
  const { weightUnit } = useProfileSession();
  const query = useWorkoutQuery();
  const queue = useSetQueue();
  const session = useWorkoutSession();

  // A cached answer from an earlier day (offline the next morning) is not
  // today's: its plan and workout are ignored until a fresh load.
  const loadedToday = query.data !== undefined && isSameLocalDay(query.dataUpdatedAt);
  const data = loadedToday ? query.data : undefined;
  const workout: Workout | null = data?.workout ?? null;
  // Before the first set there is no workout, but the server still sends the plan.
  const plan = todaysPlan(workout, data?.plan);
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
    loadedToday,
    workout,
    plan,
    rows,
    currentExercise,
    currentRows: rowsFor(rows, currentExercise),
    planned: plannedExercise(plan, currentExercise),
  };
}
