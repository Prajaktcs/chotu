import { useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Screen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import { pendingSetsLabel, usePendingSetCount } from "@/connection";
import { useTheme } from "@/theme";

import {
  canonicalExercise,
  countedSets,
  offPlanExercises,
  rowsFor,
  setsLabel,
  type SetRow,
} from "../model";
import { useSetQueue } from "../queue/provider";
import { formatSet, formatWeight } from "../units";
import { formatClock } from "../time";
import { useWorkoutView } from "../use-workout-view";

/** Back to the workout: pop when there is history, else replace. */
function useBackToWorkout() {
  const router = useRouter();
  return () => {
    if (router.canGoBack()) router.back();
    else router.replace("/workout");
  };
}

function Layout({
  overline,
  title,
  description,
  children,
  actions,
  footer,
}: {
  overline?: string;
  title: string;
  description?: string;
  children?: ReactNode;
  actions: ReactNode;
  footer?: string;
}) {
  const theme = useTheme();
  return (
    <Screen scroll>
      {overline ? (
        <ThemedText variant="overline" color="muted">
          {overline}
        </ThemedText>
      ) : null}
      <ThemedText variant="headline" accessibilityRole="header">
        {title}
      </ThemedText>
      {description ? <ThemedText color="muted">{description}</ThemedText> : null}
      {children}
      <View style={{ flex: 1 }} />
      <View style={{ gap: theme.spacing.sm }}>{actions}</View>
      {footer ? (
        <ThemedText variant="label" color="muted">
          {footer}
        </ThemedText>
      ) : null}
    </Screen>
  );
}

/** Pick an exercise; logging returns with its next target pre-filled. */
export function ChangeExerciseScreen() {
  const theme = useTheme();
  const back = useBackToWorkout();
  const { workout, rows, session } = useWorkoutView();
  const [other, setOther] = useState("");
  const [error, setError] = useState<string | null>(null);

  const choose = (name: string) => {
    session.selectExercise(name);
    back();
  };
  const chooseOther = () => {
    const name = other.trim();
    if (!name) {
      setError("Enter the exercise name.");
      return;
    }
    // The name the server will save it under, so its rows stay on this exercise.
    choose(canonicalExercise(workout?.exercises ?? [], name));
  };

  return (
    <Layout
      overline="Today's workout"
      title="Change exercise"
      actions={
        <Button
          variant="text"
          label="Back to workout"
          accessibilityLabel="Back to workout"
          onPress={back}
        />
      }
    >
      <View style={{ gap: theme.spacing.sm }}>
        {(workout?.exercises ?? []).map((exercise) => {
          const label = `${exercise.name} · ${countedSets(rowsFor(rows, exercise.name))} of ${exercise.sets} sets`;
          return (
            <Button
              key={exercise.name}
              variant="secondary"
              label={label}
              accessibilityLabel={label}
              onPress={() => choose(exercise.name)}
            />
          );
        })}
        {offPlanExercises(workout, rows).map((name) => {
          const label = `${name} · ${setsLabel(countedSets(rowsFor(rows, name)))}`;
          return (
            <Button
              key={name}
              variant="secondary"
              label={label}
              accessibilityLabel={label}
              onPress={() => choose(name)}
            />
          );
        })}
      </View>
      <TextField
        label="Other exercise"
        value={other}
        onChangeText={(text) => {
          setOther(text);
          setError(null);
        }}
        placeholder="e.g. Pull-ups"
        hint="Any lift, in the plan or not."
        error={error}
        onSubmitEditing={chooseOther}
      />
      <Button
        variant="secondary"
        label="Use this exercise"
        accessibilityLabel="Use this exercise"
        onPress={chooseOther}
      />
    </Layout>
  );
}

function stateLine(row: SetRow): string {
  const time = row.performedAt ? formatClock(row.performedAt) : "";
  switch (row.state) {
    case "saved":
      return `${row.label} · Saved`;
    case "pending":
      return `${row.label} · Pending since ${time}`;
    case "failed":
      return `${row.label} · Not saved`;
    default: {
      const unhandled: never = row.state;
      return unhandled;
    }
  }
}

/** Undo or keep one set. A pending set leaves the queue; a saved one is deleted on the server. */
export function SetActionsScreen() {
  const back = useBackToWorkout();
  const { key } = useLocalSearchParams<{ key?: string }>();
  const { workout, rows, queue, session } = useWorkoutView();
  const row = rows.find((candidate) => candidate.key === key) ?? null;

  if (!row) {
    return (
      <Layout
        title="Set actions"
        description="That set is no longer on this workout."
        actions={
          <Button label="Back to workout" accessibilityLabel="Back to workout" onPress={back} />
        }
      />
    );
  }

  const number = rowsFor(rows, row.exercise).indexOf(row) + 1;
  const undo = () => {
    if (row.source === "queued") {
      void queue.queue.remove(row.id);
    } else {
      const set = workout?.sets.find((candidate) => candidate.id === row.id);
      if (set) void session.undoSavedSet(set);
    }
    back();
  };

  return (
    <Layout
      title="Set actions"
      actions={
        <>
          <Button
            variant="danger"
            label="Undo this set"
            accessibilityLabel={`Undo set ${number}: ${row.exercise}, ${row.label}`}
            onPress={undo}
          />
          <Button variant="text" label="Keep set" accessibilityLabel="Keep set" onPress={back} />
        </>
      }
      footer={
        row.source === "queued"
          ? "This set hasn't been sent; undo removes it from this phone."
          : "Undo removes this set on the server. It comes back if that fails."
      }
    >
      <Card title={`${row.exercise} · Set ${number}`} body={stateLine(row)} testID="set-card" />
    </Layout>
  );
}

/** After Done: what was logged, and whether anything is still waiting to send. */
export function WorkoutCompleteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ sets?: string; exercises?: string; title?: string }>();
  const pending = usePendingSetCount() ?? 0;
  const sets = Number(params.sets ?? 0);
  const exercises = Number(params.exercises ?? 0);
  return (
    <Layout
      overline="Workout complete"
      title={`${params.title ?? "Workout"} · Today`}
      actions={
        <Button
          label="Back to today"
          accessibilityLabel="Back to today"
          onPress={() => router.dismissTo("/workout")}
        />
      }
    >
      <Card
        title={`${setsLabel(sets)} logged`}
        body={`${exercises} ${exercises === 1 ? "exercise" : "exercises"}`}
      />
      {pending > 0 ? (
        <Card
          title={`Workout finished · ${pendingSetsLabel(pending)}`}
          body="They stay on this phone and send when connected."
          testID="complete-pending"
        />
      ) : (
        <Card title="All sets saved" body="Your plan reflects today's progress." />
      )}
    </Layout>
  );
}

