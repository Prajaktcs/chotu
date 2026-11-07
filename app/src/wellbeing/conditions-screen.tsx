import { Pressable, View } from "react-native";

import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { useTheme } from "@/theme";

import { NoConditions, useConditions, useWellbeingActions, WriteStatus } from "./shared";

/**
 * Wellbeing › Conditions: the profile's configured conditions and their food
 * watchlists. Conditions come from config.yaml; only watchlist tags change here,
 * the same rows as Signal's /watch.
 */
export function ConditionsScreen() {
  const session = useProfileSession();
  return <ProfileConditions key={session.scope} />;
}

function ProfileConditions() {
  const theme = useTheme();
  const query = useConditions();
  const { actions, operation } = useWellbeingActions();
  const authError = useAuthErrorRoute([query.error, operation?.error]);
  const data = query.data;
  const busy = operation !== null;
  return (
    <TabScreen screen="health-conditions" onRefresh={() => query.refetch()}>
      {!data && query.isPending ? <Progress label="Loading your conditions" /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="your conditions"
          noun="conditions"
          message={messageForLoad(query.error)}
          keptNote={data ? "Showing the last loaded conditions." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {data && data.conditions.length === 0 ? <NoConditions /> : null}
      {data && data.conditions.length > 0 ? (
        <>
          <ThemedText color="muted">
            Conditions are set in the household's config.yaml (health_conditions). Choose the food
            tags to watch for each; a meal with one is flagged, and Trends compares days with and
            without it.
          </ThemedText>
          <WriteStatus operation={operation} showError={!authError} actions={actions} />
          {data.conditions.map((condition) => (
            <Card key={condition.id} title={condition.label}>
              <ThemedText color="muted">
                {`${condition.check_in ? "Asked in the evening check-in" : "Not asked in the evening check-in"} · food from ${condition.lag_window[0]}–${condition.lag_window[1]} days before a score counts`}
              </ThemedText>
              {condition.notes ? <ThemedText>{condition.notes}</ThemedText> : null}
              <ThemedText variant="label" medium>
                Watchlist
              </ThemedText>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs }}>
                {data.tags.map((tag) => {
                  const watched = condition.watchlist.includes(tag.tag);
                  return (
                    <Pressable
                      key={tag.tag}
                      accessibilityRole="checkbox"
                      accessibilityLabel={`Watch ${tag.label} for ${condition.label}`}
                      accessibilityHint={tag.description}
                      accessibilityState={{ checked: watched, disabled: busy }}
                      aria-checked={watched}
                      disabled={busy}
                      onPress={() =>
                        void actions.start({
                          kind: "watch",
                          conditionId: condition.id,
                          label: condition.label,
                          tag: tag.tag,
                          watched: !watched,
                        })
                      }
                      style={{
                        minHeight: theme.minTapTarget,
                        justifyContent: "center",
                        paddingHorizontal: theme.spacing.md,
                        borderRadius: theme.radii.full,
                        borderWidth: 1,
                        borderColor: theme.colors.outline,
                        backgroundColor: watched ? theme.colors.container : "transparent",
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      <ThemedText variant="label" medium={watched}>
                        {watched ? `✓ ${tag.label}` : tag.label}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </Card>
          ))}
        </>
      ) : null}
    </TabScreen>
  );
}
