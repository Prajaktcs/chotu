import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { WorkoutTrendsResponse } from "@/api";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { uniqueKeys } from "@/components/unique-keys";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { shortDate } from "@/plan/format";
import { useTheme } from "@/theme";

import {
  loadChange,
  plural,
  pointText,
  rangeText,
  TREND_RANGES,
  type TrendRange,
  trendsQueryKey,
} from "./format";

/** The most recent sessions shown per exercise. */
const RECENT_POINTS = 5;

/** Training volume and each exercise's working sets over a chosen range. */
export function TrendsScreen() {
  const session = useProfileSession();
  return <ProfileTrendsScreen key={session.scope} />;
}

function ProfileTrendsScreen() {
  const theme = useTheme();
  const { client, scope } = useProfileSession();
  const [days, setDays] = useState<TrendRange>(28);
  const query = useQuery({
    queryKey: trendsQueryKey(scope, days),
    queryFn: () => client.workoutTrends(days),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  // While another range loads, the previous one stays visible but is labelled.
  const trends = query.data;
  const stale = query.isPlaceholderData;

  return (
    <TabScreen screen="fitness-trends" onRefresh={() => query.refetch()}>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", gap: theme.spacing.sm }}>
        {TREND_RANGES.map((choice) => (
          <Pressable
            key={choice}
            accessibilityRole="radio"
            accessibilityLabel={`Last ${choice} days`}
            accessibilityState={{ checked: days === choice }}
            aria-checked={days === choice}
            onPress={() => setDays(choice)}
            style={{
              flex: 1,
              minHeight: theme.minTapTarget,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: theme.radii.full,
              borderWidth: 1,
              borderColor: theme.colors.outline,
              backgroundColor: days === choice ? theme.colors.container : "transparent",
            }}
          >
            <ThemedText variant="label" medium>{`${choice} days`}</ThemedText>
          </Pressable>
        ))}
      </View>
      {!trends && query.isPending ? <Progress label="Loading training trends" /> : null}
      {stale ? <Progress label={`Loading the last ${days} days`} /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="training trends"
          noun="training trends"
          message={messageForLoad(query.error)}
          keptNote={trends ? "Showing the last loaded trends." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {trends ? <TrendsBody trends={trends} /> : null}
    </TabScreen>
  );
}

function TrendsBody({ trends }: { trends: WorkoutTrendsResponse }) {
  const theme = useTheme();
  const keys = uniqueKeys(trends.exercises.map((exercise) => exercise.name));
  if (trends.workout_days === 0) {
    return (
      <Card title={rangeText(trends)}>
        <ThemedText variant="title" accessibilityRole="header">
          {`No training in the last ${trends.days} days`}
        </ThemedText>
        <ThemedText color="muted">
          Trends come from sets logged in Workout or with /log in Signal, and from synced strength
          sessions. Try a longer range.
        </ThemedText>
      </Card>
    );
  }
  return (
    <>
      <ThemedText variant="overline" color="muted">
        {`${rangeText(trends)} · last ${trends.days} days`}
      </ThemedText>
      <Section title="Volume">
        <ThemedText>{`${plural(trends.workout_days, "workout day")} · ${plural(trends.sets, "set")} logged`}</ThemedText>
        {trends.weeks.map((week) => (
          <View
            key={week.week_start}
            accessible
            accessibilityLabel={`Week of ${shortDate(week.week_start)}: ${plural(week.workout_days, "workout day")}, ${plural(week.sets, "set")}`}
            style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.md }}
          >
            <ThemedText color="muted">{`Week of ${shortDate(week.week_start)}`}</ThemedText>
            <ThemedText medium>{`${week.workout_days} d · ${week.sets} sets`}</ThemedText>
          </View>
        ))}
      </Section>
      {trends.exercises.length === 0 ? (
        <Card title="Exercises">
          <ThemedText>
            Only synced sessions in this range, so there are no sets to compare. Log sets in Workout
            to see each exercise's progress.
          </ThemedText>
        </Card>
      ) : null}
      {trends.exercises.map((exercise, position) => {
        const change = loadChange(exercise.points);
        const recent = exercise.points.slice(-RECENT_POINTS);
        return (
          <Section
            key={keys[position]}
            title={exercise.name}
            subtitle={plural(exercise.points.length, "session")}
          >
            <ThemedText color={change ? "text" : "muted"}>
              {change ??
                (exercise.points.length < 2
                  ? "One session in this range. Log it again to see a trend."
                  : "Bodyweight sessions: compare the reps below.")}
            </ThemedText>
            {recent.map((point) => (
              <View
                key={point.date}
                accessible
                accessibilityLabel={`${shortDate(point.date)}: ${pointText(point)}, ${plural(point.sets, "set")}`}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  gap: theme.spacing.md,
                }}
              >
                <ThemedText color="muted">{shortDate(point.date)}</ThemedText>
                <ThemedText medium style={{ flexShrink: 1, textAlign: "right" }}>
                  {pointText(point)}
                </ThemedText>
              </View>
            ))}
            {exercise.points.length > RECENT_POINTS ? (
              <ThemedText variant="label" color="muted">
                {`Showing the latest ${RECENT_POINTS} of ${exercise.points.length} sessions.`}
              </ThemedText>
            ) : null}
          </Section>
        );
      })}
    </>
  );
}
