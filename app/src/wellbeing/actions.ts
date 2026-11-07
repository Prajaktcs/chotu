import type { QueryClient } from "@tanstack/react-query";

import { type ApiClient, ApiError, type CheckinsResponse, type ConditionsResponse } from "@/api";
import { newRequestId } from "@/workout/ids";

export type WellbeingWrite =
  | { kind: "watch"; conditionId: string; label: string; tag: string; watched: boolean }
  | {
      kind: "checkin";
      date: string;
      conditionId: string;
      label: string;
      score: number;
      note?: string;
    }
  | { kind: "clear"; date: string; conditionId: string; label: string };

export type WellbeingOperation = {
  requestId: string;
  write: WellbeingWrite;
  pending: boolean;
  error: unknown;
};

export const conditionsKey = (scope: string) => ["health-conditions", scope] as const;
export const checkinsKey = (scope: string) => ["health-checkins", scope] as const;
export const healthTrendsKey = (scope: string) => ["health-trends", scope] as const;
const actionsKey = (scope: string) => ["wellbeing-actions", scope] as const;

/** The server may have applied it: retry the same request before any other change. */
export function ambiguousWellbeingError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.kind === "network" ||
    error.kind === "server" ||
    (error.detail.kind === "rejected" && [408, 409, 429].includes(error.detail.status))
  );
}

/**
 * One in-memory Wellbeing write per profile, like FoodActions: an ambiguous
 * answer keeps its request id for an unchanged retry, and it lives in the
 * QueryClient so leaving the tab or a recovery screen can't drop it.
 */
export class WellbeingActions {
  private operation: WellbeingOperation | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private queryClient: QueryClient,
    readonly scope: string,
    private client: ApiClient,
  ) {}

  setClient(client: ApiClient): void {
    this.client = client;
  }

  getSnapshot = (): WellbeingOperation | null => this.operation;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private owned(): boolean {
    return this.queryClient.getQueryData(actionsKey(this.scope)) === this;
  }

  private publish(operation: WellbeingOperation | null): void {
    this.operation = operation;
    for (const listener of this.listeners) listener();
  }

  async start(write: WellbeingWrite): Promise<void> {
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
    const operation = this.operation;
    if (operation && !operation.pending && !ambiguousWellbeingError(operation.error)) {
      this.publish(null);
    }
  }

  /** Puts a write's answer (its one day) into the cached range, keeping the other days. */
  private async storeDay(day: CheckinsResponse): Promise<void> {
    const key = checkinsKey(this.scope);
    await this.queryClient.cancelQueries({ queryKey: key });
    this.queryClient.setQueryData<CheckinsResponse>(key, (cached) =>
      cached
        ? {
            ...cached,
            checkins: [
              ...cached.checkins.filter((c) => c.date < day.from || c.date > day.to),
              ...day.checkins,
            ].sort(
              (a, b) =>
                a.date.localeCompare(b.date) || a.condition_id.localeCompare(b.condition_id),
            ),
          }
        : cached,
    );
  }

  private async send(operation: WellbeingOperation): Promise<void> {
    const { write, requestId } = operation;
    try {
      if (write.kind === "watch") {
        const conditions: ConditionsResponse = await this.client.setWatch(
          write.conditionId,
          write.tag,
          write.watched,
          requestId,
        );
        if (!this.owned()) return;
        await this.queryClient.cancelQueries({ queryKey: conditionsKey(this.scope) });
        this.queryClient.setQueryData(conditionsKey(this.scope), conditions);
      } else {
        const day =
          write.kind === "checkin"
            ? await this.client.putCheckin(
                write.date,
                write.conditionId,
                write.note ? { score: write.score, note: write.note } : { score: write.score },
                requestId,
              )
            : await this.client.deleteCheckin(write.date, write.conditionId, requestId);
        if (!this.owned()) return;
        await this.storeDay(day);
      }
      if (!this.owned()) return;
      this.publish(null);
    } catch (error) {
      if (!this.owned()) return;
      this.publish({ ...operation, pending: false, error });
    }
    // Saved or refused, the server's answer is what the tabs should show.
    void this.queryClient.invalidateQueries({ queryKey: checkinsKey(this.scope) });
    void this.queryClient.invalidateQueries({ queryKey: healthTrendsKey(this.scope) });
    if (write.kind === "watch") {
      void this.queryClient.invalidateQueries({ queryKey: conditionsKey(this.scope) });
    }
  }
}

export function wellbeingActions(
  queryClient: QueryClient,
  scope: string,
  client: ApiClient,
): WellbeingActions {
  const key = actionsKey(scope);
  let actions = queryClient.getQueryData<WellbeingActions>(key);
  if (!actions) {
    queryClient.setQueryDefaults(key, { gcTime: Infinity });
    actions = new WellbeingActions(queryClient, scope, client);
    queryClient.setQueryData(key, actions);
  }
  actions.setClient(client);
  return actions;
}

/** What a write is, for its progress and failure text. */
export function writeText(write: WellbeingWrite): { progress: string; failed: string } {
  if (write.kind === "watch") {
    return write.watched
      ? {
          progress: `Adding ${write.tag} to ${write.label}…`,
          failed: `Couldn't add ${write.tag} to ${write.label}`,
        }
      : {
          progress: `Removing ${write.tag} from ${write.label}…`,
          failed: `Couldn't remove ${write.tag} from ${write.label}`,
        };
  }
  if (write.kind === "checkin") {
    return {
      progress: `Saving ${write.label} check-in…`,
      failed: `Couldn't save ${write.label} check-in`,
    };
  }
  return {
    progress: `Clearing ${write.label} check-in…`,
    failed: `Couldn't clear ${write.label} check-in`,
  };
}
