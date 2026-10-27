import type { QueryClient } from "@tanstack/react-query";

import { type ApiClient, ApiError } from "@/api";
import { newRequestId } from "@/workout/ids";
import { workoutQueryKey } from "@/workout/queries";

import { planQueryKey } from "./format";

export type PlanGenerationOperation = {
  requestId: string;
  regenerate: boolean;
  pending: boolean;
  error: unknown;
};

const generationKey = (scope: string) => ["plan-generation", scope] as const;

export function ambiguousPlanError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.kind === "network" ||
    error.kind === "server" ||
    (error.detail.kind === "rejected" && [408, 409, 429].includes(error.detail.status))
  );
}

/** One in-memory write per profile; ambiguous answers retain their request identity. */
export class PlanGeneration {
  private operation: PlanGenerationOperation | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private queryClient: QueryClient,
    readonly scope: string,
    private client: ApiClient,
  ) {}

  setClient(client: ApiClient): void {
    this.client = client;
  }

  getSnapshot = (): PlanGenerationOperation | null => this.operation;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private owned(): boolean {
    return this.queryClient.getQueryData(generationKey(this.scope)) === this;
  }

  private publish(operation: PlanGenerationOperation | null): void {
    this.operation = operation;
    for (const listener of this.listeners) listener();
  }

  async start(regenerate: boolean): Promise<void> {
    if (
      !this.owned() ||
      this.operation?.pending ||
      (this.operation && ambiguousPlanError(this.operation.error))
    )
      return;
    const operation = { requestId: newRequestId(), regenerate, pending: true, error: null };
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
    if (this.operation && !this.operation.pending && !ambiguousPlanError(this.operation.error)) {
      this.publish(null);
    }
  }

  private async send(operation: PlanGenerationOperation): Promise<void> {
    try {
      const response = operation.regenerate
        ? await this.client.regeneratePlan(operation.requestId)
        : await this.client.generatePlan(operation.requestId);
      if (!this.owned()) return;
      await this.queryClient.cancelQueries({ queryKey: planQueryKey(this.scope) });
      if (!this.owned()) return;
      this.queryClient.setQueryData(planQueryKey(this.scope), response);
      this.publish(null);
      void this.queryClient.invalidateQueries({ queryKey: workoutQueryKey(this.scope) });
    } catch (error) {
      if (this.owned()) this.publish({ ...operation, pending: false, error });
    }
  }
}

export function planGeneration(
  queryClient: QueryClient,
  scope: string,
  client: ApiClient,
): PlanGeneration {
  const key = generationKey(scope);
  let actions = queryClient.getQueryData<PlanGeneration>(key);
  if (!actions) {
    queryClient.setQueryDefaults(key, { gcTime: Infinity });
    actions = new PlanGeneration(queryClient, scope, client);
    queryClient.setQueryData(key, actions);
  }
  actions.setClient(client);
  return actions;
}
