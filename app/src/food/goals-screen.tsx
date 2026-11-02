import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { statusQueryKey } from "@/status/format";
import { GoalRow } from "@/status/status-body";

/**
 * Nutrition › Goals: the profile's configured targets and today's progress.
 * Goals live in the household's `config.yaml`; there is no app editor, so
 * nothing here looks editable.
 */
export function GoalsScreen() {
  const session = useProfileSession();
  return <ProfileGoalsScreen key={session.scope} />;
}

function ProfileGoalsScreen() {
  const { client, scope } = useProfileSession();
  const query = useQuery({
    queryKey: statusQueryKey(scope),
    queryFn: () => client.status(),
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  // Steps is an activity goal; it stays on Today with the activity numbers.
  const goals = query.data?.goals.filter((goal) => goal.key !== "steps") ?? [];
  return (
    <TabScreen screen="food-goals" onRefresh={() => query.refetch()}>
      {!query.data && query.isPending ? <Progress label="Loading your goals" /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="your goals"
          noun="goals"
          message={messageForLoad(query.error)}
          keptNote={query.data ? "Showing the last loaded goals." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && goals.length === 0 ? (
        <Card title="Goals">
          <ThemedText variant="title" accessibilityRole="header">
            No goals set
          </ThemedText>
          <ThemedText color="muted">
            Daily targets come from nutrition_goals for your profile in the household's config.yaml.
            Ask whoever runs Chotu to add them.
          </ThemedText>
        </Card>
      ) : null}
      {goals.length > 0 ? (
        <Section title="Today against your goals">
          {goals.map((goal) => (
            <GoalRow key={goal.key} goal={goal} />
          ))}
        </Section>
      ) : null}
      {goals.length > 0 ? (
        <ThemedText color="muted">
          These targets are set in the household's config.yaml (nutrition_goals) and are the same
          ones Signal's /status and /trends use. Changing them isn't available in the app.
        </ThemedText>
      ) : null}
    </TabScreen>
  );
}
