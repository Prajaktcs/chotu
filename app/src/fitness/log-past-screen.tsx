import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
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
import { newRequestId } from "@/workout/ids";
import { canonicalExercise } from "@/workout/model";
import { invalidateTrainingHistory } from "@/workout/queries";
import { isRejection } from "@/workout/queue/set-queue";
import { toLocalRfc3339 } from "@/workout/time";
import { formatSet, formatWeight, MAX_REPS, MAX_WEIGHT, MIN_REPS } from "@/workout/units";

/**
 * The oldest day offered. The server refuses sets more than 7 days old, and a
 * set is stamped at noon, so 6 days back is always inside the limit.
 */
export const OLDEST_PAST_DAY = 6;

type Entry = {
  /** The set's `Idempotency-Key`, kept for every retry. */
  id: string;
  exercise: string;
  weight: number | null;
  unit: WeightUnit;
  reps: number;
  /** Order added; it becomes the second after noon, so history keeps the order. */
  seq: number;
  status: "unsent" | "saved" | "failed";
  reason?: string;
};

/**
 * Noon on `day` in the phone's offset, plus `seq` seconds. Noon keeps the
 * set on that calendar day in the household timezone too.
 */
export function pastSetTime(day: string, seq: number): string {
  const at = new Date(`${day}T12:00:00`);
  at.setSeconds(seq);
  return toLocalRfc3339(at);
}

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

/**
 * Fitness › History › Log a past workout: sets done on an earlier day (up to
 * six days back), sent straight to the server with that day's date. They join
 * that day's workout, or a closed one is created for it; today's workout is
 * never touched. Unlike the Workout tab nothing is queued offline: unsent sets
 * stay on this screen with their request ids, so Save again is safe.
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
  const today = localDate();
  const [day, setDay] = useState(() => shiftDate(today, -1));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextSeq, setNextSeq] = useState(0);
  const [exercise, setExercise] = useState("");
  const [weight, setWeight] = useState("");
  const [reps, setReps] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Once a save is tried, a set may be on the server: its day (and so its
  // request body) can't change any more.
  const [tried, setTried] = useState(false);
  const [sendError, setSendError] = useState<unknown>(null);
  const authError = useAuthErrorRoute([sendError]);

  const oldest = shiftDate(today, -OLDEST_PAST_DAY);
  const yesterday = shiftDate(today, -1);
  const label = dayLabel(day, today);
  const unsent = entries.filter((entry) => entry.status === "unsent");
  const savedCount = entries.filter((entry) => entry.status === "saved").length;

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
    setEntries((current) => [
      ...current,
      {
        id: newRequestId(),
        exercise: canonicalExercise([], name),
        weight: parsedWeight,
        unit: weightUnit,
        reps: parsedReps,
        seq: nextSeq,
        status: "unsent",
      },
    ]);
    setNextSeq((seq) => seq + 1);
    // The exercise, weight and reps stay filled: the next set is often the same.
  };

  // Opened from History; a deep link has nothing to go back to.
  const leave = () => (router.canGoBack() ? router.back() : router.replace("/fitness/history"));

  const remove = (id: string) =>
    setEntries((current) => current.filter((entry) => entry.id !== id));

  const mark = (id: string, change: Pick<Entry, "status" | "reason">) =>
    setEntries((current) =>
      current.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)),
    );

  const save = async () => {
    if (saving || unsent.length === 0) return;
    setSaving(true);
    setTried(true);
    setSendError(null);
    let stopped = false;
    // A refused set from an earlier try stays on screen until it is removed.
    let failed = entries.some((entry) => entry.status === "failed");
    // One at a time and in order: the first creates the day's workout, the rest join it.
    for (const entry of unsent) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential on purpose (see above)
        await client.logSet(
          {
            exercise: entry.exercise,
            weight: entry.weight,
            unit: entry.unit,
            reps: entry.reps,
            performed_at: pastSetTime(day, entry.seq),
          },
          entry.id,
        );
        mark(entry.id, { status: "saved" });
      } catch (error) {
        if (isRejection(error)) {
          // The server keeps this answer for the request id; only removing it helps.
          failed = true;
          mark(entry.id, { status: "failed", reason: messageForError(error) });
          continue;
        }
        setSendError(error);
        stopped = true;
        break;
      }
    }
    invalidateTrainingHistory(queryClient, scope);
    setSaving(false);
    if (!stopped && !failed) leave();
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
          disabled={tried || day <= oldest}
          onPress={() => setDay(shiftDate(day, -1))}
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
          disabled={tried || day >= yesterday}
          onPress={() => setDay(shiftDate(day, 1))}
        />
      </View>
      <ThemedText variant="label" color="muted">
        {tried
          ? "The day is fixed once a save has been tried."
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
        <Button variant="secondary" label="Add set" accessibilityLabel="Add set" onPress={add} />
      </Section>

      {entries.length > 0 ? (
        <Section title={`Sets for ${label}`}>
          {entries.map((entry) => {
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
                  ) : (
                    <Button
                      variant="text"
                      label="Remove"
                      accessibilityLabel={`Remove ${text}`}
                      disabled={saving}
                      onPress={() => remove(entry.id)}
                    />
                  )}
                </View>
                {entry.status === "failed" ? (
                  <ThemedText variant="label" color="error">
                    {`Not saved: ${entry.reason}. Remove it and add it again corrected.`}
                  </ThemedText>
                ) : null}
              </View>
            );
          })}
        </Section>
      ) : null}

      {sendError && !authError ? (
        <Banner
          tone="error"
          title="Couldn't save every set"
          body={
            sendError instanceof ApiError && sendError.kind === "network"
              ? "Couldn't reach Chotu. The unsent sets are kept here; save again when connected."
              : `${messageForError(sendError)} The unsent sets are kept here.`
          }
        />
      ) : null}

      <View style={{ flex: 1 }} />
      <View style={{ gap: theme.spacing.sm }}>
        <Button
          label={
            saving ? "Saving…" : `Save ${unsent.length === 1 ? "1 set" : `${unsent.length} sets`}`
          }
          accessibilityLabel="Save sets"
          disabled={saving || unsent.length === 0}
          onPress={() => void save()}
        />
        <Button
          variant="text"
          label={savedCount > 0 ? "Back to history" : "Cancel"}
          accessibilityLabel={savedCount > 0 ? "Back to history" : "Cancel"}
          disabled={saving}
          onPress={leave}
        />
      </View>
    </Screen>
  );
}
