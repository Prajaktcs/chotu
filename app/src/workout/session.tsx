import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from "react";

import { ApiError, type LoggedSet, type WorkoutDoneResponse } from "@/api";
import { routeForApiError, useProfileSession } from "@/connection";

import { newRequestId } from "./ids";
import { applyWorkout, workoutQueryKey } from "./queries";
import { isInFlight } from "./queue/set-queue";
import { useSetQueue } from "./queue/provider";

/** How long Done waits for queued sets to send before closing the workout. */
const DRAIN_TIMEOUT_MS = 10_000;

export type FinishResult =
  | { ok: true; summary: WorkoutDoneResponse }
  | { ok: false; message: string | null };

export type WorkoutSession = {
  /** The exercise chosen on Change exercise, or null to follow the server's current one. */
  selectedExercise: string | null;
  selectExercise: (name: string) => void;
  /** Start workout was pressed on Ready to train. */
  started: boolean;
  start: () => void;
  /** Saved sets being undone: hidden until the server answers. */
  hiddenSetIds: ReadonlySet<string>;
  /** Undoes a saved set: hides it, deletes it, and brings it back if that fails. */
  undoSavedSet: (set: LoggedSet) => Promise<void>;
  /** A message to show on the workout screen (a failed undo or Done). */
  notice: string | null;
  clearNotice: () => void;
  /** Sends what it can from the queue, then closes today's workout. */
  finish: () => Promise<FinishResult>;
};

const WorkoutSessionContext = createContext<WorkoutSession | null>(null);

/** Workout state shared by the workout screens for the chosen profile. */
export function WorkoutSessionProvider({ children }: { children: ReactNode }) {
  const { scope } = useProfileSession();
  // A new profile or server starts with a fresh session.
  return <SessionState key={scope}>{children}</SessionState>;
}

function SessionState({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { client, scope } = useProfileSession();
  const { queue } = useSetQueue();
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [hiddenSetIds, setHiddenSetIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  // One idempotency key per undo or Done, reused when it is retried.
  const undoKeys = useRef(new Map<string, string>());
  const doneKey = useRef<string | null>(null);

  const value = useMemo((): WorkoutSession => {
    const hide = (id: string, hidden: boolean) =>
      setHiddenSetIds((current) => {
        const next = new Set(current);
        if (hidden) next.add(id);
        else next.delete(id);
        return next;
      });

    /** Routes auth and version errors to their screens; returns a message for the rest. */
    const handle = (error: unknown, fallback: string): string | null => {
      if (
        error instanceof ApiError &&
        (error.kind === "unauthorized" ||
          error.kind === "forbidden" ||
          error.kind === "updateRequired")
      ) {
        const route = routeForApiError(error);
        if (route) router.replace(route);
        return null;
      }
      if (error instanceof ApiError && error.kind === "network") {
        return `${fallback} Chotu's server can't be reached.`;
      }
      if (error instanceof ApiError && error.detail.kind === "rejected" && !isInFlight(error)) {
        return `${fallback} ${error.detail.message}`;
      }
      return `${fallback} Try again.`;
    };

    return {
      selectedExercise,
      selectExercise: (name) => {
        setSelectedExercise(name);
        setStarted(true);
      },
      started,
      start: () => setStarted(true),
      hiddenSetIds,
      undoSavedSet: async (set) => {
        const key = undoKeys.current.get(set.id) ?? newRequestId();
        undoKeys.current.set(set.id, key);
        hide(set.id, true);
        setNotice(null);
        try {
          const response = await client.deleteSet(set.id, key);
          undoKeys.current.delete(set.id);
          applyWorkout(queryClient, scope, response);
        } catch (error) {
          setNotice(handle(error, "Couldn't undo that set."));
        } finally {
          hide(set.id, false);
        }
      },
      notice,
      clearNotice: () => setNotice(null),
      finish: async () => {
        setNotice(null);
        // Send queued sets first: a set sent after Done would start a new workout.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          queue.drain(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        doneKey.current ??= newRequestId();
        try {
          const summary = await client.finishWorkout(doneKey.current);
          doneKey.current = null;
          setSelectedExercise(null);
          setStarted(false);
          void queryClient.invalidateQueries({ queryKey: workoutQueryKey(scope) });
          return { ok: true, summary };
        } catch (error) {
          const message = handle(error, "Couldn't finish the workout.");
          setNotice(message);
          return { ok: false, message };
        }
      },
    };
  }, [client, hiddenSetIds, notice, queryClient, queue, router, scope, selectedExercise, started]);

  return <WorkoutSessionContext.Provider value={value}>{children}</WorkoutSessionContext.Provider>;
}

export function useWorkoutSession(): WorkoutSession {
  const value = useContext(WorkoutSessionContext);
  if (!value) throw new Error("useWorkoutSession must be used inside WorkoutSessionProvider");
  return value;
}
