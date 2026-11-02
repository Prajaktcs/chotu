import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { TaskTrendsResponse } from "@/api";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { useKeptData } from "@/components/use-kept-data";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { plural, rangeText, TREND_RANGES, type TrendRange } from "@/fitness/format";
import { shortDate } from "@/plan/format";
import { useTheme } from "@/theme";

import { taskTrendsQueryKey } from "./actions";

/** Tasks › Trends: tasks created and completed per week, from recorded tasks. */
export function TaskTrendsScreen() {
  const session = useProfileSession();
  return <ProfileTaskTrends key={session.scope} />;
}

function ProfileTaskTrends() {
  const theme = useTheme();
  const { client, scope } = useProfileSession();
  const [days, setDays] = useState<TrendRange>(28);
  const query = useQuery({
    queryKey: [...taskTrendsQueryKey(scope), days],
    queryFn: () => client.taskTrends(days),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  const trends = useKeptData(query.data);
  return (
    <TabScreen screen="tasks-trends" onRefresh={() => query.refetch()}>
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
      {!trends && query.isPending ? <Progress label="Loading task trends" /> : null}
      {query.isPlaceholderData ? <Progress label={`Loading the last ${days} days`} /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="task trends"
          noun="task trends"
          message={messageForLoad(query.error)}
          keptNote={trends ? "Showing the last loaded trends." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {trends ? <TrendsBody trends={trends} /> : null}
    </TabScreen>
  );
}

function TrendsBody({ trends }: { trends: TaskTrendsResponse }) {
  const theme = useTheme();
  return (
    <>
      <ThemedText variant="overline" color="muted">
        {`${rangeText(trends)} · last ${trends.days} days`}
      </ThemedText>
      <Section title="Now">
        <ThemedText>{`${plural(trends.open, "open task")} · ${trends.overdue} overdue`}</ThemedText>
      </Section>
      {trends.created === 0 && trends.completed === 0 ? (
        <Card title="Activity">
          <ThemedText variant="title" accessibilityRole="header">
            {`No tasks added or completed in the last ${trends.days} days`}
          </ThemedText>
          <ThemedText color="muted">Try a longer range.</ThemedText>
        </Card>
      ) : (
        <Section title="Activity">
          <ThemedText>{`${trends.created} added · ${trends.completed} completed`}</ThemedText>
          {trends.weeks.map((week) => (
            <View
              key={week.week_start}
              accessible
              accessibilityLabel={`Week of ${shortDate(week.week_start)}: ${week.created} added, ${week.completed} completed`}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                gap: theme.spacing.md,
              }}
            >
              <ThemedText color="muted">{`Week of ${shortDate(week.week_start)}`}</ThemedText>
              <ThemedText medium>{`${week.created} added · ${week.completed} done`}</ThemedText>
            </View>
          ))}
          <ThemedText variant="label" color="muted">
            Completion time is when a task was last marked done. Includes unassigned household
            tasks.
          </ThemedText>
        </Section>
      )}
    </>
  );
}
