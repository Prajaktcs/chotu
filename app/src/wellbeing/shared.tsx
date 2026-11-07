import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Progress } from "@/components/progress";
import { ThemedText } from "@/components/themed-text";
import { messageForError, useProfileSession } from "@/connection";

import {
  ambiguousWellbeingError,
  checkinsKey,
  conditionsKey,
  type WellbeingActions,
  type WellbeingOperation,
  wellbeingActions,
  writeText,
} from "./actions";

export function useConditions() {
  const { client, scope } = useProfileSession();
  return useQuery({
    queryKey: conditionsKey(scope),
    queryFn: () => client.healthConditions(),
    retry: false,
  });
}

/** Today and the 7 days before it: the days a check-in can be written for. */
export function useCheckins() {
  const { client, scope } = useProfileSession();
  return useQuery({
    queryKey: checkinsKey(scope),
    queryFn: () => client.checkins(),
    retry: false,
  });
}

export function useWellbeingActions(): {
  actions: WellbeingActions;
  operation: WellbeingOperation | null;
} {
  const { client, scope } = useProfileSession();
  const queryClient = useQueryClient();
  const actions = wellbeingActions(queryClient, scope, client);
  const operation = useSyncExternalStore(
    actions.subscribe,
    actions.getSnapshot,
    actions.getSnapshot,
  );
  return { actions, operation };
}

/** A write in progress, or why it failed with Retry (and Dismiss once nothing may be saved). */
export function WriteStatus({
  operation,
  showError,
  actions,
}: {
  operation: WellbeingOperation | null;
  showError: boolean;
  actions: WellbeingActions;
}) {
  if (!operation) return null;
  const text = writeText(operation.write);
  if (operation.pending) return <Progress label={text.progress} />;
  if (!showError) return null;
  const ambiguous = ambiguousWellbeingError(operation.error);
  return (
    <Card title={text.failed}>
      <ThemedText accessibilityRole="alert">{messageForError(operation.error)}</ThemedText>
      {ambiguous ? (
        <ThemedText color="muted">
          The server may have saved this. Retry it unchanged before making another change.
        </ThemedText>
      ) : null}
      <Button label="Retry" accessibilityLabel="Retry" onPress={() => void actions.retry()} />
      {ambiguous ? null : (
        <Button
          label="Dismiss"
          accessibilityLabel="Dismiss"
          variant="text"
          onPress={() => actions.dismiss()}
        />
      )}
    </Card>
  );
}

/** A profile without configured conditions: say where they come from. */
export function NoConditions() {
  return (
    <Card title="Wellbeing">
      <ThemedText variant="title" accessibilityRole="header">
        No conditions set up
      </ThemedText>
      <ThemedText color="muted">
        Conditions to track (like skin symptoms or migraines) are set under health_conditions for
        your profile in the household's config.yaml. Ask whoever runs Chotu to add them; then
        check-ins, watchlists and trends appear here.
      </ThemedText>
    </Card>
  );
}

/** `3/5`, or that the day was skipped (unknown, never 0). */
export function scoreText(score: number | null | undefined): string {
  return score === null || score === undefined ? "Not checked in" : `${score}/5`;
}
