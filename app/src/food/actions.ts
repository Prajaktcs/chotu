import type { QueryClient } from "@tanstack/react-query";

import {
  type ApiClient,
  ApiError,
  type FoodDayResponse,
  type Meal,
  type MealPhoto,
  type WatchlistFlag,
} from "@/api";
import { statusQueryKey } from "@/status/format";
import { newRequestId } from "@/workout/ids";

import { foodQueryKey, TODAY } from "./format";

export type FoodWrite =
  | { kind: "add"; date: string; description: string; photo?: MealPhoto }
  | { kind: "edit"; meal: Meal; description: string }
  | { kind: "correct"; meal: Meal; correction: string; photo?: MealPhoto }
  | { kind: "delete"; meal: Meal }
  | { kind: "clear"; date: string }
  | {
      kind: "adjust";
      date: string;
      calories: number;
      protein_g: number;
      carbs_g: number;
      fat_g: number;
    };

export type FoodOperation = {
  requestId: string;
  write: FoodWrite;
  pending: boolean;
  error: unknown;
  /**
   * A write that settled without an error but still has something to say: a
   * correction's question (nothing was written), or a notice of watchlist
   * flags and a Google Health replacement left for the next sync. It doesn't
   * block the next write.
   */
  outcome?:
    | { kind: "clarify"; question: string }
    | { kind: "notice"; remotePending: boolean; flags: WatchlistFlag[] };
};

/** Saved or answered: nothing left to resolve, so another write may start. */
export function settled(operation: FoodOperation): boolean {
  return !operation.pending && operation.outcome !== undefined;
}

function notice(day: FoodDayResponse, remotePending: boolean): FoodOperation["outcome"] {
  const flags = day.watchlist_flags ?? [];
  return remotePending || flags.length > 0 ? { kind: "notice", remotePending, flags } : undefined;
}

type Answer = { day: FoodDayResponse | null; outcome?: FoodOperation["outcome"] };

/** The `code` on a `409` when the meal changed since it was loaded. */
const MEAL_CHANGED = "meal_changed";

const actionsKey = (scope: string) => ["food-actions", scope] as const;

/** The server may have applied it: retry the same request before any other change. */
export function ambiguousFoodError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.detail.kind === "rejected" && error.detail.code === MEAL_CHANGED) return false;
  return (
    error.kind === "network" ||
    error.kind === "server" ||
    (error.detail.kind === "rejected" && [408, 409, 429].includes(error.detail.status))
  );
}

/** One in-memory food write per profile; ambiguous answers keep their request id. */
export class FoodActions {
  private operation: FoodOperation | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private queryClient: QueryClient,
    readonly scope: string,
    private client: ApiClient,
  ) {}

  setClient(client: ApiClient): void {
    this.client = client;
  }

  getSnapshot = (): FoodOperation | null => this.operation;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private owned(): boolean {
    return this.queryClient.getQueryData(actionsKey(this.scope)) === this;
  }

  private publish(operation: FoodOperation | null): void {
    this.operation = operation;
    for (const listener of this.listeners) listener();
  }

  async start(write: FoodWrite): Promise<void> {
    // One at a time: another write is saving or still needs resolving.
    if (!this.owned() || (this.operation && !settled(this.operation))) return;
    const operation = { requestId: newRequestId(), write, pending: true, error: null };
    this.publish(operation);
    await this.send(operation);
  }

  async retry(): Promise<void> {
    if (!this.owned() || !this.operation || this.operation.pending || settled(this.operation)) {
      return;
    }
    const operation = { ...this.operation, pending: true, error: null };
    this.publish(operation);
    await this.send(operation);
  }

  dismiss(): void {
    const operation = this.operation;
    if (
      operation &&
      !operation.pending &&
      (settled(operation) || !ambiguousFoodError(operation.error))
    ) {
      this.publish(null);
    }
  }

  private async request(write: FoodWrite, requestId: string): Promise<Answer> {
    if (write.kind === "correct") {
      const answer = await this.client.correctMeal(
        write.meal.id,
        { revision: write.meal.revision, correction: write.correction, photo: write.photo },
        requestId,
      );
      if (answer.status === "clarify") {
        return { day: null, outcome: { kind: "clarify", question: answer.question } };
      }
      return { day: answer.day, outcome: notice(answer.day, answer.remote === "pending") };
    }
    const day = await this.dayRequest(write, requestId);
    return { day, outcome: notice(day, false) };
  }

  private dayRequest(
    write: Exclude<FoodWrite, { kind: "correct" }>,
    requestId: string,
  ): Promise<FoodDayResponse> {
    if (write.kind === "add") {
      return this.client.addMeal(
        { description: write.description, date: write.date, photo: write.photo },
        requestId,
      );
    }
    if (write.kind === "edit") {
      return this.client.editMeal(
        write.meal.id,
        { description: write.description, revision: write.meal.revision },
        requestId,
      );
    }
    if (write.kind === "delete") return this.client.deleteMeal(write.meal.id, requestId);
    if (write.kind === "clear") return this.client.clearFoodDay({ date: write.date }, requestId);
    const { kind: _kind, ...totals } = write;
    return this.client.adjustFoodDay(totals, requestId);
  }

  private async send(operation: FoodOperation): Promise<void> {
    const { write, requestId } = operation;
    try {
      const { day, outcome } = await this.request(write, requestId);
      if (!this.owned()) return;
      if (day) await this.store(day);
      if (!this.owned()) return;
      this.publish(outcome ? { ...operation, pending: false, error: null, outcome } : null);
    } catch (error) {
      if (!this.owned()) return;
      this.publish({ ...operation, pending: false, error });
      // A changed or missing meal: show the server's current list.
      if (!ambiguousFoodError(error) && write.kind !== "add") {
        void this.queryClient.invalidateQueries({ queryKey: ["food", this.scope] });
      }
    }
  }

  private async store(day: FoodDayResponse): Promise<void> {
    const key = foodQueryKey(this.scope, day.date);
    await this.queryClient.cancelQueries({ queryKey: key });
    if (!this.owned()) return;
    this.queryClient.setQueryData(key, day);
    // Nutrition › Today asks for "today" without a date; keep it in step.
    const todayKey = foodQueryKey(this.scope, TODAY);
    if (this.queryClient.getQueryData<FoodDayResponse>(todayKey)?.date === day.date) {
      // A Today refetch begun before this write must not land over it.
      await this.queryClient.cancelQueries({ queryKey: todayKey });
      if (!this.owned()) return;
      this.queryClient.setQueryData(todayKey, day);
    }
    void this.queryClient.invalidateQueries({ queryKey: statusQueryKey(this.scope) });
    void this.queryClient.invalidateQueries({ queryKey: ["food-trends", this.scope] });
  }
}

export function foodActions(
  queryClient: QueryClient,
  scope: string,
  client: ApiClient,
): FoodActions {
  const key = actionsKey(scope);
  let actions = queryClient.getQueryData<FoodActions>(key);
  if (!actions) {
    queryClient.setQueryDefaults(key, { gcTime: Infinity });
    actions = new FoodActions(queryClient, scope, client);
    queryClient.setQueryData(key, actions);
  }
  actions.setClient(client);
  return actions;
}
