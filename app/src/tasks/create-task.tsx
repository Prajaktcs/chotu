import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { Modal } from "react-native";

import type { ApiClient, CreatedTaskResponse, CreateTaskRequest, TasksResponse } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Progress } from "@/components/progress";
import { Screen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import { messageForError, useAuthErrorRoute, useProfileSession } from "@/connection";
import { newRequestId } from "@/workout/ids";

import { ambiguousTaskError, taskTrendsQueryKey, tasksQueryKey } from "./actions";
import { taskDate } from "./format";

type Attempt = { request: CreateTaskRequest; requestId: string };

export type CreationState =
  | { kind: "editing"; error: unknown }
  | { kind: "saving"; attempt: Attempt }
  | { kind: "ambiguous"; attempt: Attempt; error: unknown }
  | { kind: "saved"; response: CreatedTaskResponse };

const EDITING: CreationState = { kind: "editing", error: null };
const creationKey = (scope: string) => ["task-creation", scope] as const;

/**
 * The profile's Add task save, kept in the QueryClient beside task actions,
 * so leaving the route (web Back, a recovery screen) can't drop an
 * unconfirmed request id: returning offers Retry unchanged or Discard again.
 */
export class TaskCreation {
  private state: CreationState = EDITING;
  private listeners = new Set<() => void>();

  constructor(
    private queryClient: QueryClient,
    private scope: string,
    private client: Pick<ApiClient, "createTask">,
  ) {}

  setClient(client: Pick<ApiClient, "createTask">): void {
    this.client = client;
  }

  getSnapshot = (): CreationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** True while a save is in flight or may have been saved. */
  get unresolved(): boolean {
    return this.state.kind === "saving" || this.state.kind === "ambiguous";
  }

  private publish(state: CreationState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  submit(request: CreateTaskRequest): Promise<void> {
    if (this.unresolved) return Promise.resolve();
    return this.send({ request, requestId: newRequestId() }, false);
  }

  retry(): Promise<void> {
    if (this.state.kind !== "ambiguous") return Promise.resolve();
    return this.send(this.state.attempt, true);
  }

  /** Leaves the editor, or gives up an unconfirmed save after the person chose Discard. */
  reset(): void {
    if (this.state.kind === "saving") return;
    if (this.state.kind === "ambiguous") {
      void this.queryClient.invalidateQueries({ queryKey: tasksQueryKey(this.scope) });
    }
    this.publish(EDITING);
  }

  private async send(attempt: Attempt, retrying: boolean): Promise<void> {
    this.publish({ kind: "saving", attempt });
    try {
      const response = await this.client.createTask(attempt.request, attempt.requestId);
      this.queryClient.setQueryData<TasksResponse>(tasksQueryKey(this.scope), (current) =>
        current
          ? {
              ...current,
              tasks: [
                ...current.tasks.filter((task) => task.id !== response.task.id),
                response.task,
              ],
            }
          : current,
      );
      void this.queryClient.invalidateQueries({ queryKey: tasksQueryKey(this.scope) });
      void this.queryClient.invalidateQueries({ queryKey: taskTrendsQueryKey(this.scope) });
      this.publish({ kind: "saved", response });
    } catch (error) {
      // A retry of an unconfirmed save stays unconfirmed whatever this answer
      // was (a 401 now says nothing about the first attempt); so does any
      // answer that might mean it was applied.
      if (retrying || ambiguousTaskError(error)) {
        this.publish({ kind: "ambiguous", attempt, error });
      } else {
        this.publish({ kind: "editing", error });
      }
    }
  }
}

export function taskCreation(
  queryClient: QueryClient,
  scope: string,
  client: ApiClient,
): TaskCreation {
  const key = creationKey(scope);
  let creation = queryClient.getQueryData<TaskCreation>(key);
  if (!creation) {
    queryClient.setQueryDefaults(key, { gcTime: Infinity });
    creation = new TaskCreation(queryClient, scope, client);
    queryClient.setQueryData(key, creation);
  }
  creation.setClient(client);
  return creation;
}

const CALENDAR_NOTES: Record<NonNullable<CreatedTaskResponse["calendar"]>, string> = {
  scheduled: "Added to your calendar.",
  not_linked: "Your calendar isn't linked, so it isn't on your calendar.",
  failed: "The task was saved, but adding it to your calendar failed.",
};

/**
 * Add task, as Signal's `/task` does: for the chosen profile, with Signal's
 * due-text parsing. A failure that might have saved keeps its request id:
 * it can only be retried unchanged or explicitly discarded, never dropped.
 */
export function CreateTaskModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { client, scope } = useProfileSession();
  const queryClient = useQueryClient();
  const creation = taskCreation(queryClient, scope, client);
  const state = useSyncExternalStore(
    creation.subscribe,
    creation.getSnapshot,
    creation.getSnapshot,
  );
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [details, setDetails] = useState("");
  // 401, 403 and 426 open their recovery screens; the attempt stays stored.
  const authError = useAuthErrorRoute([
    state.kind === "ambiguous" || state.kind === "editing" ? state.error : null,
  ]);

  const reset = () => {
    setTitle("");
    setDue("");
    setDetails("");
    creation.reset();
  };
  const close = () => {
    // An unresolved save stays on screen until retried or discarded.
    if (creation.unresolved) return;
    reset();
    onClose();
  };

  const submit = () => {
    const request: CreateTaskRequest = { title: title.trim() };
    if (due.trim()) request.due = due.trim();
    if (details.trim()) request.details = details.trim();
    void creation.submit(request);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <Screen scroll>
        <ThemedText variant="headline" accessibilityRole="header">
          Add task
        </ThemedText>
        {state.kind === "editing" ? (
          <>
            <ThemedText color="muted">
              The task is yours, like /task in your Signal chat. Chotu may tidy the title and keep
              extra context in the details.
            </ThemedText>
            <TextField label="Title" value={title} onChangeText={setTitle} prose />
            <TextField
              label="Due (optional)"
              value={due}
              onChangeText={setDue}
              placeholder="tomorrow 3pm"
              hint="Like Signal: tomorrow 3pm, friday, or 2026-11-05. Household time."
            />
            <TextField label="Details (optional)" value={details} onChangeText={setDetails} prose />
            {state.error && !authError ? (
              <ThemedText color="error" accessibilityRole="alert">
                {messageForError(state.error)}
              </ThemedText>
            ) : null}
            <Button
              label="Save task"
              accessibilityLabel="Save task"
              disabled={!title.trim()}
              onPress={submit}
            />
            <Button
              label="Cancel"
              accessibilityLabel="Cancel adding a task"
              variant="text"
              onPress={close}
            />
          </>
        ) : null}
        {state.kind === "saving" ? (
          <Progress label={`Saving ${state.attempt.request.title}`} />
        ) : null}
        {state.kind === "ambiguous" ? (
          <Card title="Task not confirmed">
            <ThemedText accessibilityRole="alert">
              {`${state.attempt.request.title}: ${messageForError(state.error)}`}
            </ThemedText>
            <ThemedText color="muted">
              The server may have saved it. Retry unchanged sends the same request, so it can't make
              a second task.
            </ThemedText>
            <Button
              label="Retry unchanged"
              accessibilityLabel={`Retry unchanged: ${state.attempt.request.title}`}
              variant="secondary"
              onPress={() => void creation.retry()}
            />
            <Button
              label="Discard"
              accessibilityLabel="Discard. The task may already be saved"
              variant="text"
              onPress={() => {
                reset();
                onClose();
              }}
            />
          </Card>
        ) : null}
        {state.kind === "saved" ? (
          <Card title="Task added">
            <ThemedText variant="title" accessibilityRole="header">
              {state.response.task.title}
            </ThemedText>
            <ThemedText>{`Due ${taskDate(state.response.task)}`}</ThemedText>
            {state.response.details ? (
              <ThemedText color="muted">{state.response.details}</ThemedText>
            ) : null}
            {state.response.note ? (
              <ThemedText color="muted">{state.response.note}</ThemedText>
            ) : null}
            {state.response.calendar ? (
              <ThemedText color={state.response.calendar === "failed" ? "error" : "muted"}>
                {CALENDAR_NOTES[state.response.calendar]}
              </ThemedText>
            ) : null}
            <Button
              label="Add another"
              accessibilityLabel="Add another task"
              variant="secondary"
              onPress={reset}
            />
            <Button
              label="Done"
              accessibilityLabel="Close add task"
              variant="text"
              onPress={close}
            />
          </Card>
        ) : null}
      </Screen>
    </Modal>
  );
}