/** Sets still on this phone, each with Undo. */
export function UnsentSetsScreen() {
  const back = useBackToWorkout();
  const { items, queue } = useSetQueue();
  const pending = items.filter((item) => item.status === "pending");
  return (
    <Layout
      title="Unsent sets"
      description={`${pending.length} pending · kept on this phone until delivered`}
      actions={
        <Button
          variant="secondary"
          label="Back to workout"
          accessibilityLabel="Back to workout"
          onPress={back}
        />
      }
      footer="Sends automatically when connected. Original times stay attached; retries never create duplicate sets."
    >
      {pending.map((item) => {
        const set = formatSet(formatWeight(item.weight, item.unit), item.reps);
        const time = formatClock(item.performedAt);
        return (
          <Card
            key={item.requestId}
            title={`◷ Pending · ${item.exercise}`}
            body={`${set} · ${time}`}
          >
            <Button
              variant="text"
              label="Undo pending set"
              accessibilityLabel={`Undo pending set: ${item.exercise}, ${set} at ${time}`}
              onPress={() => void queue.remove(item.requestId)}
            />
          </Card>
        );
      })}
    </Layout>
  );
}

/**
 * A set the server rejected: the reason, and retry it unchanged or remove it.
 * Retry keeps the body and time but sends a new request id, because the
 * server stored the rejection under the old one (a time that was ahead of the
 * server's clock can be accepted later).
 */
export function FailedSetScreen() {
  const back = useBackToWorkout();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { items, queue } = useSetQueue();
  const item = items.find((candidate) => candidate.requestId === id) ?? null;

  if (!item) {
    return (
      <Layout
        title="Set wasn't saved"
        description="That set is no longer waiting on this phone."
        actions={
          <Button label="Back to logging" accessibilityLabel="Back to logging" onPress={back} />
        }
      />
    );
  }

  const set = formatSet(formatWeight(item.weight, item.unit), item.reps);
  return (
    <Layout
      title="Set wasn't saved"
      description={`${item.exercise} · ${set} · ${formatClock(item.performedAt)}`}
      actions={
        <>
          <Button
            variant="secondary"
            label="Retry unchanged"
            accessibilityLabel="Retry unchanged: same set and time"
            onPress={() => {
              void queue.retry(item.requestId).then(back);
            }}
          />
          <Button
            variant="danger"
            label="Remove failed set"
            accessibilityLabel="Remove failed set"
            onPress={() => {
              void queue.remove(item.requestId).then(back);
            }}
          />
          <Button
            variant="text"
            label="Back to logging"
            accessibilityLabel="Back to logging"
            onPress={back}
          />
        </>
      }
    >
      <Card title="Reason" body={item.reason ?? "Rejected by the server."} testID="failed-reason" />
      <Card title="Original set stays visible" body="Rejected sets are never silently dropped." />
    </Layout>
  );
}
