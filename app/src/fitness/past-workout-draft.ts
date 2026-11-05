import type { QueryClient } from "@tanstack/react-query";

import type { ApiClient, LogSetRequest, WeightUnit } from "@/api";
import { messageForError } from "@/connection";
import { localDate, shiftDate } from "@/food/format";
import { newRequestId } from "@/workout/ids";
import { invalidateTrainingHistory } from "@/workout/queries";
import { isRejection } from "@/workout/queue/set-queue";
import { toLocalRfc3339 } from "@/workout/time";

/**
 * The oldest day offered. The server refuses sets more than 7 days old, and a
 * set is stamped at noon, so 6 days back is always inside the limit.
 */
export const OLDEST_PAST_DAY = 6;

export type PastSet = {
  /** The set's `Idempotency-Key`, kept for every retry. */
  id: string;
  exercise: string;
  weight: number | null;
  unit: WeightUnit;
  reps: number;
  /** Order added; it becomes the second after noon, so history keeps the order. */
  seq: number;
  /**
   * - `unsent`: never sent; it can be removed.
   * - `unconfirmed`: sent without an answer (offline, a server error, a
   *   recovery screen); it may be saved, so it is only ever resent, unchanged.
   * - `failed`: the server refused it and keeps that answer for its id.
   * - `saved`: on the server.
   */
  status: "unsent" | "unconfirmed" | "failed" | "saved";
  /** The body as first sent, frozen so a resend is byte-for-byte the same request. */
  request?: LogSetRequest;
  reason?: string;
};

export type DraftState = {
  day: string;
  sets: readonly PastSet[];
  saving: boolean;
  /** Why the last save stopped, for sets left unconfirmed. */
  error: unknown;
};

/**
 * Noon on `day` in the phone's offset, plus `seq` seconds. Noon keeps the set
 * on that calendar day in the household timezone too, unless the phone is 12
 * hours or more from it.
 */
export function pastSetTime(day: string, seq: number): string {
  const at = new Date(`${day}T12:00:00`);
  at.setSeconds(seq);
  return toLocalRfc3339(at);
}

export type NewPastSet = Pick<PastSet, "exercise" | "weight" | "unit" | "reps">;

/**
 * The profile's Log a past workout draft, kept in the QueryClient like
 * TaskCreation: leaving the route (Back, a recovery screen, a new token)
 * can't drop a request id that may already be saved. Returning restores the
 * sets; a save keeps running if the screen closes.
 */
export class PastWorkoutDraft {
  private state: DraftState;
  private nextSeq = 0;
  private routedError: unknown = null;
  private listeners = new Set<() => void>();

  constructor(
    private queryClient: QueryClient,
    private scope: string,
    private client: Pick<ApiClient, "logSet">,
  ) {
    this.state = fresh();
  }

  setClient(client: Pick<ApiClient, "logSet">): void {
    this.client = client;
  }

  getSnapshot = (): DraftState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A 401/403/426 already sent to its recovery screen; returning mustn't loop back. */
  routed(error: unknown): boolean {
    return error !== null && error === this.routedError;
  }

  markRouted(error: unknown): void {
    this.routedError = error;
  }

  /** The day can move only while nothing may be on the server under it. */
  get dayLocked(): boolean {
    return this.state.sets.some((set) => set.status === "saved" || set.status === "unconfirmed");
  }

  setDay(day: string): void {
    if (this.state.saving || this.dayLocked) return;
    this.publish({ ...this.state, day });
  }

  add(set: NewPastSet): void {
    if (this.state.saving) return;
    const entry: PastSet = { ...set, id: newRequestId(), seq: this.nextSeq, status: "unsent" };
    this.nextSeq += 1;
    this.publish({ ...this.state, sets: [...this.state.sets, entry] });
  }

  /** Removes an unsent or refused set. One that may be saved can't be dropped. */
  remove(id: string): void {
    if (this.state.saving) return;
    const sets = this.state.sets.filter(
      (set) => set.id !== id || set.status === "saved" || set.status === "unconfirmed",
    );
    this.publish({ ...this.state, sets });
  }

  /** Gives up the whole draft; the screen warns first when a set may be saved. */
  discard(): void {
    if (this.state.saving) return;
    if (this.state.sets.some((set) => set.status !== "unsent")) {
      invalidateTrainingHistory(this.queryClient, this.scope);
    }
    this.routedError = null;
    this.publish(fresh());
  }

  /**
   * Sends every unsent and unconfirmed set, one at a time and in order: the
   * first creates the day's workout, the rest join it. Resolves true when all
   * are saved, after clearing the draft.
   */
  async save(): Promise<boolean> {
    if (this.state.saving) return false;
    const queue = this.state.sets.filter(
      (set) => set.status === "unsent" || set.status === "unconfirmed",
    );
    if (queue.length === 0) return false;
    this.publish({ ...this.state, saving: true, error: null });
    let error: unknown = null;
    for (const set of queue) {
      const request = set.request ?? {
        exercise: set.exercise,
        weight: set.weight,
        unit: set.unit,
        reps: set.reps,
        performed_at: pastSetTime(this.state.day, set.seq),
      };
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose (see above)
        await this.client.logSet(request, set.id);
        this.update(set.id, { status: "saved", request });
      } catch (caught) {
        if (isRejection(caught)) {
          this.update(set.id, { status: "failed", request, reason: messageForError(caught) });
          continue;
        }
        // No answer, or one that says nothing about this request: it may be saved.
        this.update(set.id, { status: "unconfirmed", request });
        error = caught;
        break;
      }
    }
    invalidateTrainingHistory(this.queryClient, this.scope);
    const done = error === null && this.state.sets.every((set) => set.status === "saved");
    if (done) {
      this.publish(fresh());
      return true;
    }
    this.publish({ ...this.state, saving: false, error });
    return false;
  }

  private update(id: string, change: Partial<PastSet>): void {
    const sets = this.state.sets.map((set) => (set.id === id ? { ...set, ...change } : set));
    this.publish({ ...this.state, sets });
  }

  private publish(state: DraftState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

function fresh(): DraftState {
  return { day: shiftDate(localDate(), -1), sets: [], saving: false, error: null };
}

const draftKey = (scope: string) => ["past-workout-draft", scope] as const;

export function pastWorkoutDraft(
  queryClient: QueryClient,
  scope: string,
  client: ApiClient,
): PastWorkoutDraft {
  const key = draftKey(scope);
  let draft = queryClient.getQueryData<PastWorkoutDraft>(key);
  if (!draft) {
    queryClient.setQueryDefaults(key, { gcTime: Infinity });
    draft = new PastWorkoutDraft(queryClient, scope, client);
    queryClient.setQueryData(key, draft);
  }
  draft.setClient(client);
  return draft;
}
