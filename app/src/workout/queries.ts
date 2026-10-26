import { focusManager, type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import type { SetDeletedResponse, SetLoggedResponse, Workout, WorkoutResponse } from "@/api";
import { useProfileSession } from "@/connection";

import type { QueuedSet } from "./queue/set-queue";
import { localDay } from "./time";

export function workoutQueryKey(scope: string): readonly ["workout", string] {
  return ["workout", scope];
}

/**
 * `GET /v1/workout` for the chosen profile. Refetches when the app comes to
 * the foreground (see useAppStateFocus), so sets logged in Signal show up.
 * No automatic retries: offline, the screen keeps the last loaded workout.
 */
export function useWorkoutQuery() {
  const { client, scope } = useProfileSession();
  return useQuery({
    queryKey: workoutQueryKey(scope),
    queryFn: () => client.workout(),
    retry: false,
  });
}

/**
 * Replaces the cached workout with `workout` when it is the same one (same
 * session), keeping the rest of the answer (`date`). True when replaced.
 */
function replaceCachedWorkout(queryClient: QueryClient, scope: string, workout: Workout): boolean {
  const key = workoutQueryKey(scope);
  const current = queryClient.getQueryData<WorkoutResponse>(key);
  if (current?.workout?.session_id !== workout.session_id) return false;
  queryClient.setQueryData<WorkoutResponse>(key, { ...current, workout });
  return true;
}

/**
 * Puts the workout a write returned into the cache when it is the open
 * workout on screen. A set logged for an earlier day joins that day's
 * workout, so then the cache is refetched instead.
 */
export function applyWorkout(
  queryClient: QueryClient,
  scope: string,
  response: Pick<SetLoggedResponse, "workout">,
): void {
  if (!replaceCachedWorkout(queryClient, scope, response.workout)) {
    void queryClient.invalidateQueries({ queryKey: workoutQueryKey(scope) });
  }
}

/**
 * Shows a set the queue just delivered, before it leaves the queue, so its
 * row never disappears:
 *
 * - The workout on screen: replaced with the one the server returned.
 * - No workout or another one cached, for a set done today: the returned
 *   workout is cached (it is the one today's sets went to). The queue's
 *   refresh when replay settles then confirms which workout is open.
 * - A set from an earlier day joins that day's workout, not today's: the
 *   cache is refetched, and the returned promise keeps the set queued (and
 *   on screen) until that refetch lands. That refetch is the set's refresh.
 */
export function applyDeliveredSet(
  queryClient: QueryClient,
  scope: string,
  item: Pick<QueuedSet, "performedAt">,
  response: Pick<SetLoggedResponse, "workout">,
  now: Date = new Date(),
): Promise<void> | void {
  if (replaceCachedWorkout(queryClient, scope, response.workout)) return undefined;
  const key = workoutQueryKey(scope);
  if (localDay(item.performedAt) === localDay(now)) {
    queryClient.setQueryData<WorkoutResponse>(key, { workout: response.workout });
    return undefined;
  }
  return queryClient.invalidateQueries({ queryKey: key });
}

/**
 * Takes a set the queue undid out of the workout on screen, before the queue
 * stops hiding it: the workout the DELETE returned when it is the one on
 * screen, else the set is removed from it by id (also when the server had
 * already lost it, `response` null). The queue's refresh then confirms it.
 */
export function applyUndoneSet(
  queryClient: QueryClient,
  scope: string,
  setId: string,
  response: SetDeletedResponse | null,
): void {
  if (response && replaceCachedWorkout(queryClient, scope, response.workout)) return;
  const key = workoutQueryKey(scope);
  const current = queryClient.getQueryData<WorkoutResponse>(key);
  if (!current?.workout) return;
  if (!current.workout.sets.some((set) => set.id === setId)) return;
  queryClient.setQueryData<WorkoutResponse>(key, {
    ...current,
    workout: { ...current.workout, sets: current.workout.sets.filter((set) => set.id !== setId) },
  });
}

/**
 * Tells TanStack Query the app is focused when Android/iOS bring it to the
 * foreground, so focused queries refetch. Web uses the page visibility events.
 */
export function useAppStateFocus(): void {
  useEffect(() => {
    if (Platform.OS === "web") return undefined;
    focusManager.setEventListener((setFocused) => {
      const subscription = AppState.addEventListener("change", (state) => {
        setFocused(state === "active");
      });
      return () => subscription.remove();
    });
    return undefined;
  }, []);
}
