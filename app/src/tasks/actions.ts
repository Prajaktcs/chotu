import type { QueryClient } from "@tanstack/react-query";

import { type ApiClient, ApiError, type Task, type TasksResponse } from "@/api";
import { newRequestId } from "@/workout/ids";

export type SnoozeDays = 1 | 3 | 7;
export type TaskAction = { kind: "complete" } | { kind: "snooze"; days: SnoozeDays };
export type TaskOperation = {
  requestId: string;
  task: Task;
  action: TaskAction;
  optimistic: Task;
  pending: boolean;
  error: unknown;
  warning?: string;
};

export const tasksQueryKey = (scope: string) => ["tasks", scope] as const;
const actionsKey = (scope: string) => ["task-actions", scope] as const;

/** Ambiguous writes must be resolved unchanged before another action on that task. */
export function ambiguousTaskError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.kind === "network" ||
    error.kind === "server" ||
    (error.detail.kind === "rejected" && [408, 409, 429].includes(error.detail.status))
  );
}

function optimisticTask(task: Task, action: TaskAction, now: Date): Task {
  if (action.kind === "complete") return { ...task, status: "done" };
  const due = new Date(now);
  due.setDate(due.getDate() + action.days);
  const date = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  return { ...task, status: "snoozed", due_date: date, due_at: null, due_has_time: false };
}

/**
 * In-memory action state, retained across tab changes in this QueryClient.
 * Server data stays separate from pending overlays: rollback drops only that
 * operation, never restores a whole-list snapshot over another successful write.
 */
export class TaskActions {
  private operations: readonly TaskOperation[] = [];
  private listeners = new Set<() => void>();

  constructor(
    private queryClient: QueryClient,
    readonly scope: string,
    private client: Pick<ApiClient, "completeTask" | "snoozeTask">,
  ) {}

  setClient(client: Pick<ApiClient, "completeTask" | "snoozeTask">): void {
    this.client = client;
  }

  getSnapshot = (): readonly TaskOperation[] => this.operations;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(operations: readonly TaskOperation[]): void {
    this.operations = operations;
    for (const listener of this.listeners) listener();
  }

  async perform(task: Task, action: TaskAction, now = new Date()): Promise<void> {
    if (this.operations.some((operation) => operation.task.id === task.id && !operation.warning)) return;
    const operation: TaskOperation = {
      requestId: newRequestId(), task, action,
      optimistic: optimisticTask(task, action, now), pending: true, error: null,
    };
    this.publish([...this.operations.filter((item) => item.task.id !== task.id), operation]);
    await this.send(operation);
  }

  async retry(requestId: string): Promise<void> {
    const operation = this.operations.find((item) => item.requestId === requestId);
    if (!operation || operation.pending || operation.warning) return;
    const pending = { ...operation, pending: true, error: null };
    this.publish(this.operations.map((item) => item === operation ? pending : item));
    await this.send(pending);
  }

  dismiss(requestId: string): void {
    this.publish(this.operations.filter((item) =>
      item.requestId !== requestId || item.pending || (!item.warning && ambiguousTaskError(item.error)),
    ));
  }

  private async send(operation: TaskOperation): Promise<void> {
    try {
      const { task, action, requestId } = operation;
      const response = action.kind === "complete"
        ? await this.client.completeTask(task.id, requestId)
        : await this.client.snoozeTask(task.id, action.days, requestId);
      // Ignore late answers after connection replacement cleared the cache.
      if (this.queryClient.getQueryData(actionsKey(this.scope)) !== this) return;
      await this.queryClient.cancelQueries({ queryKey: tasksQueryKey(this.scope) });
      if (this.queryClient.getQueryData(actionsKey(this.scope)) !== this) return;
      this.queryClient.setQueryData<TasksResponse>(tasksQueryKey(this.scope), (current) => {
        const tasks = (current?.tasks ?? []).filter((item) => item.id !== task.id);
        if (response.task.status !== "done") tasks.push(response.task);
        return { tasks };
      });
      this.publish(this.operations.flatMap((item) => item.requestId !== requestId
        ? [item]
        : response.calendar_warning ? [{ ...item, pending: false, warning: response.calendar_warning }] : []));
    } catch (error) {
      this.publish(this.operations.map((item) => item.requestId === operation.requestId
        ? { ...item, pending: false, error } : item));
    }
  }
}

export function taskActions(queryClient: QueryClient, scope: string, client: ApiClient): TaskActions {
  const key = actionsKey(scope);
  let actions = queryClient.getQueryData<TaskActions>(key);
  if (!actions) {
    queryClient.setQueryDefaults(key, { gcTime: Infinity });
    actions = new TaskActions(queryClient, scope, client);
    queryClient.setQueryData(key, actions);
  }
  actions.setClient(client);
  return actions;
}

export function visibleTasks(tasks: readonly Task[], operations: readonly TaskOperation[]): Task[] {
  const pending = new Map(operations.filter((item) => item.pending).map((item) => [item.task.id, item]));
  return tasks.map((task) => pending.get(task.id)?.optimistic ?? task)
    .filter((task) => task.status !== "done");
}
