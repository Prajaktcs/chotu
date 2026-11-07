import { View } from "react-native";

import { Button } from "@/components/button";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { useSectionNavigation } from "@/components/section-nav";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { shiftDate } from "@/food/format";
import { shortDate } from "@/plan/format";
import { useTheme } from "@/theme";

import { NoConditions, scoreText, useCheckins, useConditions } from "./shared";

/** Wellbeing › Overview: today's check-ins, the week's scores and the watchlists. */
export function WellbeingOverviewScreen() {
  const session = useProfileSession();
  return <ProfileOverview key={session.scope} />;
}

function ProfileOverview() {
  const theme = useTheme();
  const go = useSectionNavigation("health");
  const conditions = useConditions();
  const checkins = useCheckins();
  const authError = useAuthErrorRoute([conditions.error, checkins.error]);
  const error = conditions.error ?? checkins.error;
  const configured = conditions.data?.conditions ?? [];
  const week = checkins.data;
  const days = week ? Array.from({ length: 7 }, (_, i) => shiftDate(week.today, i - 6)) : [];
  const scoreOn = (conditionId: string, date: string) =>
    week?.checkins.find((c) => c.condition_id === conditionId && c.date === date)?.score;

  return (
    <TabScreen
      screen="health"
      onRefresh={() => Promise.all([conditions.refetch(), checkins.refetch()])}
    >
      {(!conditions.data && conditions.isPending) || (!week && checkins.isPending) ? (
        <Progress label="Loading your wellbeing" />
      ) : null}
      {error && !authError ? (
        <LoadFailed
          what="your wellbeing"
          noun="wellbeing"
          message={messageForLoad(error)}
          keptNote={conditions.data ? "Showing the last loaded data." : undefined}
          onRetry={() => void Promise.all([conditions.refetch(), checkins.refetch()])}
        />
      ) : null}
      {conditions.data && configured.length === 0 ? <NoConditions /> : null}
      {configured.length > 0 && week ? (
        <>
          <Section title="Today" subtitle="0 = calm, 5 = worst flare. Private to your profile.">
            {configured.map((condition) => (
              <View
                key={condition.id}
                accessible
                accessibilityLabel={`${condition.label} today: ${scoreText(scoreOn(condition.id, week.today))}`}
                style={{ flexDirection: "row", justifyContent: "space-between" }}
              >
                <ThemedText>{condition.label}</ThemedText>
                <ThemedText medium>{scoreText(scoreOn(condition.id, week.today))}</ThemedText>
              </View>
            ))}
            <Button
              label="Check in"
              accessibilityLabel="Open check-ins"
              onPress={() => go("health-checkins")}
            />
          </Section>
          <Section title="Last 7 days" subtitle="· is a day without a check-in.">
            {configured.map((condition) => {
              const scores = days.map((date) => scoreOn(condition.id, date));
              const spoken = days
                .map((date, i) => `${shortDate(date)} ${scoreText(scores[i])}`)
                .join(", ");
              return (
                <View
                  key={condition.id}
                  accessible
                  accessibilityLabel={`${condition.label}: ${spoken}`}
                  style={{ gap: theme.spacing.xs }}
                >
                  <ThemedText medium>{condition.label}</ThemedText>
                  <ThemedText color="muted">
                    {scores.map((score) => (score === undefined ? "·" : String(score))).join("  ")}
                  </ThemedText>
                </View>
              );
            })}
          </Section>
          <Section title="Watchlists" subtitle="Food tags flagged for each condition.">
            {configured.map((condition) => (
              <View key={condition.id} style={{ gap: theme.spacing.xs }}>
                <ThemedText medium>{condition.label}</ThemedText>
                <ThemedText color="muted">
                  {condition.watchlist.length > 0 ? condition.watchlist.join(", ") : "No tags yet."}
                </ThemedText>
              </View>
            ))}
            <Button
              label="Manage watchlists"
              accessibilityLabel="Open conditions"
              variant="secondary"
              onPress={() => go("health-conditions")}
            />
            <Button
              label="See trends"
              accessibilityLabel="Open wellbeing trends"
              variant="text"
              onPress={() => go("health-trends")}
            />
          </Section>
        </>
      ) : null}
    </TabScreen>
  );
}
