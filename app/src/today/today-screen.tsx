import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import type { PlannedExercise, Task, WorkoutResponse } from "@/api";
import { Button } from "@/components/button";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { kindLabel, prescription, targetText } from "@/plan/format";
import { StatusBody } from "@/status/status-body";
import { dayOverline, statusQueryKey } from "@/status/format";
import { taskActions, tasksQueryKey, visibleTasks } from "@/tasks/actions";
import { useTheme } from "@/theme";
import { useWorkoutQuery } from "@/workout/queries";
import { useSetQueue } from "@/workout/queue/provider";
import { useWorkoutSession } from "@/workout/session";

import { dueTasks, keptSince, taskDueText } from "./format";

/** At most this many due tasks are listed; the rest are counted. */
const DUE_TASKS_SHOWN = 5;

/**
 * The landing page: today's workout and plan, due tasks, and Signal's
 * /status numbers for the profile. Each card loads, fails and retries on its
 * own, so one slow or older endpoint never hides the rest.
 */
export function TodayScreen() {
  const session = useProfileSession();
  return <ProfileTodayScreen key={session.scope} />;
}

function ProfileTodayScreen() {
  const router = useRouter();
  const { client, scope } = useProfileSession();
  const status = useQuery({
    queryKey: statusQueryKey(scope),
    queryFn: () => client.status(),
    retry: false,
  });
  const workout = useWorkoutQuery();
  const tasks = useQuery({
    queryKey: tasksQueryKey(scope),
    queryFn: () => client.tasks(),
    retry: false,
  });
  const authError = useAuthErrorRoute([status.error, workout.error, tasks.error]) !== undefined;
  const refresh = () => Promise.all([status.refetch(), workout.refetch(), tasks.refetch()]);

  return (
    <TabScreen screen="today" onRefresh={refresh}>
      {status.data ? (
        <ThemedText variant="overline" color="muted">
          {`${dayOverline(status.data.date)} · ${status.data.member.name}`}
        </ThemedText>
      ) : null}
      <FitnessCard query={workout} authError={authError} />
      <TasksCard
        query={tasks}
        today={tasks.data?.date ?? status.data?.date ?? null}
        authError={authError}
      />
      {!status.data && status.isPending ? <Progress label="Loading today's status" /> : null}
      <Failure query={status} what="today's status" noun="status" authError={authError} />
      {status.data ? <StatusBody status={status.data} /> : null}
      {status.data ? (
        <Button
          variant="secondary"
          label="Open Nutrition"
          accessibilityLabel="Open Nutrition"
          onPress={() => router.push("/food")}
        />
      ) : null}
    </TabScreen>
  );
}

/** A failed load, with when the kept data was loaded (stale/offline). */
function Failure({
  query,
  what,
  noun,
  authError,
}: {
  query: UseQueryResult;
  what: string;
  noun: string;
  authError: boolean;
}) {
  if (!query.error || authError) return null;
  return (
    <LoadFailed
      what={what}
      noun={noun}
      message={messageForLoad(query.error)}
      keptNote={query.data ? keptSince(query.dataUpdatedAt) : undefined}
      onRetry={() => void query.refetch()}
    />
  );
}

function FitnessCard({
  query,
  authError,
}: {
  query: UseQueryResult<WorkoutResponse>;
  authError: boolean;
}) {
  const router = useRouter();
  const queue = useSetQueue();
  const openWorkout = () => router.push("/workout");
  const data = query.data;
  const workout = data?.workout ?? null;
  const pending = queue.pendingCount + queue.failedCount;

  let summary: string | null = null;
  if (workout) {
    const sets = workout.sets.length;
    summary = `Workout in progress · ${sets} ${sets === 1 ? "set" : "sets"}`;
    if (workout.current_exercise) summary += ` · now ${workout.current_exercise}`;
  } else if (data && !data.plan) {
    summary = "No lifts planned for the rest of today.";
  }
  const day = workout?.plan_day ?? data?.plan?.plan_day ?? null;
  const exercises = workout ? [] : (data?.plan?.exercises ?? []);

  return (
    <Section
      title="Fitness"
      subtitle={day ? `${kindLabel(day.kind)}${day.notes ? ` · ${day.notes}` : ""}` : undefined}
    >
      {!data && query.isPending ? <Progress label="Loading today's workout" /> : null}
      <Failure query={query} what="today's workout" noun="workout" authError={authError} />
      {summary ? <ThemedText>{summary}</ThemedText> : null}
      {pending > 0 ? (
        <ThemedText color="pending">
          {`${pending} ${pending === 1 ? "set" : "sets"} waiting on this phone`}
        </ThemedText>
      ) : null}
      {exercises.map((exercise) => (
        <ExerciseLink key={exercise.name} exercise={exercise} />
      ))}
      {data ? (
        <Button
          variant="secondary"
          label={workout ? "Continue workout" : "Open Fitness"}
          accessibilityLabel={workout ? "Continue workout" : "Open Fitness"}
          onPress={openWorkout}
        />
      ) : null}
    </Section>
  );
}

