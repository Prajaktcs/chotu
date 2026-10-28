import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";

import type { GoalProgress, StatusResponse } from "@/api";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { uniqueKeys } from "@/components/unique-keys";
import { ThemedText } from "@/components/themed-text";
import { messageForError, useAuthErrorRoute, useProfileSession } from "@/connection";
import { useTheme } from "@/theme";

import {
  countdown,
  dayOverline,
  goalAmount,
  hasActivity,
  nutrientAmount,
  statusQueryKey,
} from "./format";

/** Today's activity, exercise, goals and nutrition: the numbers Signal's /status shows. */
export function StatusScreen() {
  const { client, scope } = useProfileSession();
  const query = useQuery({
    queryKey: statusQueryKey(scope),
    queryFn: () => client.status(),
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  const status = query.data;

  return (
    <TabScreen title="Status" tab="status" onRefresh={() => query.refetch()}>
      {!status && query.isPending ? <Progress label="Loading today's status" /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="today's status"
          noun="status"
          message={messageForError(query.error)}
          keptNote={status ? "Showing the last loaded status." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {status ? <StatusBody status={status} /> : null}
    </TabScreen>
  );
}

function StatusBody({ status }: { status: StatusResponse }) {
  const theme = useTheme();
  const { activity, fitness } = status;
  const nothingLogged = !hasActivity(status) && status.nutrition.length === 0;
  const fitnessCountdown = fitness ? countdown(fitness) : null;
  return (
    <>
      <ThemedText variant="overline" color="muted">
        {`${dayOverline(status.date)} · ${status.member.name}`}
      </ThemedText>
      {nothingLogged ? (
        <Card title="Today">
          <ThemedText variant="title" accessibilityRole="header">
            Nothing logged yet today
          </ThemedText>
          <ThemedText color="muted">
            Log food in the Food tab or in Signal with /food. Steps, sleep and exercise arrive with
            the health sync. Pull down to refresh.
          </ThemedText>
        </Card>
      ) : null}

      <Section title="Activity">
        <Row label="Steps" value={String(activity.steps)} />
        <Row label="Active energy" value={`${activity.active_calories} kcal`} />
        <Row
          label="Sleep"
          value={
            activity.sleep_hours === null ? "Not synced" : `${activity.sleep_hours.toFixed(1)} h`
          }
        />
        <Row
          label="Energy"
          value={activity.energy === null ? "Not reported" : `${activity.energy}/10`}
        />
      </Section>

      {status.exercises.length > 0 ? (
        <Section title={`Exercise · ${status.exercises.length}`}>
          {uniqueKeys(status.exercises).map((key, index) => (
            <ThemedText key={key}>{status.exercises[index]}</ThemedText>
          ))}
        </Section>
      ) : null}

      {status.goals.length > 0 ? (
        <Section title="Goals">
          {status.goals.map((goal) => (
            <GoalRow key={goal.key} goal={goal} />
          ))}
        </Section>
      ) : null}

      {status.nutrition.length > 0 ? (
        <Section title="Nutrition">
          {status.nutrition.map((nutrient) => (
            <Row
              key={nutrient.key}
              label={nutrient.label}
              value={nutrientAmount(nutrient)}
              indent={nutrient.sub}
              accessibilityPrefix={nutrient.sub ? "Of fat, " : ""}
            />
          ))}
        </Section>
      ) : null}

      {fitness ? (
        <Section title="Fitness goal">
          {fitness.intent ? <Row label="Outcome" value={fitness.intent} /> : null}
          {fitnessCountdown ? <ThemedText>{fitnessCountdown}</ThemedText> : null}
          {fitness.focus ? <Row label="Focus" value={fitness.focus} /> : null}
        </Section>
      ) : null}

      <ThemedText variant="label" color="muted" style={{ marginTop: theme.spacing.sm }}>
        {"The coach's tip and the household spending summary stay in Signal's /status."}
      </ThemedText>
    </>
  );
}

/** A label and its value, read as one phrase by screen readers. */
function Row({
  label,
  value,
  indent = false,
  accessibilityPrefix = "",
}: {
  label: string;
  value: string;
  indent?: boolean;
  accessibilityPrefix?: string;
}) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${accessibilityPrefix}${label}: ${value}`}
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        gap: theme.spacing.md,
        paddingLeft: indent ? theme.spacing.xl : 0,
      }}
    >
      <ThemedText color={indent ? "muted" : "text"} style={{ flexShrink: 1 }}>
        {label}
      </ThemedText>
      <ThemedText medium>{value}</ThemedText>
    </View>
  );
}

/** A goal as text (`1840 / 2200 kcal · 84%`) with a bar that only reinforces it. */
function GoalRow({ goal }: { goal: GoalProgress }) {
  const theme = useTheme();
  const filled = Math.max(0, Math.min(100, goal.percent));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${goal.label}: ${goalAmount(goal)}, ${goal.percent}%`}
      accessibilityValue={{ min: 0, max: 100, now: filled }}
      style={{ gap: theme.spacing.xs }}
    >
      <View
        style={{ flexDirection: "row", justifyContent: "space-between", gap: theme.spacing.md }}
      >
        <ThemedText style={{ flexShrink: 1 }}>{goal.label}</ThemedText>
        <ThemedText medium>{`${goalAmount(goal)} · ${goal.percent}%`}</ThemedText>
      </View>
      <View
        style={{
          height: theme.spacing.sm,
          borderRadius: theme.radii.full,
          backgroundColor: theme.colors.container,
          overflow: "hidden",
        }}
      >
        <View
          style={{ width: `${filled}%`, height: "100%", backgroundColor: theme.colors.primary }}
        />
      </View>
    </View>
  );
}
