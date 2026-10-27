import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import type { PlanResponse, Target, WeekPlan, WeekPlanDay, WeekPlanExercise } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { uniqueKeys } from "@/components/unique-keys";
import { ThemedText } from "@/components/themed-text";
import { messageForError, useAuthErrorRoute, useProfileSession } from "@/connection";
import { useTheme } from "@/theme";
import { ExerciseDemoButton } from "@/workout/exercise-media";
import { useWorkoutSession } from "@/workout/session";

import { ambiguousPlanError, planGeneration } from "./actions";
import {
  kindLabel,
  planQueryKey,
  prescription,
  progressLines,
  shortDate,
  targetText,
} from "./format";

/** This week's plan and read-only progress, with explicit plan replacement. */
export function PlanScreen() {
  const session = useProfileSession();
  return <ProfilePlanScreen key={session.scope} />;
}

function ProfilePlanScreen() {
  const { client, scope } = useProfileSession();
  const queryClient = useQueryClient();
  const actions = planGeneration(queryClient, scope, client);
  const operation = useSyncExternalStore(
    actions.subscribe,
    actions.getSnapshot,
    actions.getSnapshot,
  );
  const [confirming, setConfirming] = useState(false);
  const query = useQuery({
    queryKey: planQueryKey(scope),
    queryFn: () => client.plan(),
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error, operation?.error]);
  const data = query.data;

  return (
    <TabScreen title="Plan" tab="plan" onRefresh={() => query.refetch()}>
      {!data && query.isPending ? <Progress label="Loading this week's plan" /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="this week's plan"
          noun="plan"
          message={messageForError(query.error)}
          keptNote={data ? "Showing the last loaded plan." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {data ? <PlanBody data={data} /> : null}
      {operation?.pending ? (
        <Progress label={operation.regenerate ? "Regenerating plan…" : "Generating plan…"} />
      ) : null}
      {!!operation?.error && !authError ? (
        <Card title="Couldn't generate a plan">
          <ThemedText color="muted">{messageForError(operation.error)}</ThemedText>
          <Button
            label="Retry generating plan"
            accessibilityLabel="Retry generating plan"
            onPress={() => void actions.retry()}
          />
          {!ambiguousPlanError(operation.error) ? (
            <Button
              label="Dismiss"
              accessibilityLabel="Dismiss generation error"
              variant="text"
              onPress={() => actions.dismiss()}
            />
          ) : null}
        </Card>
      ) : null}
      {data && data.reason !== "no_fitness_goals" ? (
        confirming ? (
          <Card title="Replace this week's plan?">
            <ThemedText>Your logged workouts will be kept.</ThemedText>
            <Button
              label="Replace plan"
              accessibilityLabel="Replace plan"
              disabled={!!operation}
              onPress={() => {
                setConfirming(false);
                void actions.start(true);
              }}
            />
            <Button
              label="Keep current plan"
              accessibilityLabel="Keep current plan"
              variant="text"
              disabled={!!operation?.pending}
              onPress={() => setConfirming(false)}
            />
          </Card>
        ) : (
          <Button
            label={data.plan || data.reason === "unreadable" ? "Regenerate plan" : "Generate plan"}
            accessibilityLabel={
              data.plan || data.reason === "unreadable" ? "Regenerate plan" : "Generate plan"
            }
            disabled={!!operation}
            onPress={() => {
              if (data.plan || data.reason === "unreadable") setConfirming(true);
              else void actions.start(false);
            }}
          />
        )
      ) : null}
    </TabScreen>
  );
}

function PlanBody({ data }: { data: PlanResponse }) {
  const { profile } = useProfileSession();
  const overline = (
    <ThemedText variant="overline" color="muted">
      {`Week of ${shortDate(data.week_start)}`}
    </ThemedText>
  );
  if (!data.plan) {
    const missing = missingPlan(data.reason, profile.name);
    return (
      <>
        {overline}
        <Card title="Plan">
          <ThemedText variant="title" accessibilityRole="header">
            {missing.title}
          </ThemedText>
          <ThemedText color="muted">{missing.body}</ThemedText>
        </Card>
      </>
    );
  }
  return (
    <>
      {overline}
      {data.plan.theme.trim() ? (
        <ThemedText variant="headline" accessibilityRole="header">
          {data.plan.theme.trim()}
        </ThemedText>
      ) : null}
      {data.plan.progress ? (
        <Section title="This week so far">
          {progressLines(data.plan.progress).map((line) => (
            <ThemedText key={line}>{line}</ThemedText>
          ))}
        </Section>
      ) : null}
      {data.plan.days.map((day) => (
        <DaySection key={day.date} day={day} plan={data.plan} />
      ))}
    </>
  );
}

/** Why there is no plan to show, and what to do about it. */
function missingPlan(
  reason: PlanResponse["reason"],
  name: string,
): { title: string; body: string } {
  switch (reason) {
    case "no_fitness_goals":
      return {
        title: "No fitness goals yet",
        body: `Add fitness_goals for ${name} in config.yaml before generating a plan.`,
      };
    case "unreadable":
      return {
        title: "This week's plan can't be shown",
        body: "Chotu couldn't read the saved plan. You can explicitly replace it with a new plan.",
      };
    default:
      return {
        title: "No plan this week yet",
        body: "Generate this week's plan using your saved fitness goals.",
      };
  }
}

function DaySection({ day, plan }: { day: WeekPlanDay; plan: WeekPlan | null }) {
  const theme = useTheme();
  // Today's exercises carry their next targets, as on the workout screen.
  const today = day.is_today ? plan?.today : null;
  const exercises: (WeekPlanExercise & { target?: Target | null })[] =
    today?.exercises ?? day.exercises;
  const keys = uniqueKeys(exercises.map((exercise) => exercise.name));
  const title = `${day.weekday} · ${kindLabel(day.kind)}${day.is_today ? " · Today" : ""}`;
  return (
    <Section
      title={title}
      subtitle={[shortDate(day.date), day.notes.trim()].filter(Boolean).join(" · ")}
      testID={`plan-day-${day.date}`}
    >
      {exercises.length === 0 ? (
        <ThemedText color="muted">
          {day.kind === "rest" ? "Rest day" : "No exercises listed"}
        </ThemedText>
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {exercises.map((exercise, index) => (
            <ExerciseLink
              key={keys[index]}
              exercise={exercise}
              target={exercise.target ?? null}
              today={day.is_today}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

/** One planned exercise; opens the workout screen with it chosen. */
function ExerciseLink({
  exercise,
  target,
  today,
}: {
  exercise: WeekPlanExercise;
  target: Target | null;
  today: boolean;
}) {
  const theme = useTheme();
  const router = useRouter();
  const session = useWorkoutSession();
  const { weightUnit } = useProfileSession();
  const sets = prescription(exercise);
  const next = targetText(target, weightUnit);
  const details = [sets, next ? `Next: ${next}` : null].filter(Boolean).join(". ");
  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${exercise.name}${details ? `. ${details}` : ""}`}
        accessibilityHint={
          today ? "Opens the workout screen to log it" : "Opens the workout screen to log it today"
        }
        onPress={() => {
          session.selectExercise(exercise.name);
          router.replace("/workout");
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
        {sets ? <ThemedText color="muted">{sets}</ThemedText> : null}
        {next ? <ThemedText>{`Next: ${next}`}</ThemedText> : null}
      </Pressable>
      <ExerciseDemoButton media={exercise.media} name={exercise.name} />
    </View>
  );
}
