import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import type {
  CalendarResponse,
  PlannedExercise,
  StatusTipResponse,
  Task,
  WorkoutResponse,
} from "@/api";
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
import { isAnswerCurrent } from "@/workout/model";
import { useWorkoutQuery } from "@/workout/queries";
import { useSetQueue } from "@/workout/queue/provider";
import { useWorkoutSession } from "@/workout/session";

import { dueTasks, keptSince, taskDueText } from "./format";

/** At most this many due tasks are listed; the rest are counted. */
const DUE_TASKS_SHOWN = 5;

/**
 * The landing page: the profile's calendar, today's workout and plan, due
 * tasks, and Signal's /status numbers with its coach tip. Each card loads,
 * fails and retries on its own, so one slow or older endpoint never hides
 * the rest.
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
  const calendar = useQuery({
    queryKey: calendarQueryKey(scope),
    queryFn: () => client.calendar(),
    retry: false,
  });
  const today = latestDay(tasks.data?.date, status.data?.date, calendar.data?.date);
  // The tip asks the local model, so it loads once per household day, after
  // another card names that day, and otherwise only on request: pull to
  // refresh and the foreground never trigger a model call.
  const tip = useQuery({
    queryKey: tipQueryKey(scope, today),
    queryFn: () => client.statusTip(),
    enabled: today !== null,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const authError =
    useAuthErrorRoute([status.error, workout.error, tasks.error, calendar.error, tip.error]) !==
    undefined;
  const refresh = () =>
    Promise.all([status.refetch(), workout.refetch(), tasks.refetch(), calendar.refetch()]);

  return (
    <TabScreen screen="today" onRefresh={refresh}>
      {status.data ? (
        <ThemedText variant="overline" color="muted">
          {`${dayOverline(status.data.date)} · ${status.data.member.name}`}
        </ThemedText>
      ) : null}
      <CalendarCard query={calendar} today={today} authError={authError} />
      <FitnessCard query={workout} today={today} authError={authError} />
      <TasksCard query={tasks} today={today} authError={authError} />
      {!status.data && status.isPending ? <Progress label="Loading today's status" /> : null}
      <Failure query={status} what="today's status" noun="status" authError={authError} />
      {status.data ? <StatusBody status={status.data} /> : null}
      <CoachCard query={tip} authError={authError} />
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

/**
 * The newest household day either answer names. After midnight one refresh
 * can succeed while the other fails; the older day would hide today's tasks.
 */
function latestDay(...days: (string | undefined)[]): string | null {
  return (
    days
      .filter((day) => day !== undefined)
      .toSorted()
      .at(-1) ?? null
  );
}

const calendarQueryKey = (scope: string) => ["calendar", scope] as const;
const tipQueryKey = (scope: string, day: string | null) => ["status-tip", scope, day] as const;

/** An answer for a household day before the newest one another card loaded. */
function isOlderDay(answer: { date: string } | undefined, today: string | null): boolean {
  return answer !== undefined && today !== null && answer.date < today;
}

/** Today's events on this profile's own calendar, as Signal's /cal in their DM. */
function CalendarCard({
  query,
  today,
  authError,
}: {
  query: UseQueryResult<CalendarResponse>;
  today: string | null;
  authError: boolean;
}) {
  const theme = useTheme();
  const data = isOlderDay(query.data, today) ? undefined : query.data;
  const stale = query.data !== undefined && data === undefined;
  return (
    <Section title="Calendar">
      {!data && query.isFetching ? <Progress label="Loading your calendar" /> : null}
      {stale && !query.isFetching && !query.error ? (
        <ThemedText color="muted">
          Today's calendar hasn't loaded yet. Pull down to refresh.
        </ThemedText>
      ) : null}
      <Failure
        query={query}
        what="your calendar"
        noun="calendar"
        authError={authError}
        kept={data !== undefined}
      />
      {data && !data.linked ? (
        <ThemedText color="muted">
          Your calendar isn't linked. Link it in Signal with /login calendar.
        </ThemedText>
      ) : null}
      {data?.linked && data.events.length === 0 ? (
        <ThemedText color="muted">Nothing on your calendar today.</ThemedText>
      ) : null}
      {data?.events.map((event) => (
        <View
          key={event.id}
          accessible
          accessibilityLabel={[event.when, event.title, event.location].filter(Boolean).join(", ")}
          style={{ flexDirection: "row", gap: theme.spacing.md }}
        >
          <ThemedText variant="label" color="muted" style={{ minWidth: 96 }}>
            {event.when}
          </ThemedText>
          <View style={{ flexShrink: 1 }}>
            <ThemedText medium>{event.title}</ThemedText>
            {event.location ? (
              <ThemedText variant="label" color="muted">
                {event.location}
              </ThemedText>
            ) : null}
          </View>
        </View>
      ))}
    </Section>
  );
}

/** The local model's tip that ends Signal's /status, loaded apart so it never delays Today. */
function CoachCard({
  query,
  authError,
}: {
  query: UseQueryResult<StatusTipResponse>;
  authError: boolean;
}) {
  const data = query.data;
  return (
    <Section title="Coach">
      {query.isFetching ? <Progress label="Asking the coach" /> : null}
      <Failure
        query={query}
        what="a coach tip"
        noun="tip"
        authError={authError}
        kept={data !== undefined}
      />
      {!query.isFetching && data?.tip ? <ThemedText>{data.tip}</ThemedText> : null}
      {!query.isFetching && data && !data.tip ? (
        <ThemedText color="muted">Log food, sleep or a workout to get a tip.</ThemedText>
      ) : null}
      {!query.isFetching && data ? (
        <Button
          variant="text"
          label="New tip"
          accessibilityLabel="Ask the coach for a new tip"
          onPress={() => void query.refetch()}
        />
      ) : null}
    </Section>
  );
}

/** A failed load, with when the kept data was loaded (stale/offline). */
function Failure({
  query,
  what,
  noun,
  authError,
  kept = query.data !== undefined,
}: {
  query: UseQueryResult;
  what: string;
  noun: string;
  authError: boolean;
  /** Whether loaded data is still on screen. */
  kept?: boolean;
}) {
  if (!query.error || authError) return null;
  return (
    <LoadFailed
      what={what}
      noun={noun}
      message={messageForLoad(query.error)}
      keptNote={kept ? keptSince(query.dataUpdatedAt) : undefined}
      onRetry={() => void query.refetch()}
    />
  );
}

function FitnessCard({
  query,
  today,
  authError,
}: {
  query: UseQueryResult<WorkoutResponse>;
  /** The newest household day another card loaded. */
  today: string | null;
  authError: boolean;
}) {
  const router = useRouter();
  const queue = useSetQueue();
  const openWorkout = () => router.push("/workout");
  // A plan loaded on an earlier day isn't today's, even offline: by the
  // phone's clock (isAnswerCurrent), or because /tasks or /status already
  // name a newer household day. An open workout stays, as on Workout.
  const answer = query.data;
  const olderDay =
    answer?.date !== undefined && today !== null && answer.date < today && !answer.workout;
  const data =
    answer && !olderDay && isAnswerCurrent(answer, query.dataUpdatedAt) ? answer : undefined;
  const stale = query.data !== undefined && data === undefined;
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
      {stale && query.isFetching ? <Progress label="Loading today's workout" /> : null}
      {stale && !query.isFetching && !query.error ? (
        <ThemedText color="muted">Today's plan hasn't loaded yet. Pull down to refresh.</ThemedText>
      ) : null}

      <Failure
        query={query}
        what="today's workout"
        noun="workout"
        authError={authError}
        kept={data !== undefined}
      />
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
