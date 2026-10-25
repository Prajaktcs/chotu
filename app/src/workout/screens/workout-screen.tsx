import { useLocalSearchParams, useRouter } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";

import { ApiError } from "@/api";
import { AppBar } from "@/components/app-bar";
import { Banner } from "@/components/banner";
import { BottomNav } from "@/components/bottom-nav";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Progress } from "@/components/progress";
import { Screen } from "@/components/screen";
import { Stepper } from "@/components/stepper";
import { ThemedText } from "@/components/themed-text";
import { messageForError, routeForApiError } from "@/connection";
import { useTheme } from "@/theme";

import { newRequestId } from "../ids";
import { countedSets, nextSet, planSummary, setsLabel, type SetRow } from "../model";
import { workoutOverline, planDayName, toLocalRfc3339 } from "../time";
import {
  formatSet,
  formatWeight,
  MAX_REPS,
  MIN_REPS,
  stepWeightDown,
  stepWeightUp,
} from "../units";
import { useWorkoutView } from "../use-workout-view";

type WorkoutView = ReturnType<typeof useWorkoutView>;

/** The text and symbol for a set's state; never colour alone. */
export const STATE_TEXT = {
  saved: "✓ Saved",
  pending: "◷ Pending",
  failed: "! Failed",
} as const;

function isAuthError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.kind === "unauthorized" || error.kind === "forbidden" || error.kind === "updateRequired")
  );
}

function isOffline(error: unknown): boolean {
  return error instanceof ApiError && (error.kind === "network" || error.kind === "server");
}

/**
 * The workout tab: loading and edge states, Ready to train, and logging.
 * Offline it keeps working from the last loaded workout; sets go to the queue.
 */
export function WorkoutScreen() {
  const router = useRouter();
  const { offline } = useLocalSearchParams<{ offline?: string }>();
  const view = useWorkoutView();
  const { query, queue, session, workout, rows } = view;
  const setQueue = queue.queue;

  const error = query.error;
  const hasData = query.data !== undefined;
  const fetching = query.isFetching;
  const keepOffline = offline === "1";

  // Auth and version problems always go to their screen. Connection problems
  // only when there is no workout to log against (the queue keeps sets).
  useEffect(() => {
    if (!error || fetching) return;
    const route = routeForApiError(error);
    if (!route) return;
    if (isAuthError(error) || (!hasData && !keepOffline)) router.replace(route);
  }, [error, fetching, hasData, keepOffline, router]);

  // A successful load means the server is reachable: send what's waiting.
  const loadedAt = query.dataUpdatedAt;
  useEffect(() => {
    if (loadedAt > 0) setQueue.kick();
  }, [loadedAt, setQueue]);

  // Replay stopped on a 401, 403 or 426. Read live: a kick may have cleared it.
  const blocked = queue.blocked;
  useEffect(() => {
    if (!blocked) return;
    const live = setQueue.getSnapshot().blocked;
    if (!live) return;
    const route = routeForApiError(live);
    if (route) router.replace(route);
  }, [blocked, setQueue, router]);

  if (!hasData) {
    if (error && !isAuthError(error) && isOffline(error)) {
      return <ConnectToLoad view={view} />;
    }
    if (error && !isAuthError(error)) {
      return (
        <Chrome>
          <ThemedText variant="headline" accessibilityRole="header">
            {"Couldn't load your workout"}
          </ThemedText>
          <ThemedText color="muted">{messageForError(error)}</ThemedText>
          <View style={{ flex: 1 }} />
          <Button label="Retry" accessibilityLabel="Retry" onPress={() => void query.refetch()} />
        </Chrome>
      );
    }
    return (
      <Chrome>
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Progress label="Loading your workout" />
        </View>
      </Chrome>
    );
  }

  if (!workout && rows.length === 0 && session.selectedExercise === null) {
    return <NoWorkout view={view} />;
  }
  if (
    workout &&
    workout.exercises.length > 0 &&
    rows.length === 0 &&
    !session.started &&
    session.selectedExercise === null
  ) {
    return <ReadyToTrain view={view} />;
  }
  return <Logging view={view} />;
}

