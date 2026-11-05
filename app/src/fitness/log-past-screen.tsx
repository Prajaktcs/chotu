import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import { ApiError, type WeightUnit } from "@/api";
import { Banner } from "@/components/banner";
import { Button } from "@/components/button";
import { Screen } from "@/components/screen";
import { Section } from "@/components/section";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import { messageForError, useAuthErrorRoute, useProfileSession } from "@/connection";
import { dayLabel, localDate, shiftDate } from "@/food/format";
import { useTheme } from "@/theme";
import { canonicalExercise } from "@/workout/model";
import { formatSet, formatWeight, MAX_REPS, MAX_WEIGHT, MIN_REPS } from "@/workout/units";

import { OLDEST_PAST_DAY, type PastSet, pastWorkoutDraft } from "./past-workout-draft";

/** A weight field: blank is bodyweight; else a number above 0 within the server's limit. */
function parseWeight(text: string, unit: WeightUnit): number | null | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_WEIGHT[unit]) return "invalid";
  return value;
}

function parseReps(text: string): number | "invalid" {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < MIN_REPS || value > MAX_REPS) return "invalid";
  return value;
}

const STATUS_NOTES: Partial<Record<PastSet["status"], string>> = {
  unconfirmed: "May already be saved. Save again to confirm; it is resent unchanged.",
};

/**
 * Fitness › History › Log a past workout: sets done on an earlier day (up to
 * six days back), sent straight to the server with that day's date. They join
 * that day's workout, or a closed one is created for it; today's workout is
 * never touched. The draft lives in PastWorkoutDraft, so a set that may be
 * saved keeps its request id even if this screen closes.
 */
export function LogPastWorkoutScreen() {
  const session = useProfileSession();
  return <ProfileLogPastWorkoutScreen key={session.scope} />;
}

function ProfileLogPastWorkoutScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { client, scope, weightUnit } = useProfileSession();
  const draft = pastWorkoutDraft(queryClient, scope, client);
  const { day, sets, saving, error } = useSyncExternalStore(
    draft.subscribe,
    draft.getSnapshot,
    draft.getSnapshot,
  );
  const [exercise, setExercise] = useState("");
  const [weight, setWeight] = useState("");
  const [reps, setReps] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // 401, 403 and 426 open their recovery screens once; the draft stays stored.
  const authError = useAuthErrorRoute([draft.routed(error) ? null : error]);
  useEffect(() => {
    if (authError) draft.markRouted(authError);
  }, [authError, draft]);

  const today = localDate();
  const oldest = shiftDate(today, -OLDEST_PAST_DAY);
  const yesterday = shiftDate(today, -1);
  const label = dayLabel(day, today);
  const dayLocked = draft.dayLocked;
  const toSend = sets.filter((set) => set.status === "unsent" || set.status === "unconfirmed");
  const maySave = sets.some((set) => set.status === "unconfirmed");

  // Opened from History; a deep link has nothing to go back to.
  const leave = () => (router.canGoBack() ? router.back() : router.replace("/fitness/history"));

  const add = () => {
    const name = exercise.trim();
    const parsedWeight = parseWeight(weight, weightUnit);
    const parsedReps = parseReps(reps);
    if (!name) return setFormError("Enter the exercise.");
    if (parsedWeight === "invalid") {
      return setFormError(
        `Enter a weight up to ${MAX_WEIGHT[weightUnit]} ${weightUnit}, or leave it blank for bodyweight.`,
      );
    }
    if (parsedReps === "invalid") return setFormError(`Enter ${MIN_REPS}–${MAX_REPS} reps.`);
    setFormError(null);
    draft.add({
      exercise: canonicalExercise([], name),
      weight: parsedWeight,
      unit: weightUnit,
      reps: parsedReps,
    });
    // The exercise, weight and reps stay filled: the next set is often the same.
  };

  const save = async () => {
    if (await draft.save()) leave();
  };

  const discard = () => {
    draft.discard();
    setConfirmDiscard(false);
    leave();
  };

  return (
    <Screen scroll>
      <ThemedText variant="overline" color="muted">
        Fitness · History
      </ThemedText>
      <ThemedText variant="headline" accessibilityRole="header">
        Log a past workout
      </ThemedText>
      <ThemedText color="muted">
        For a workout you didn't log on the day. Sets save to that day's history; today's workout
        isn't changed.
      </ThemedText>

      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
        <Button
          label="‹"
          accessibilityLabel="Earlier day"
          variant="secondary"
          disabled={saving || dayLocked || day <= oldest}
          onPress={() => draft.setDay(shiftDate(day, -1))}
        />
        <View style={{ flex: 1, alignItems: "center" }}>
          <ThemedText variant="title" accessibilityRole="header" accessibilityLiveRegion="polite">
            {label}
          </ThemedText>
        </View>
        <Button
          label="›"
          accessibilityLabel="Later day"
          variant="secondary"
          disabled={saving || dayLocked || day >= yesterday}
          onPress={() => draft.setDay(shiftDate(day, 1))}
        />
      </View>
      <ThemedText variant="label" color="muted">
        {dayLocked
          ? "The day is fixed once a set may be saved under it."
          : `Up to ${OLDEST_PAST_DAY} days back. Today's sets go in the Workout tab.`}
      </ThemedText>

      <Section title="Add a set">
        <TextField
          label="Exercise"
          value={exercise}
          onChangeText={(text) => {
            setExercise(text);
            setFormError(null);
          }}
          placeholder="e.g. Deadlift"
          testID="past-exercise"
        />
        <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
          <View style={{ flex: 1 }}>
            <TextField
              label={`Weight (${weightUnit})`}
              value={weight}
              onChangeText={(text) => {
                setWeight(text);
                setFormError(null);
              }}
              placeholder="Bodyweight"
              keyboardType="decimal-pad"
              testID="past-weight"
            />
          </View>
          <View style={{ flex: 1 }}>
            <TextField
              label="Reps"
              value={reps}
              onChangeText={(text) => {
                setReps(text);
                setFormError(null);
              }}
              keyboardType="number-pad"
              testID="past-reps"
            />
          </View>
        </View>
        {formError ? (
          <ThemedText variant="label" color="error" accessibilityLiveRegion="polite">
            {formError}
          </ThemedText>
        ) : null}
        <Button
          variant="secondary"
          label="Add set"
          accessibilityLabel="Add set"
          disabled={saving}
          onPress={add}
        />
      </Section>

      {sets.length > 0 ? (
        <Section title={`Sets for ${label}`}>
          {sets.map((entry) => {
            const text = `${entry.exercise} · ${formatSet(formatWeight(entry.weight, entry.unit), entry.reps)}`;
            return (
              <View key={entry.id} style={{ gap: theme.spacing.xs }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: theme.spacing.sm,
                  }}
                >
                  <ThemedText style={{ flex: 1 }}>{text}</ThemedText>
                  {entry.status === "saved" ? (
                    <ThemedText color="muted">Saved</ThemedText>
                  ) : entry.status === "unconfirmed" ? (
                    <ThemedText color="muted">Unconfirmed</ThemedText>
                  ) : (
                    <Button
                      variant="text"
                      label="Remove"
                      accessibilityLabel={`Remove ${text}`}
                      disabled={saving}
                      onPress={() => draft.remove(entry.id)}
                    />
                  )}
                </View>
                {entry.status === "failed" ? (
                  <ThemedText variant="label" color="error">
                    {`Not saved: ${entry.reason}. Remove it and add it again corrected.`}
                  </ThemedText>
                ) : null}
                {STATUS_NOTES[entry.status] ? (
                  <ThemedText variant="label" color="muted">
                    {STATUS_NOTES[entry.status]}
                  </ThemedText>
                ) : null}
              </View>
            );
          })}
        </Section>
      ) : null}

      {error && !authError ? (
        <Banner
          tone="error"
          title="Couldn't save every set"
          body={
            error instanceof ApiError && error.kind === "network"
              ? "Couldn't reach Chotu. The unsent sets are kept here; save again when connected."
              : `${messageForError(error)} The unsent sets are kept here.`
          }
        />
      ) : null}

      <View style={{ flex: 1 }} />
      <View style={{ gap: theme.spacing.sm }}>
        <Button
          label={
            saving ? "Saving…" : `Save ${toSend.length === 1 ? "1 set" : `${toSend.length} sets`}`
          }
          accessibilityLabel="Save sets"
          disabled={saving || toSend.length === 0}
          onPress={() => void save()}
        />
        {confirmDiscard ? (
          <Banner
            tone="error"
            title="Discard these sets?"
            body={
              maySave
                ? "Sets marked Unconfirmed may already be saved: check History before logging them again."
                : "Sets not saved yet are lost; saved ones stay in History."
            }
          />
        ) : null}
        {sets.length > 0 && !saving ? (
          <Button
            variant="danger"
            label={confirmDiscard ? "Discard" : "Discard sets"}
            accessibilityLabel={confirmDiscard ? "Confirm discard" : "Discard sets"}
            onPress={confirmDiscard ? discard : () => setConfirmDiscard(true)}
          />
        ) : null}
        <Button
          variant="text"
          label="Back to history"
          accessibilityLabel="Back to history"
          onPress={leave}
        />
      </View>
    </Screen>
  );
}
