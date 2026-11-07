import { useState } from "react";
import { Pressable, View } from "react-native";

import type { Checkin, HealthCondition } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { TabScreen } from "@/components/tab-screen";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { dayLabel, shiftDate } from "@/food/format";
import { useTheme } from "@/theme";

import type { WellbeingActions } from "./actions";
import {
  NoConditions,
  scoreText,
  useCheckins,
  useConditions,
  useWellbeingActions,
  WriteStatus,
} from "./shared";

/** How far back a check-in can be written, as the server allows. */
const DAYS_BACK = 7;
const SCORES = [0, 1, 2, 3, 4, 5] as const;

/** Wellbeing › Check-ins: a 0-5 score and note per condition, today or up to a week back. */
export function CheckinsScreen() {
  const session = useProfileSession();
  return <ProfileCheckins key={session.scope} />;
}

function ProfileCheckins() {
  const theme = useTheme();
  const conditions = useConditions();
  const checkins = useCheckins();
  const { actions, operation } = useWellbeingActions();
  const authError = useAuthErrorRoute([conditions.error, checkins.error, operation?.error]);
  const [back, setBack] = useState(0);
  const error = conditions.error ?? checkins.error;
  const today = checkins.data?.today;
  const date = today ? shiftDate(today, -back) : null;
  const label = today && date ? dayLabel(date, today) : "";
  const configured = conditions.data?.conditions ?? [];

  return (
    <TabScreen
      screen="health-checkins"
      onRefresh={() => Promise.all([conditions.refetch(), checkins.refetch()])}
    >
      {(!conditions.data && conditions.isPending) || (!checkins.data && checkins.isPending) ? (
        <Progress label="Loading check-ins" />
      ) : null}
      {error && !authError ? (
        <LoadFailed
          what="check-ins"
          noun="check-ins"
          message={messageForLoad(error)}
          keptNote={checkins.data ? "Showing the last loaded check-ins." : undefined}
          onRetry={() => void Promise.all([conditions.refetch(), checkins.refetch()])}
        />
      ) : null}
      {conditions.data && configured.length === 0 ? <NoConditions /> : null}
      {configured.length > 0 && checkins.data && date ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
            <Button
              label="‹"
              accessibilityLabel="Previous day"
              variant="secondary"
              disabled={back >= DAYS_BACK}
              onPress={() => setBack(back + 1)}
            />
            <View style={{ flex: 1, alignItems: "center" }}>
              <ThemedText
                variant="title"
                accessibilityRole="header"
                accessibilityLiveRegion="polite"
              >
                {label}
              </ThemedText>
            </View>
            <Button
              label="›"
              accessibilityLabel="Next day"
              variant="secondary"
              disabled={back === 0}
              onPress={() => setBack(back - 1)}
            />
          </View>
          <ThemedText variant="label" color="muted">
            {`0 = calm, 5 = worst flare. Today or up to ${DAYS_BACK} days back; a day you skip stays blank, not 0.`}
          </ThemedText>
          <WriteStatus operation={operation} showError={!authError} actions={actions} />
          {configured.map((condition) => (
            <ConditionCheckin
              // A fresh form per day and condition, filled from what's recorded.
              key={`${date}:${condition.id}`}
              condition={condition}
              date={date}
              recorded={checkins.data.checkins.find(
                (c) => c.condition_id === condition.id && c.date === date,
              )}
              busy={operation !== null}
              actions={actions}
            />
          ))}
        </>
      ) : null}
    </TabScreen>
  );
}

function ConditionCheckin({
  condition,
  date,
  recorded,
  busy,
  actions,
}: {
  condition: HealthCondition;
  date: string;
  recorded: Checkin | undefined;
  busy: boolean;
  actions: WellbeingActions;
}) {
  const theme = useTheme();
  const saved = { score: recorded?.score ?? null, note: recorded?.note ?? "" };
  const [base, setBase] = useState(saved);
  const [score, setScore] = useState<number | null>(saved.score);
  const [note, setNote] = useState(saved.note);
  // A new recorded value (saved, cleared, or changed in Signal) replaces the
  // form unless it has unsaved edits.
  if (base.score !== saved.score || base.note !== saved.note) {
    if (score === base.score && note === base.note) {
      setScore(saved.score);
      setNote(saved.note);
    }
    setBase(saved);
  }
  const unchanged = score === saved.score && note.trim() === saved.note;
  const write = { date, conditionId: condition.id, label: condition.label };
  return (
    <Card title={condition.label}>
      <ThemedText color="muted">{`Recorded: ${scoreText(recorded?.score)}`}</ThemedText>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={`${condition.label} score`}
        style={{ flexDirection: "row", gap: theme.spacing.xs }}
      >
        {SCORES.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityLabel={`${condition.label} ${value} of 5`}
            accessibilityState={{ checked: score === value, disabled: busy }}
            aria-checked={score === value}
            disabled={busy}
            onPress={() => setScore(value)}
            style={{
              flex: 1,
              minHeight: theme.minTapTarget,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: theme.radii.full,
              borderWidth: 1,
              borderColor: theme.colors.outline,
              backgroundColor: score === value ? theme.colors.container : "transparent",
            }}
          >
            <ThemedText medium>{String(value)}</ThemedText>
          </Pressable>
        ))}
      </View>
      <TextField
        label={`${condition.label} note (optional)`}
        value={note}
        onChangeText={setNote}
        placeholder="Itchy after dinner"
      />
      <Button
        label="Save check-in"
        accessibilityLabel={`Save ${condition.label} check-in`}
        disabled={busy || score === null || unchanged}
        onPress={() => {
          if (score === null) return;
          const trimmed = note.trim();
          void actions.start({
            kind: "checkin",
            ...write,
            score,
            ...(trimmed ? { note: trimmed } : {}),
          });
        }}
      />
      {recorded ? (
        <Button
          label="Clear check-in"
          accessibilityLabel={`Clear ${condition.label} check-in`}
          variant="text"
          disabled={busy}
          onPress={() => void actions.start({ kind: "clear", ...write })}
        />
      ) : null}
    </Card>
  );
}