/** The app bar, the content, and the bottom navigation. */
function Chrome({ children }: { children: ReactNode }) {
  const router = useRouter();
  return (
    <Screen>
      <AppBar
        title="Workout"
        action={{
          label: "Profile",
          accessibilityLabel: "Profile and settings",
          onPress: () => router.push("/settings"),
        }}
      />
      {children}
      <BottomNav selected="workout" />
    </Screen>
  );
}

function Overline({ view }: { view: WorkoutView }) {
  const [today] = useState(() => new Date());
  return (
    <ThemedText variant="overline" color="muted">
      {workoutOverline(today, view.workout?.plan_day ?? null)}
    </ThemedText>
  );
}

/** Pull to refresh: reload the workout and try sending the queue. */
function useRefresh(view: WorkoutView) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    view.queue.queue.kick();
    void view.query.refetch().finally(() => setRefreshing(false));
  };
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;
}

/** Offline and failure banners, and any message from undo or Done. */
function QueueStatus({ view }: { view: WorkoutView }) {
  const { queue, query, session } = view;
  const connectionDown = queue.waiting || isOffline(query.error);
  const firstFailed = queue.items.find((item) => item.status === "failed");
  return (
    <>
      {queue.pendingCount > 0 && connectionDown ? (
        <Banner
          tone="pending"
          testID="offline-banner"
          title={`Offline · ${setsLabel(queue.pendingCount)} pending`}
          body="Saved on this phone. Sends when connected."
        />
      ) : null}
      {queue.pendingCount === 0 && isOffline(query.error) ? (
        <Banner
          tone="pending"
          testID="offline-banner"
          title="Offline"
          body="Showing the last loaded workout. New sets are saved on this phone."
        />
      ) : null}
      {firstFailed ? (
        <Banner
          tone="error"
          testID="failed-banner"
          title={`${setsLabel(queue.failedCount)} ${queue.failedCount === 1 ? "needs" : "need"} attention`}
          body={`Not saved: ${firstFailed.reason ?? "rejected by the server"}`}
        />
      ) : null}
      {session.notice ? (
        <ThemedText color="error" accessibilityRole="alert">
          {session.notice}
        </ThemedText>
      ) : null}
    </>
  );
}

