import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Modal } from "react-native";

import type { CreatedTaskResponse, CreateTaskRequest, TasksResponse } from "@/api";
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

type State =
  | { kind: "editing"; error: string | null }
  | { kind: "saving"; attempt: Attempt }
  | { kind: "ambiguous"; attempt: Attempt; error: unknown }
  | { kind: "saved"; response: CreatedTaskResponse };

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
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [details, setDetails] = useState("");
  const [state, setState] = useState<State>({ kind: "editing", error: null });
  useAuthErrorRoute([state.kind === "ambiguous" ? state.error : null]);

  const reset = () => {
    setTitle("");
    setDue("");
    setDetails("");
    setState({ kind: "editing", error: null });
  };
  const close = () => {
    // An unresolved save stays on screen until retried or discarded.
    if (state.kind === "ambiguous" || state.kind === "saving") return;
    reset();
    onClose();
  };

  const send = async (attempt: Attempt) => {
    setState({ kind: "saving", attempt });
    try {
      const response = await client.createTask(attempt.request, attempt.requestId);
      queryClient.setQueryData<TasksResponse>(tasksQueryKey(scope), (current) =>
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
      void queryClient.invalidateQueries({ queryKey: tasksQueryKey(scope) });
      void queryClient.invalidateQueries({ queryKey: taskTrendsQueryKey(scope) });
      setState({ kind: "saved", response });
    } catch (error) {
      if (ambiguousTaskError(error)) setState({ kind: "ambiguous", attempt, error });
      else setState({ kind: "editing", error: messageForError(error) });
    }
  };

  const submit = () => {
    const request: CreateTaskRequest = { title: title.trim() };
    if (due.trim()) request.due = due.trim();
    if (details.trim()) request.details = details.trim();
    void send({ request, requestId: newRequestId() });
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
            {state.error ? (
              <ThemedText color="error" accessibilityRole="alert">
                {state.error}
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
              onPress={() => void send(state.attempt)}
            />
            <Button
              label="Discard"
              accessibilityLabel="Discard. The task may already be saved"
              variant="text"
              onPress={() => {
                void queryClient.invalidateQueries({ queryKey: tasksQueryKey(scope) });
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