/** Opens Workout with this planned lift chosen, as tapping it in Plan does. */
function ExerciseLink({ exercise }: { exercise: PlannedExercise }) {
  const theme = useTheme();
  const router = useRouter();
  const session = useWorkoutSession();
  const { weightUnit } = useProfileSession();
  const next = targetText(exercise.target, weightUnit);
  const details = [prescription(exercise), next ? `Next: ${next}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${exercise.name}. ${details}`}
      accessibilityHint="Opens the workout screen to log it"
      onPress={() => {
        session.selectExercise(exercise.name);
        router.push("/workout");
      }}
      style={({ pressed }) => ({
        minHeight: theme.minTapTarget,
        justifyContent: "center",
        gap: theme.spacing.xs,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radii.card,
        backgroundColor: theme.colors.container,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.md }}
      >
        <ThemedText medium style={{ flexShrink: 1 }}>
          {exercise.name}
        </ThemedText>
        <ThemedText variant="label" medium color="primary">
          {"Log ›"}
        </ThemedText>
      </View>
      <ThemedText variant="label" color="muted">
        {details}
      </ThemedText>
    </Pressable>
  );
}

function TasksCard({
  query,
  today,
  authError,
}: {
  query: UseQueryResult<{ tasks: Task[] }>;
  today: string | null;
  authError: boolean;
}) {
  const theme = useTheme();
  const router = useRouter();
  const { client, scope } = useProfileSession();
  const queryClient = useQueryClient();
  const actions = taskActions(queryClient, scope, client);
  // Pending completions and snoozes from the Tasks screen apply here too.
  const operations = useSyncExternalStore(
    actions.subscribe,
    actions.getSnapshot,
    actions.getSnapshot,
  );
  const due = today ? dueTasks(visibleTasks(query.data?.tasks ?? [], operations), today) : [];
  const shown = due.slice(0, DUE_TASKS_SHOWN);

  return (
    <Section title="Tasks" subtitle={query.data && today ? `${due.length} due` : undefined}>
      {!query.data && query.isPending ? <Progress label="Loading tasks" /> : null}
      <Failure query={query} what="tasks" noun="tasks" authError={authError} />
      {query.data && !today ? (
        <ThemedText color="muted">
          Due dates need today's household date. Pull to refresh.
        </ThemedText>
      ) : null}
      {query.data && today && due.length === 0 ? (
        <ThemedText color="muted">Nothing due today.</ThemedText>
      ) : null}
      {shown.map((task) => (
        <Pressable
          key={task.id}
          accessibilityRole="link"
          accessibilityLabel={`${task.title}. ${taskDueText(task, today ?? "")}`}
          accessibilityHint="Opens Task actions in Tasks"
          onPress={() => router.push({ pathname: "/tasks", params: { task: task.id } })}
          style={({ pressed }) => ({
            minHeight: theme.minTapTarget,
            justifyContent: "center",
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radii.card,
            backgroundColor: theme.colors.container,
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <ThemedText medium>{task.title}</ThemedText>
          <ThemedText variant="label" color="muted">
            {taskDueText(task, today ?? "")}
          </ThemedText>
        </Pressable>
      ))}
      {due.length > shown.length ? (
        <ThemedText variant="label" color="muted">
          {`${due.length - shown.length} more due`}
        </ThemedText>
      ) : null}
      {query.data ? (
        <Button
          variant="secondary"
          label="Open Tasks"
          accessibilityLabel="Open Tasks"
          onPress={() => router.push("/tasks")}
        />
      ) : null}
    </Section>
  );
}