function Logging({ view }: { view: WorkoutView }) {
  const theme = useTheme();
  const router = useRouter();
  const { workout, currentExercise, currentRows, planned, weightUnit, queue, session } = view;
  const refresh = useRefresh(view);
  const [finishing, setFinishing] = useState(false);

  // Once logging, stay here even if every set is undone (no bounce back to Ready to train).
  const { start } = session;
  useEffect(() => {
    start();
  }, [start]);

  // The steppers start at the next target and reset when it moves on.
  const target = nextSet(planned, currentRows, weightUnit);
  const targetKey = `${currentExercise ?? ""}|${countedSets(currentRows)}|${weightUnit}`;
  const [draft, setDraft] = useState<{ key: string; weight: number | null; reps: number } | null>(
    null,
  );
  const values = draft?.key === targetKey ? draft : { key: targetKey, ...target };
  const update = (next: Partial<{ weight: number | null; reps: number }>) =>
    setDraft({ ...values, ...next });

  const exercises = workout?.exercises ?? [];
  const index = planned ? exercises.indexOf(planned) : -1;
  const changeLabel =
    index >= 0 ? `Exercise ${index + 1} of ${exercises.length} · Change` : "Change exercise";

  const weightText = formatWeight(values.weight, weightUnit);
  const logSet = () => {
    if (currentExercise === null) return;
    void queue.queue.enqueue({
      requestId: newRequestId(),
      exercise: currentExercise,
      weight: values.weight,
      unit: weightUnit,
      reps: values.reps,
      performedAt: toLocalRfc3339(new Date()),
    });
  };

  const done = async () => {
    setFinishing(true);
    const result = await session.finish();
    setFinishing(false);
    if (!result.ok) return;
    const summary = result.summary;
    router.push({
      pathname: "/workout/complete",
      params: {
        sets: String(
          summary.exercises.reduce((total, exercise) => total + exercise.sets.length, 0),
        ),
        exercises: String(summary.exercises.length),
        title: planDayName(workout?.plan_day ?? null) ?? "Workout",
      },
    });
  };

  return (
    <Chrome>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: theme.spacing.md, paddingBottom: theme.spacing.md }}
        refreshControl={refresh}
      >
        <Overline view={view} />
        <ThemedText variant="headline" accessibilityRole="header">
          {currentExercise ?? "Choose an exercise"}
        </ThemedText>
        <Button
          variant="secondary"
          label={changeLabel}
          accessibilityLabel={
            index >= 0
              ? `Exercise ${index + 1} of ${exercises.length}. Change exercise`
              : "Change exercise"
          }
          onPress={() => router.push("/workout/change")}
        />
        <QueueStatus view={view} />
        <ThemedText variant="title" accessibilityRole="header">
          {"Today's sets"}
        </ThemedText>
        {currentRows.length === 0 ? (
          <ThemedText color="muted">No sets yet for this exercise.</ThemedText>
        ) : (
          <View style={{ gap: theme.spacing.xs }}>
            {currentRows.map((row, i) => (
              <SetRowView key={row.key} row={row} number={i + 1} />
            ))}
          </View>
        )}
        <ReviewButtons view={view} />
      </ScrollView>

      <View style={{ gap: theme.spacing.sm }}>
        <ThemedText variant="overline" color="muted">
          Next set · pre-filled target
        </ThemedText>
        <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
          <Stepper
            label="Weight"
            value={weightText}
            testID="weight-stepper"
            canDecrease={values.weight !== null}
            onDecrease={() => update({ weight: stepWeightDown(values.weight, weightUnit) })}
            onIncrease={() => update({ weight: stepWeightUp(values.weight, weightUnit) })}
          />
          <Stepper
            label="Reps"
            value={`${values.reps} reps`}
            testID="reps-stepper"
            canDecrease={values.reps > MIN_REPS}
            canIncrease={values.reps < MAX_REPS}
            onDecrease={() => update({ reps: values.reps - 1 })}
            onIncrease={() => update({ reps: values.reps + 1 })}
          />
        </View>
        <Button
          label="Log set"
          accessibilityLabel={
            currentExercise === null
              ? "Log set"
              : `Log set: ${currentExercise}, ${formatSet(weightText, values.reps)}`
          }
          disabled={currentExercise === null}
          onPress={logSet}
        />
        <Button
          variant="text"
          label={finishing ? "Finishing…" : "Done"}
          accessibilityLabel="Done: finish today's workout"
          disabled={finishing}
          onPress={() => void done()}
        />
      </View>
    </Chrome>
  );
}

/** Buttons to review pending or failed sets; below Today's sets on the logging view. */
function ReviewButtons({ view }: { view: WorkoutView }) {
  const router = useRouter();
  const { queue, query, session } = view;
  const connectionDown = queue.waiting || isOffline(query.error);
  const firstFailed = queue.items.find((item) => item.status === "failed");
  return (
    <>
      {queue.pendingCount > 0 && (connectionDown || session.doneWaitingOnQueue) ? (
        <Button
          variant="secondary"
          label={`Review ${queue.pendingCount} pending ${queue.pendingCount === 1 ? "set" : "sets"}`}
          accessibilityLabel={`Review ${queue.pendingCount} pending ${queue.pendingCount === 1 ? "set" : "sets"}`}
          onPress={() => router.push("/workout/unsent")}
        />
      ) : null}
      {firstFailed ? (
        <Button
          variant="danger"
          label="Review failed set"
          accessibilityLabel="Review failed set"
          onPress={() =>
            router.push({ pathname: "/workout/failed", params: { id: firstFailed.requestId } })
          }
        />
      ) : null}
    </>
  );
}

