import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, View } from "react-native";

import type { HealthTrendsResponse } from "@/api";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { useKeptData } from "@/components/use-kept-data";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { rangeText, TREND_RANGES, type TrendRange } from "@/fitness/format";
import { shortDate } from "@/plan/format";
import { useTheme } from "@/theme";

import { healthTrendsKey } from "./actions";

type ConditionTrend = HealthTrendsResponse["conditions"][number];

/** Wellbeing › Trends: Signal's descriptive condition timelines, never causal. */
export function WellbeingTrendsScreen() {
  const session = useProfileSession();
  return <ProfileTrends key={session.scope} />;
}

function ProfileTrends() {
  const theme = useTheme();
  const { client, scope } = useProfileSession();
  const [days, setDays] = useState<TrendRange>(28);
  const query = useQuery({
    queryKey: [...healthTrendsKey(scope), days],
    queryFn: () => client.healthTrends(days),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  const trends = useKeptData(query.data);
  return (
    <TabScreen screen="health-trends" onRefresh={() => query.refetch()}>
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
      {!trends && query.isPending ? <Progress label="Loading wellbeing trends" /> : null}
      {query.isPlaceholderData ? <Progress label={`Loading the last ${days} days`} /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="wellbeing trends"
          noun="wellbeing trends"
          message={messageForLoad(query.error)}
          keptNote={trends ? "Showing the last loaded trends." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {trends && trends.conditions.length === 0 ? (
        <Card title="Trends">
          <ThemedText color="muted">
            No conditions are set up for your profile, so there is nothing to chart.
          </ThemedText>
        </Card>
      ) : null}
      {trends?.conditions.map((condition) => (
        <ConditionTrendCard key={condition.id} trends={trends} condition={condition} />
      ))}
      {trends && trends.conditions.length > 0 ? (
        <ThemedText variant="label" color="muted">
          Descriptive only, from your own logs: missing check-ins, sleep and meals are left out,
          never counted as zero. Nothing here shows cause.
        </ThemedText>
      ) : null}
    </TabScreen>
  );
}

/** Signal's /trends wording for one comparison. */
export function comparisonText(comparison: ConditionTrend["comparisons"][number]): string {
  const direction = comparison.difference >= 0 ? "higher" : "lower";
  return `Tentative: scores averaged ${Math.abs(comparison.difference).toFixed(1)} points ${direction} with ${comparison.tag} logged in the lag window vs no matching tag logged (${comparison.pairs} days per group, sleep within 0.5h). Logs may be incomplete; this does not show cause.`;
}

function ConditionTrendCard({
  trends,
  condition,
}: {
  trends: HealthTrendsResponse;
  condition: ConditionTrend;
}) {
  const { thresholds } = trends;
  const scored = condition.days.filter((day) => day.score !== null);
  const title = `${condition.label} · ${rangeText(trends)}`;
  if (scored.length === 0) {
    return (
      <Card title={title}>
        <ThemedText color="muted">{`No check-ins in the last ${trends.days} days.`}</ThemedText>
      </Card>
    );
  }
  if (condition.checkins < thresholds.timeline_checkins) {
    const latest = scored.at(-1)!;
    return (
      <Card title={title}>
        <ThemedText>{`Latest: ${latest.score}/5 on ${shortDate(latest.date)}.`}</ThemedText>
        <ThemedText color="muted">
          {`${condition.checkins} of ${thresholds.timeline_checkins} check-ins needed for a timeline.`}
        </ThemedText>
      </Card>
    );
  }
  const strip = condition.days.map((day) => (day.score === null ? "·" : String(day.score)));
  const sleep = scored.flatMap((day) => (day.sleep_hours === null ? [] : [day.sleep_hours]));
  const matches = condition.watchlist
    .map((tag) => ({
      tag,
      dates: scored.filter((day) => day.watch_hits.includes(tag)).map((day) => day.date),
    }))
    .filter((match) => match.dates.length > 0);
  return (
    <Card title={title}>
      <ThemedText color="muted">{`${condition.checkins} check-ins · 0 = calm, 5 = flare, · = skipped`}</ThemedText>
      <ThemedText
        accessibilityLabel={`Scores: ${condition.days
          .map((day) => `${shortDate(day.date)} ${day.score === null ? "skipped" : day.score}`)
          .join(", ")}`}
      >
        {strip.join(" ")}
      </ThemedText>
      <ThemedText variant="label" medium>
        {`Watchlist matches ${condition.lag_window[0]}–${condition.lag_window[1]} days before each score`}
      </ThemedText>
      {condition.watchlist.length === 0 ? (
        <ThemedText color="muted">No watchlist tags yet. Add them in Conditions.</ThemedText>
      ) : matches.length === 0 ? (
        <ThemedText color="muted">
          No matching tags logged in these lag windows; missing food logs remain unknown.
        </ThemedText>
      ) : (
        matches.map((match) => (
          <ThemedText key={match.tag}>
            {`${match.tag}: ${match.dates.map(shortDate).join(", ")}`}
          </ThemedText>
        ))
      )}
      <ThemedText color="muted">
        {sleep.length === 0
          ? "Sleep on scored days: not recorded."
          : `Sleep on scored days: ${(sleep.reduce((a, b) => a + b, 0) / sleep.length).toFixed(1)}h average (${sleep.length} of ${scored.length} days).`}
      </ThemedText>
      {condition.comparisons.length > 0 ? (
        condition.comparisons.map((comparison) => (
          <ThemedText key={comparison.tag}>{comparisonText(comparison)}</ThemedText>
        ))
      ) : condition.watchlist.length > 0 ? (
        <ThemedText color="muted">
          {`No association estimate: each group needs ${thresholds.comparison_pairs} scored days with food logs across the lag window and comparable recorded sleep.`}
        </ThemedText>
      ) : null}
    </Card>
  );
}
