import { focusManager, type QueryClient, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import type { SetLoggedResponse, WorkoutResponse } from "@/api";
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
 * Puts the workout a write returned into the cache when it is the open
 * workout on screen. A set logged for an earlier day joins that day's
 * workout, so then the cache is refetched instead.
 */
export function applyWorkout(
  queryClient: QueryClient,
  scope: string,
  response: Pick<SetLoggedResponse, "workout">,
): void {
  const key = workoutQueryKey(scope);
  const current = queryClient.getQueryData<WorkoutResponse>(key);
  if (current?.workout && current.workout.session_id === response.workout.session_id) {
    queryClient.setQueryData<WorkoutResponse>(key, { workout: response.workout });
  } else {
    void queryClient.invalidateQueries({ queryKey: key });
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
  const key = workoutQueryKey(scope);
  const current = queryClient.getQueryData<WorkoutResponse>(key);
  if (current?.workout && current.workout.session_id === response.workout.session_id) {
    queryClient.setQueryData<WorkoutResponse>(key, { workout: response.workout });
    return undefined;
  }
  if (localDay(item.performedAt) === localDay(now)) {
    queryClient.setQueryData<WorkoutResponse>(key, { workout: response.workout });
    return undefined;
  }
  return queryClient.invalidateQueries({ queryKey: key });
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
