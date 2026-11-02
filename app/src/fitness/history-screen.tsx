import { useInfiniteQuery } from "@tanstack/react-query";
import { View } from "react-native";

import type { HistoryWorkout } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { uniqueKeys } from "@/components/unique-keys";
import { useAuthErrorRoute, useProfileSession } from "@/connection";
import { shortDate } from "@/plan/format";
import { useTheme } from "@/theme";

import {
  fitnessLoadMessage,
  HISTORY_PAGE_DAYS,
  historyQueryKey,
  plural,
  setText,
  setTime,
} from "./format";

/** Recorded workouts, newest first, a page of workout days at a time. */
export function HistoryScreen() {
  const session = useProfileSession();
  return <ProfileHistoryScreen key={session.scope} />;
}

function ProfileHistoryScreen() {
  const theme = useTheme();
  const { client, scope } = useProfileSession();
  const query = useInfiniteQuery({
    queryKey: historyQueryKey(scope),
    queryFn: ({ pageParam }) =>
      client.workoutHistory({ before: pageParam ?? undefined, days: HISTORY_PAGE_DAYS }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_before,
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  const workouts = query.data?.pages.flatMap((page) => page.workouts) ?? [];

  return (
    <TabScreen screen="fitness-history" onRefresh={() => query.refetch()}>
      {!query.data && query.isPending ? <Progress label="Loading workout history" /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="workout history"
          noun="workout history"
          message={fitnessLoadMessage(query.error)}
          keptNote={query.data ? "Showing the workouts already loaded." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && workouts.length === 0 ? (
        <Card title="History">
          <ThemedText variant="title" accessibilityRole="header">
            No workouts logged yet
          </ThemedText>
          <ThemedText color="muted">
            Sets you log in Workout, or with /log in Signal, show up here. Pull down to refresh.
          </ThemedText>
        </Card>
      ) : null}
      {workouts.map((workout) => (
        <WorkoutCard key={workout.session_id} workout={workout} />
      ))}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          label={query.isFetchingNextPage ? "Loading…" : "Load older workouts"}
          accessibilityLabel="Load older workouts"
          disabled={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
        />
      ) : null}
      {query.data && workouts.length > 0 && !query.hasNextPage ? (
        <ThemedText color="muted" style={{ marginTop: theme.spacing.sm }}>
          That's every logged workout.
        </ThemedText>
      ) : null}
    </TabScreen>
  );
}

function WorkoutCard({ workout }: { workout: HistoryWorkout }) {
  const theme = useTheme();
  const status = workout.closed ? "" : " · In progress";
  const keys = uniqueKeys(workout.exercises.map((exercise) => exercise.name));
  return (
    <Section
      title={`${shortDate(workout.date)}${status}`}
      subtitle={`${plural(workout.exercises.length, "exercise")} · ${plural(workout.set_count, "set")}`}
    >
      {workout.exercises.map((exercise, position) => (
        <View key={keys[position]} style={{ gap: theme.spacing.xs, marginTop: theme.spacing.sm }}>
          <ThemedText medium>{exercise.name}</ThemedText>
          {exercise.sets.map((set, index) => {
            const time = setTime(set);
            const text = `${index + 1}. ${setText(set)}`;
            return (
              <View
                key={set.id}
                accessible
                accessibilityLabel={`${exercise.name} set ${index + 1}: ${setText(set)}${time ? ` at ${time}` : ""}`}
                style={{ flexDirection: "row", justifyContent: "space-between" }}
              >
                <ThemedText>{text}</ThemedText>
                <ThemedText color="muted">{time}</ThemedText>
              </View>
            );
          })}
        </View>
      ))}
    </Section>
  );
}
