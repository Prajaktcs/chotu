import type { Workout } from "@/api";
import { useProfileSession } from "@/connection";

import { mergeSets, plannedExercise, rowsFor, type SetRow } from "./model";
import { useWorkoutQuery } from "./queries";
import { useSetQueue } from "./queue/provider";
import { useWorkoutSession } from "./session";

/** The workout as the screens show it: server sets merged with the queue. */
export function useWorkoutView() {
  const { weightUnit } = useProfileSession();
  const query = useWorkoutQuery();
  const queue = useSetQueue();
  const session = useWorkoutSession();

  const workout: Workout | null = query.data?.workout ?? null;
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
    workout?.exercises[0]?.name ??
    null;

  return {
    query,
    queue,
    session,
    weightUnit,
    workout,
    rows,
    currentExercise,
    currentRows: rowsFor(rows, currentExercise),
    planned: plannedExercise(workout, currentExercise),
  };
}