/** A row in Today's sets. Tap or long-press opens Set actions (a failed set opens its review). */
function SetRowView({ row, number }: { row: SetRow; number: number }) {
  const theme = useTheme();
  const router = useRouter();
  const open = () => {
    if (row.state === "failed") {
      router.push({ pathname: "/workout/failed", params: { id: row.id } });
    } else {
      router.push({ pathname: "/workout/set", params: { key: row.key } });
    }
  };
  const stateColor =
    row.state === "saved" ? "muted" : row.state === "pending" ? "pending" : "error";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Set ${number}: ${row.label}. ${STATE_TEXT[row.state].slice(2)}`}
      accessibilityHint={row.state === "failed" ? "Opens the failed set" : "Opens set actions"}
      accessibilityActions={[{ name: "longpress", label: "Set actions" }]}
      onAccessibilityAction={open}
      onPress={open}
      onLongPress={open}
      testID={`set-row-${number}`}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing.lg,
        minHeight: theme.buttonHeights.secondary,
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radii.card,
        backgroundColor: theme.colors.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <ThemedText color="muted" style={{ minWidth: 20 }}>
        {String(number)}
      </ThemedText>
      <ThemedText style={{ flex: 1 }}>{row.label}</ThemedText>
      <ThemedText variant="label" medium color={stateColor}>
        {STATE_TEXT[row.state]}
      </ThemedText>
    </Pressable>
  );
}

function ReadyToTrain({ view }: { view: WorkoutView }) {
  const theme = useTheme();
  const { workout, weightUnit, session } = view;
  const refresh = useRefresh(view);
  return (
    <Chrome>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: theme.spacing.md }}
        refreshControl={refresh}
      >
        <Overline view={view} />
        <ThemedText variant="headline" accessibilityRole="header">
          Ready to train
        </ThemedText>
        <QueueStatus view={view} />
        <ReviewButtons view={view} />
        {(workout?.exercises ?? []).map((exercise) => (
          <Card
            key={exercise.name}
            title={exercise.name}
            body={planSummary(exercise, weightUnit)}
          />
        ))}
      </ScrollView>
      <Button
        label="Start workout"
        accessibilityLabel="Start workout"
        onPress={() => session.start()}
      />
    </Chrome>
  );
}

function NoWorkout({ view }: { view: WorkoutView }) {
  const theme = useTheme();
  const router = useRouter();
  const refresh = useRefresh(view);
  return (
    <Chrome>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: theme.spacing.md }}
        refreshControl={refresh}
      >
        <Overline view={view} />
        <ThemedText variant="headline" accessibilityRole="header">
          No workout today
        </ThemedText>
        <QueueStatus view={view} />
        <ReviewButtons view={view} />
        <Card
          title="You're up to date"
          body="No workout is open. Logging a set starts one."
          testID="up-to-date"
        />
      </ScrollView>
      <Button
        variant="secondary"
        label="Log a set"
        accessibilityLabel="Log a set: choose an exercise"
        onPress={() => router.push("/workout/change")}
      />
    </Chrome>
  );
}

/** No workout was loaded on this phone and the server can't be reached. */
function ConnectToLoad({ view }: { view: WorkoutView }) {
  const router = useRouter();
  const { query, queue } = view;
  return (
    <Chrome>
      <ThemedText variant="headline" accessibilityRole="header">
        Connect to load your workout
      </ThemedText>
      <ThemedText color="muted">
        {"Chotu's server can't be reached, and no workout is loaded on this phone yet."}
      </ThemedText>
      <QueueStatus view={view} />
      <ReviewButtons view={view} />
      <View style={{ flex: 1 }} />
      <Button
        label={query.isFetching ? "Checking…" : "Try again"}
        accessibilityLabel="Try again"
        disabled={query.isFetching}
        onPress={() => {
          queue.queue.kick();
          void query.refetch();
        }}
      />
      <Button
        variant="text"
        label="Connection help"
        accessibilityLabel="Connection help"
        onPress={() => router.push("/connection/tailscale")}
      />
    </Chrome>
  );
}
