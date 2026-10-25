import { QueryClient } from "@tanstack/react-query";

import type { Workout, WorkoutResponse } from "@/api";

import { applyDeliveredSet, workoutQueryKey } from "./queries";

const SCOPE = "https://mini.ts.net:8787#alex";
const KEY = workoutQueryKey(SCOPE);
const NOW = new Date(2026, 9, 24, 9, 40);

function workout(sessionId: string): Workout {
  return {
    session_id: sessionId,
    current_exercise: "Bench press",
    plan_day: null,
    exercises: [],
    sets: [{ id: "n1", exercise: "Bench press", weight_lb: 135, reps: 8 }],
  };
}

/** No garbage-collection timers, so Jest can exit. */
function queryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } } });
}

function cached(client: QueryClient): WorkoutResponse | undefined {
  return client.getQueryData<WorkoutResponse>(KEY);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A tap time on the phone's local day, written as the queue writes it. */
function tappedAt(day: number): string {
  const date = new Date(2026, 9, day, 9, 35);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return `2026-10-${pad(day)}T09:35:00${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

describe("applyDeliveredSet", () => {
  it("replaces the workout on screen with the one the server returned", () => {
    const client = queryClient();
    client.setQueryData<WorkoutResponse>(KEY, { workout: { ...workout("s1"), sets: [] } });

    const result = applyDeliveredSet(
      client,
      SCOPE,
      { performedAt: tappedAt(24) },
      {
        workout: workout("s1"),
      },
      NOW,
    );

    expect(result).toBeUndefined();
    expect(cached(client)).toEqual({ workout: workout("s1") });
  });

  it("caches the workout today's first set started, so its row never disappears", () => {
    const client = queryClient();
    client.setQueryData<WorkoutResponse>(KEY, { workout: null });

    void applyDeliveredSet(
      client,
      SCOPE,
      { performedAt: tappedAt(24) },
      { workout: workout("s2") },
      NOW,
    );

    expect(cached(client)).toEqual({ workout: workout("s2") });
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  });

  it("caches a newer workout today in place of another session", () => {
    const client = queryClient();
    client.setQueryData<WorkoutResponse>(KEY, { workout: workout("s1") });

    void applyDeliveredSet(
      client,
      SCOPE,
      { performedAt: tappedAt(24) },
      { workout: workout("s2") },
      NOW,
    );

    expect(cached(client)?.workout?.session_id).toBe("s2");
  });

  it("refetches for an earlier day's set, and waits for it before the set leaves the queue", async () => {
    const client = queryClient();
    client.setQueryData<WorkoutResponse>(KEY, { workout: workout("s1") });

    const result = applyDeliveredSet(
      client,
      SCOPE,
      { performedAt: tappedAt(23) },
      { workout: workout("closed-yesterday") },
      NOW,
    );

    expect(result).toBeInstanceOf(Promise);
    expect(cached(client)?.workout?.session_id).toBe("s1");
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
    await result;
  });
});
