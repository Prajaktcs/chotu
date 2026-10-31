import type { QueryClient } from "@tanstack/react-query";

import { type ApiClient, ApiError, type FoodDayResponse, type Meal, type MealPhoto } from "@/api";
import { statusQueryKey } from "@/status/format";
import { newRequestId } from "@/workout/ids";

import { foodQueryKey } from "./format";

export type FoodWrite =
  | { kind: "add"; date: string; description: string; photo?: MealPhoto }
  | { kind: "edit"; meal: Meal; description: string }
  | { kind: "delete"; meal: Meal };

export type FoodOperation = {
  requestId: string;
  write: FoodWrite;
  pending: boolean;
  error: unknown;
};

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
    if (!this.owned() || this.operation) return;
    const operation = { requestId: newRequestId(), write, pending: true, error: null };
    this.publish(operation);
    await this.send(operation);
  }

  async retry(): Promise<void> {
    if (!this.owned() || !this.operation || this.operation.pending) return;
    const operation = { ...this.operation, pending: true, error: null };
    this.publish(operation);
    await this.send(operation);
  }

  dismiss(): void {
    if (this.operation && !this.operation.pending && !ambiguousFoodError(this.operation.error)) {
      this.publish(null);
    }
  }

  private async send(operation: FoodOperation): Promise<void> {
    const { write, requestId } = operation;
    try {
      const day =
        write.kind === "add"
          ? await this.client.addMeal(
              { description: write.description, date: write.date, photo: write.photo },
              requestId,
            )
          : write.kind === "edit"
            ? await this.client.editMeal(
                write.meal.id,
                { description: write.description, revision: write.meal.revision },
                requestId,
              )
            : await this.client.deleteMeal(write.meal.id, requestId);
      if (!this.owned()) return;
      await this.store(day);
      this.publish(null);
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
    void this.queryClient.invalidateQueries({ queryKey: statusQueryKey(this.scope) });
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
