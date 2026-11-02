import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { FoodTrendsResponse } from "@/api";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { useKeptData } from "@/components/use-kept-data";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { rangeText, TREND_RANGES, type TrendRange } from "@/fitness/format";
import { shortDate } from "@/plan/format";
import { useTheme } from "@/theme";

import { averages } from "./format";

/** The latest days listed under the averages. */
const RECENT_DAYS = 14;

/** Nutrition › Trends: daily summaries for a range, averaged over days that have one. */
export function FoodTrendsScreen() {
  const session = useProfileSession();
  return <ProfileFoodTrends key={session.scope} />;
}

function ProfileFoodTrends() {
  const theme = useTheme();
  const { client, scope } = useProfileSession();
  const [days, setDays] = useState<TrendRange>(28);
  const query = useQuery({
    queryKey: ["food-trends", scope, days],
    queryFn: () => client.foodTrends(days),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  const trends = useKeptData(query.data);
  return (
    <TabScreen screen="food-trends" onRefresh={() => query.refetch()}>
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
      {!trends && query.isPending ? <Progress label="Loading nutrition trends" /> : null}
      {query.isPlaceholderData ? <Progress label={`Loading the last ${days} days`} /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="nutrition trends"
          noun="nutrition trends"
          message={messageForLoad(query.error)}
          keptNote={trends ? "Showing the last loaded trends." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {trends ? <TrendsBody trends={trends} /> : null}
    </TabScreen>
  );
}

function TrendsBody({ trends }: { trends: FoodTrendsResponse }) {
  const theme = useTheme();
  const logged = trends.summaries.length;
  if (logged === 0) {
    return (
      <Card title={rangeText(trends)}>
        <ThemedText variant="title" accessibilityRole="header">
          {`No nutrition summaries in the last ${trends.days} days`}
        </ThemedText>
        <ThemedText color="muted">
          Summaries come from meals logged here or with /food, and the Google Health sync.
        </ThemedText>
      </Card>
    );
  }
  const average = averages(trends.summaries);
  const rows: { label: string; value: number; goal: number | null; unit: string }[] = [
    { label: "Calories", value: average.calories, goal: trends.goals.calories, unit: "kcal" },
    { label: "Protein", value: average.protein_g, goal: trends.goals.protein_g, unit: "g" },
    { label: "Carbs", value: average.carbs_g, goal: trends.goals.carbs_g, unit: "g" },
    { label: "Fat", value: average.fat_g, goal: trends.goals.fat_g, unit: "g" },
    { label: "Fiber", value: average.fiber_g, goal: trends.goals.fiber_g, unit: "g" },
  ];
  return (
    <>
      <ThemedText variant="overline" color="muted">
        {`${rangeText(trends)} · ${logged} of ${trends.days} days with a summary`}
      </ThemedText>
      <Section
        title="Daily average"
        subtitle="Over days with a summary; missing days are left out."
      >
        {rows.map((row) => {
          const value = `${Math.round(row.value)} ${row.unit}`;
          const goal = row.goal === null ? "" : ` of ${Math.round(row.goal)} ${row.unit} goal`;
          return (
            <View
              key={row.label}
              accessible
              accessibilityLabel={`${row.label}: ${value}${goal}`}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                gap: theme.spacing.md,
              }}
            >
              <ThemedText>{row.label}</ThemedText>
              <ThemedText
                medium
              >{`${value}${goal ? ` / ${Math.round(row.goal!)}` : ""}`}</ThemedText>
            </View>
          );
        })}
      </Section>
      <Section title="By day">
        {trends.summaries
          .slice(-RECENT_DAYS)
          .reverse()
          .map((day) => (
            <View
              key={day.date}
              accessible
              accessibilityLabel={`${shortDate(day.date)}: ${day.calories} kcal, ${Math.round(day.protein_g)} grams protein`}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                gap: theme.spacing.md,
              }}
            >
              <ThemedText color="muted">{shortDate(day.date)}</ThemedText>
              <ThemedText
                medium
              >{`${day.calories} kcal · ${Math.round(day.protein_g)}g P`}</ThemedText>
            </View>
          ))}
        {logged > RECENT_DAYS ? (
          <ThemedText variant="label" color="muted">
            {`Showing the latest ${RECENT_DAYS} of ${logged} days.`}
          </ThemedText>
        ) : null}
      </Section>
    </>
  );
}
