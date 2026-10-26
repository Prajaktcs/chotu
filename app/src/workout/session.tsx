import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from "react";

import { ApiError, type LoggedSet, type WorkoutDoneResponse, type WorkoutResponse } from "@/api";
import { needsRecovery, pendingSetsLabel, routeForApiError, useProfileSession } from "@/connection";

import { newRequestId } from "./ids";
import { applyWorkout, workoutQueryKey } from "./queries";
import { setsLabel } from "./model";
import { isInFlight, isTransient, type QueueSnapshot, type UndoProblem } from "./queue/set-queue";
import { useSetQueue } from "./queue/provider";
import { formatSet, formatWeight } from "./units";

/** How long Done waits for queued sets to send before giving up (the workout stays open). */
const DRAIN_TIMEOUT_MS = 10_000;

export type FinishResult =
  | { ok: true; summary: WorkoutDoneResponse }
  | { ok: false; message: string | null; waitingOnQueue: boolean };

export type WorkoutSession = {
  /** The exercise chosen on Change exercise, or null to follow the server's current one. */
  selectedExercise: string | null;
  selectExercise: (name: string) => void;
  /** Start workout was pressed on Ready to train. */
  started: boolean;
  start: () => void;
  /** Leaves logging before anything was logged: back to Ready to train (or No workout today). */
  leave: () => void;
  /**
   * The server closed the workout being logged to: back to the workout home
   * with a notice, so the next set doesn't silently start a second workout.
   */
  closedByServer: () => void;
  /** Saved sets being undone: hidden until the server answers. */
  hiddenSetIds: ReadonlySet<string>;
  /** Undoes a saved set: hides it, deletes it, and brings it back if that fails. */
  undoSavedSet: (set: LoggedSet) => Promise<void>;
  /** A message to show on the workout screen (a failed undo, queued or not, or Done). */
  notice: string | null;
  clearNotice: () => void;
  /** Done was refused because sets are still on this phone: show how to review them. */
  doneWaitingOnQueue: boolean;
  /**
   * Sends the queue, then closes today's workout. With any set still on this
   * phone (pending or failed) it doesn't close it: a set sent after Done
   * would open a second workout, and Done never clears the queue.
   */
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
  const { queue, undoProblems } = useSetQueue();
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [hiddenSetIds, setHiddenSetIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setSessionNotice] = useState<string | null>(null);
  const [doneWaitingOnQueue, setDoneWaitingOnQueue] = useState(false);
  // One idempotency key per undo or Done, reused only to retry a transient
  // failure. A definitive answer is stored under its key, so the next try
  // needs a new one.
  const undoKeys = useRef(new Map<string, string>());
  // Done's key also records the workout it was made for: a Done that timed out
  // may have closed it, and sets logged since open a new one that needs a new key.
  const doneKey = useRef<{ key: string; workout: string } | null>(null);

  // Undos of queued sets the server didn't confirm. They stay on the queue
  // (whatever screen was open when they came) and show with the session's
  // notice until it is cleared.
  const shownNotice =
    [...undoProblems.map(undoProblemNotice), ...(notice === null ? [] : [notice])].join(" ") ||
    null;

  const value = useMemo((): WorkoutSession => {
    const setNotice = (next: string | null) => {
      if (next === null) queue.clearUndoProblems();
      setSessionNotice(next);
    };

    const hide = (id: string, hidden: boolean) =>
      setHiddenSetIds((current) => {
        const next = new Set(current);
        if (hidden) next.add(id);
        else next.delete(id);
        return next;
      });

    /** Routes auth and version errors to their screens; returns a message for the rest. */
    const handle = (error: unknown, fallback: string): string | null => {
      if (needsRecovery(error)) {
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
      leave: () => {
        setSelectedExercise(null);
        setStarted(false);
        setNotice(null);
        setDoneWaitingOnQueue(false);
      },
      closedByServer: () => {
        setSelectedExercise(null);
        setStarted(false);
        setDoneWaitingOnQueue(false);
        setNotice("This workout was closed. A new set starts a new workout.");
      },
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
          if (!isTransient(error)) undoKeys.current.delete(set.id);
          setNotice(handle(error, "Couldn't undo that set."));
        } finally {
          hide(set.id, false);
        }
      },
      notice: shownNotice,
      clearNotice: () => {
        setNotice(null);
        setDoneWaitingOnQueue(false);
      },
      doneWaitingOnQueue,
      finish: async () => {
        setNotice(null);
        setDoneWaitingOnQueue(false);
        // Send queued sets first: a set sent after Done would start a new workout.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          queue.drain(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        const waiting = queueNotice(queue.getSnapshot());
        if (waiting) {
          setNotice(waiting);
          setDoneWaitingOnQueue(true);
          return { ok: false, message: waiting, waitingOnQueue: true };
        }
        const workout = queryClient.getQueryData<WorkoutResponse>(workoutQueryKey(scope))?.workout;
        const target = workout ? `${workout.session_id}:${workout.sets.length}` : "";
        if (doneKey.current?.workout !== target) {
          doneKey.current = { key: newRequestId(), workout: target };
        }
        try {
          const summary = await client.finishWorkout(doneKey.current.key);
          doneKey.current = null;
          setSelectedExercise(null);
          setStarted(false);
          void queryClient.invalidateQueries({ queryKey: workoutQueryKey(scope) });
          return { ok: true, summary };
        } catch (error) {
          if (!isTransient(error)) doneKey.current = null;
          const message = handle(error, "Couldn't finish the workout.");
          setNotice(message);
          return { ok: false, message, waitingOnQueue: false };
        }
      },
    };
  }, [
    client,
    doneWaitingOnQueue,
    hiddenSetIds,
    queryClient,
    queue,
    router,
    scope,
    selectedExercise,
    shownNotice,
    started,
  ]);

  return <WorkoutSessionContext.Provider value={value}>{children}</WorkoutSessionContext.Provider>;
}

/** Why Done has to wait, or null when nothing is left on this phone. */
function queueNotice({ items, undoing, loaded }: QueueSnapshot): string | null {
  // Until the stored queue is read, it may hold sets that must go first.
  if (!loaded) return "Sets saved on this phone couldn't be read yet. Try Done again.";
  // An undo still syncing counts: its replay must reach today's open workout.
  const pending = items.filter((item) => item.status === "pending").length + undoing;
  const failed = items.length + undoing - pending;
  if (pending > 0) return `${pendingSetsLabel(pending)}. Done when they're sent.`;
  if (failed > 0) {
    return `${setsLabel(failed)} not saved. Retry or remove ${failed === 1 ? "it" : "them"} before Done.`;
  }
  return null;
}

/** Why an undone set may still be saved on the server. */
export function undoProblemNotice({ set, kind, reason }: UndoProblem): string {
  const label = `${set.exercise} ${formatSet(formatWeight(set.weight, set.unit), set.reps)}`;
  return kind === "refused"
    ? `Couldn't undo ${label}: ${reason}. It may still be saved.`
    : `Couldn't confirm ${label} was undone: the server no longer remembers sending it (${reason}). It may still be saved.`;
}

export function useWorkoutSession(): WorkoutSession {
  const value = useContext(WorkoutSessionContext);
  if (!value) throw new Error("useWorkoutSession must be used inside WorkoutSessionProvider");
  return value;
}
