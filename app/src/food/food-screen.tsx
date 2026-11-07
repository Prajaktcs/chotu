import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useState, useSyncExternalStore } from "react";
import { Modal, Pressable, View } from "react-native";

import type { Meal, MealPhoto } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Screen } from "@/components/screen";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import {
  messageForError,
  messageForLoad,
  useAuthErrorRoute,
  useProfileSession,
} from "@/connection";
import { GoalRow } from "@/status/status-body";
import { nutrientAmount, statusQueryKey } from "@/status/format";
import { useTheme } from "@/theme";

import {
  ambiguousFoodError,
  type FoodOperation,
  type FoodWrite,
  foodActions,
  settled,
} from "./actions";
import {
  dayLabel,
  dayTotals,
  foodQueryKey,
  localDate,
  macroLine,
  mealTime,
  shiftDate,
  TODAY,
} from "./format";
import { type PhotoSource, type PickedPhoto, pickMealPhoto } from "./photo";

/** Nutrition › Today: the household's today, its totals against goals, and day tools. */
export function FoodScreen() {
  const session = useProfileSession();
  return <ProfileFoodScreen key={session.scope} mode="today" />;
}

/** Nutrition › Food log: any earlier day's meals, with add, edit and delete. */
export function FoodLogScreen() {
  const session = useProfileSession();
  return <ProfileFoodScreen key={session.scope} mode="log" />;
}

function ProfileFoodScreen({ mode }: { mode: "today" | "log" }) {
  const theme = useTheme();
  const { client, scope } = useProfileSession();
  const queryClient = useQueryClient();
  const actions = foodActions(queryClient, scope, client);
  const operation = useSyncExternalStore(
    actions.subscribe,
    actions.getSnapshot,
    actions.getSnapshot,
  );
  const [logDate, setDate] = useState(localDate);
  const [draft, setDraft] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ meal: Meal; correction?: string } | null>(null);
  const query = useQuery({
    queryKey: foodQueryKey(scope, mode === "today" ? TODAY : logDate),
    queryFn: () => client.food(mode === "today" ? undefined : logDate),
    retry: false,
  });
  // The server's answer names the household day; the phone's is only a fallback.
  const today = mode === "today" && query.data ? query.data.date : localDate();
  const date = mode === "today" ? today : logDate;
  const [dayTool, setDayTool] = useState<"clear" | "adjust" | null>(null);
  const authError = useAuthErrorRoute([query.error, operation?.error]);
  const label = dayLabel(date, today);
  // Today writes wait for the server's household date; the phone's can be a day off.
  const busy = (operation !== null && !settled(operation)) || (mode === "today" && !query.data);

  const add = () => {
    const description = draft.trim();
    if ((!description && !photo) || busy) return;
    setDraft("");
    setPhoto(null);
    void actions.start({ kind: "add", date, description, photo: photo?.photo });
  };

  const attach = async (source: PhotoSource) => {
    setPhotoError(null);
    try {
      const picked = await pickMealPhoto(source);
      if (picked === "denied") {
        setPhotoError("Camera access is off. Allow it in Android settings, or choose a photo.");
      } else if (picked) {
        setPhoto(picked);
      }
    } catch {
      setPhotoError("Couldn't open the photo. Try again.");
    }
  };

  return (
    <TabScreen
      screen={mode === "today" ? "food" : "food-log"}
      onRefresh={() =>
        Promise.all([
          query.refetch(),
          mode === "today"
            ? queryClient.refetchQueries({ queryKey: statusQueryKey(scope) })
            : undefined,
        ])
      }
    >
      {mode === "today" ? <TodayTotals /> : null}
      {mode === "log" ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.spacing.sm }}>
          <Button
            label="‹"
            accessibilityLabel="Previous day"
            variant="secondary"
            onPress={() => setDate(shiftDate(date, -1))}
          />
          <View style={{ flex: 1, alignItems: "center" }}>
            <ThemedText variant="title" accessibilityRole="header" accessibilityLiveRegion="polite">
              {label}
            </ThemedText>
            {date !== today ? (
              <Button
                label="Back to today"
                accessibilityLabel="Back to today"
                variant="text"
                onPress={() => setDate(today)}
              />
            ) : null}
          </View>
          <Button
            label="›"
            accessibilityLabel="Next day"
            variant="secondary"
            disabled={date >= today}
            onPress={() => setDate(shiftDate(date, 1))}
          />
        </View>
      ) : null}

      <Section title="Add a meal">
        {photo ? (
          <View style={{ gap: theme.spacing.sm }}>
            <Image
              source={{ uri: photo.uri }}
              accessibilityLabel="Attached meal photo"
              contentFit="cover"
              style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: theme.radii.card }}
            />
            <Button
              label="Remove photo"
              accessibilityLabel="Remove photo"
              variant="text"
              onPress={() => setPhoto(null)}
            />
          </View>
        ) : null}
        <TextField
          label={
            photo ? "Caption (optional)" : `What did you eat${date === today ? "" : ` (${label})`}?`
          }
          value={draft}
          onChangeText={setDraft}
          placeholder={photo ? "Half the plate, extra ghee" : "2 eggs and toast with butter"}
          hint={
            photo
              ? "Nutrition is estimated from the photo. Add portions or what it doesn't show."
              : "Nutrition is estimated from the description. Portions help."
          }
          error={photoError}
          prose
        />
        {photo ? null : (
          <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
            <Button
              label="Take photo"
              accessibilityLabel="Take meal photo"
              variant="secondary"
              disabled={busy}
              onPress={() => void attach("camera")}
              style={{ flex: 1 }}
            />
            <Button
              label="Choose photo"
              accessibilityLabel="Choose meal photo"
              variant="secondary"
              disabled={busy}
              onPress={() => void attach("library")}
              style={{ flex: 1 }}
            />
          </View>
        )}
        <Button
          label="Add meal"
          accessibilityLabel={`Add meal to ${label}`}
          disabled={(!draft.trim() && !photo) || busy}
          onPress={add}
        />
      </Section>

      {operation ? (
        <OperationStatus
          operation={operation}
          showError={!authError}
          onRetry={() => void actions.retry()}
          onDismiss={() => actions.dismiss()}
          onCorrectAgain={(write) => {
            actions.dismiss();
            // The meal is unchanged; open its latest copy if the list moved on.
            const latest = query.data?.meals.find((meal) => meal.id === write.meal.id);
            setEditing({ meal: latest ?? write.meal, correction: write.correction });
          }}
        />
      ) : null}

      {!query.data && query.isPending ? <Progress label={`Loading meals for ${label}`} /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what={`meals for ${label}`}
          noun="meals"
          message={messageForError(query.error)}
          keptNote={query.data ? "Showing the last loaded meals." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && query.data.meals.length === 0 ? (
        <Card title={label}>
          <ThemedText color="muted">
            No meals logged. Add one above or in Signal with /food.
          </ThemedText>
        </Card>
      ) : null}
      {query.data && query.data.meals.length > 0 ? (
        <Section
          title={`Meals · ${query.data.meals.length}`}
          subtitle={`Total ${macroLine(dayTotals(query.data.meals))}`}
        >
          {query.data.meals.map((meal) => (
            <Pressable
              key={meal.id}
              accessibilityRole="button"
              accessibilityLabel={`Edit meal: ${meal.description}. ${mealTime(meal)}, ${macroLine(meal)}`}
              accessibilityHint="Opens correct, rewrite and delete"
              disabled={busy}
              onPress={() => setEditing({ meal })}
              style={{
                minHeight: theme.minTapTarget,
                paddingVertical: theme.spacing.sm,
                gap: theme.spacing.xs,
                borderTopWidth: 1,
                borderTopColor: theme.colors.outline,
                opacity: busy ? 0.5 : 1,
              }}
            >
              <ThemedText variant="label" color="muted">
                {mealTime(meal)}
              </ThemedText>
              <ThemedText medium>{meal.description}</ThemedText>
              <ThemedText color="muted">{macroLine(meal)}</ThemedText>
            </Pressable>
          ))}
        </Section>
      ) : null}

      {mode === "today" && query.data ? (
        <Section
          title="Day tools"
          subtitle="Like /clearfood and /adjustfood in Signal, for today only."
        >
          <Button
            label="Clear today's meals"
            accessibilityLabel="Clear today's meals"
            variant="secondary"
            disabled={busy || query.data.meals.length === 0}
            onPress={() => setDayTool("clear")}
          />
          <Button
            label="Set today's totals"
            accessibilityLabel="Set today's totals"
            variant="secondary"
            disabled={busy}
            onPress={() => setDayTool("adjust")}
          />
        </Section>
      ) : null}

      <Modal
        visible={dayTool !== null}
        animationType="slide"
        onRequestClose={() => setDayTool(null)}
      >
        {dayTool ? (
          <DayTool
            tool={dayTool}
            meals={query.data?.meals.length ?? 0}
            onClear={() => {
              setDayTool(null);
              void actions.start({ kind: "clear", date: today });
            }}
            onAdjust={(totals) => {
              setDayTool(null);
              void actions.start({ kind: "adjust", date: today, ...totals });
            }}
            onClose={() => setDayTool(null)}
          />
        ) : null}
      </Modal>

      <Modal
        visible={editing !== null}
        animationType="slide"
        onRequestClose={() => setEditing(null)}
      >
        {editing ? (
          <EditMeal
            meal={editing.meal}
            correction={editing.correction}
            onCorrect={(correction, correctionPhoto) => {
              setEditing(null);
              void actions.start({
                kind: "correct",
                meal: editing.meal,
                correction,
                photo: correctionPhoto,
              });
            }}
            onSave={(description) => {
              setEditing(null);
              void actions.start({ kind: "edit", meal: editing.meal, description });
            }}
            onDelete={() => {
              setEditing(null);
              void actions.start({ kind: "delete", meal: editing.meal });
            }}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </Modal>
    </TabScreen>
  );
}

function OperationStatus({
  operation,
  showError,
  onRetry,
  onDismiss,
  onCorrectAgain,
}: {
  operation: FoodOperation;
  showError: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  onCorrectAgain: (write: Extract<FoodWrite, { kind: "correct" }>) => void;
}) {
  const { write, outcome } = operation;
  const text = operationText(write);
  if (operation.pending) return <Progress label={text.progress} />;
  if (outcome?.kind === "clarify" && write.kind === "correct") {
    return (
      <Card title="Which part should change?">
        <ThemedText accessibilityRole="alert">{outcome.question}</ThemedText>
        <ThemedText color="muted">{`Nothing changed in ${write.meal.description}.`}</ThemedText>
        <Button
          label="Correct again"
          accessibilityLabel="Correct meal again"
          onPress={() => onCorrectAgain(write)}
        />
        <Button label="Dismiss" accessibilityLabel="Dismiss" variant="text" onPress={onDismiss} />
      </Card>
    );
  }
  if (outcome?.kind === "remote_pending") {
    return (
      <Card title="Meal corrected">
        <ThemedText accessibilityRole="alert">
          Saved here. Google Health gets the change on the next sync.
        </ThemedText>
        <Button label="Dismiss" accessibilityLabel="Dismiss" variant="text" onPress={onDismiss} />
      </Card>
    );
  }
  if (!showError) return null;
  const ambiguous = ambiguousFoodError(operation.error);
  const { subject, verb } = text;
  return (
    <Card title={text.failed}>
      <ThemedText accessibilityRole="alert">{subject}</ThemedText>
      <ThemedText color="muted">{messageForError(operation.error)}</ThemedText>
      {ambiguous ? (
        <ThemedText color="muted">
          The server may have saved this. Retry it unchanged before making another change.
        </ThemedText>
      ) : null}
      <Button label="Retry" accessibilityLabel={`Retry ${verb} meal`} onPress={onRetry} />
      {!ambiguous ? (
        <Button label="Dismiss" accessibilityLabel="Dismiss" variant="text" onPress={onDismiss} />
      ) : null}
    </Card>
  );
}

function operationText(write: FoodWrite): {
  subject: string;
  verb: string;
  progress: string;
  failed: string;
} {
  if (write.kind === "add") {
    return {
      subject: write.description || "Meal photo",
      verb: "add",
      progress: write.photo
        ? "Analyzing photo and adding meal…"
        : "Estimating nutrition and adding meal…",
      failed: "Couldn't add meal",
    };
  }
  if (write.kind === "edit") {
    return {
      subject: write.meal.description,
      verb: "update",
      progress: "Re-estimating and updating meal…",
      failed: "Couldn't update meal",
    };
  }
  if (write.kind === "correct") {
    return {
      subject: write.correction
        ? `${write.meal.description}: ${write.correction}`
        : write.meal.description,
      verb: "correct",
      progress: write.photo ? "Analyzing photo and correcting meal…" : "Correcting meal…",
      failed: "Couldn't correct meal",
    };
  }
  if (write.kind === "delete") {
    return {
      subject: write.meal.description,
      verb: "delete",
      progress: "Deleting meal…",
      failed: "Couldn't delete meal",
    };
  }
  if (write.kind === "clear") {
    return {
      subject: "Today's meals",
      verb: "clear",
      progress: "Clearing today's meals…",
      failed: "Couldn't clear today's meals",
    };
  }
  return {
    subject: `${write.calories} kcal · ${write.protein_g}g P / ${write.carbs_g}g C / ${write.fat_g}g F`,
    verb: "set",
    progress: "Replacing today's meals with the new totals…",
    failed: "Couldn't set today's totals",
  };
}

type Totals = { calories: number; protein_g: number; carbs_g: number; fat_g: number };

/** Confirms a clear, or collects the totals that replace today's meals. */
function DayTool({
  tool,
  meals,
  onClear,
  onAdjust,
  onClose,
}: {
  tool: "clear" | "adjust";
  meals: number;
  onClear: () => void;
  onAdjust: (totals: Totals) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState({ calories: "", protein_g: "", carbs_g: "", fat_g: "" });
  const parsed = parseTotals(values);
  const field = (key: keyof typeof values, label: string) => (
    <TextField
      label={label}
      value={values[key]}
      onChangeText={(text) => setValues((current) => ({ ...current, [key]: text }))}
      keyboardType="decimal-pad"
    />
  );
  return (
    <Screen scroll>
      <ThemedText variant="headline" accessibilityRole="header">
        {tool === "clear" ? "Clear today's meals" : "Set today's totals"}
      </ThemedText>
      {tool === "clear" ? (
        <ThemedText>
          {`Removes today's ${meals} logged ${meals === 1 ? "meal" : "meals"} here and in Google Health. Synced nutrition and activity stay. A meal logged after you confirm is kept.`}
        </ThemedText>
      ) : (
        <>
          <ThemedText>
            Replaces today's logged meals with these totals, kept as one adjustment entry. Synced
            micronutrients and activity stay.
          </ThemedText>
          {field("calories", "Calories (kcal)")}
          {field("protein_g", "Protein (g)")}
          {field("carbs_g", "Carbs (g)")}
          {field("fat_g", "Fat (g)")}
        </>
      )}
      {tool === "clear" ? (
        <Button
          label="Clear meals"
          accessibilityLabel="Confirm clear today's meals"
          variant="danger"
          onPress={onClear}
        />
      ) : (
        <Button
          label="Replace with totals"
          accessibilityLabel="Confirm replace today's meals with totals"
          variant="danger"
          disabled={parsed === null}
          onPress={() => {
            if (parsed) onAdjust(parsed);
          }}
        />
      )}
      <Button label="Cancel" accessibilityLabel="Cancel" variant="text" onPress={onClose} />
    </Screen>
  );
}

function boundedNumber(raw: string, max: number, whole: boolean): number | null {
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (value > max || (whole && !Number.isInteger(value))) return null;
  return value;
}

/** Whole calories 0-20000 and grams 0-2000, as the server accepts; else null. */
export function parseTotals(values: Record<keyof Totals, string>): Totals | null {
  const calories = boundedNumber(values.calories, 20_000, true);
  const protein = boundedNumber(values.protein_g, 2000, false);
  const carbs = boundedNumber(values.carbs_g, 2000, false);
  const fat = boundedNumber(values.fat_g, 2000, false);
  if (calories === null || protein === null || carbs === null || fat === null) return null;
  return { calories, protein_g: protein, carbs_g: carbs, fat_g: fat };
}

/** Today's totals and nutrition goals from `/v1/status`, Signal's numbers. */
function TodayTotals() {
  const { client, scope } = useProfileSession();
  const status = useQuery({
    queryKey: statusQueryKey(scope),
    queryFn: () => client.status(),
    retry: false,
  });
  const goals = status.data?.goals.filter((goal) => goal.key !== "steps") ?? [];
  const main = status.data?.nutrition.filter((nutrient) => !nutrient.sub).slice(0, 4) ?? [];
  if (status.error) {
    return (
      <Card title="Today's totals">
        <ThemedText color="muted">{`Couldn't load today's totals. ${messageForLoad(status.error)}`}</ThemedText>
      </Card>
    );
  }
  if (!status.data) return <Progress label="Loading today's totals" />;
  return (
    <Section title="Today's totals" subtitle="Includes synced nutrition, like Signal's /status.">
      {main.length === 0 ? <ThemedText color="muted">Nothing logged yet today.</ThemedText> : null}
      {main.map((nutrient) => (
        <View
          key={nutrient.key}
          accessible
          accessibilityLabel={`${nutrient.label}: ${nutrientAmount(nutrient)}`}
          style={{ flexDirection: "row", justifyContent: "space-between" }}
        >
          <ThemedText>{nutrient.label}</ThemedText>
          <ThemedText medium>{nutrientAmount(nutrient)}</ThemedText>
        </View>
      ))}
      {goals.map((goal) => (
        <GoalRow key={goal.key} goal={goal} />
      ))}
    </Section>
  );
}

function EditMeal({
  meal,
  correction: initialCorrection = "",
  onCorrect,
  onSave,
  onDelete,
  onClose,
}: {
  meal: Meal;
  correction?: string;
  onCorrect: (correction: string, photo?: MealPhoto) => void;
  onSave: (description: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [correction, setCorrection] = useState(initialCorrection);
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [description, setDescription] = useState(meal.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const trimmed = description.trim();
  const fix = correction.trim();

  const attach = async (source: PhotoSource) => {
    setPhotoError(null);
    try {
      const picked = await pickMealPhoto(source);
      if (picked === "denied") {
        setPhotoError("Camera access is off. Allow it in Android settings, or choose a photo.");
      } else if (picked) {
        setPhoto(picked);
      }
    } catch {
      setPhotoError("Couldn't open the photo. Try again.");
    }
  };

  return (
    <Screen scroll>
      <ThemedText variant="headline" accessibilityRole="header">
        Edit meal
      </ThemedText>
      <ThemedText medium>{meal.description}</ThemedText>
      <ThemedText color="muted">
        {mealTime(meal)} · {macroLine(meal)}
      </ThemedText>

      <Section
        title="Correct it"
        subtitle="Like replying to a meal in Signal: only what you name changes, and the rest stays."
      >
        {photo ? (
          <View style={{ gap: theme.spacing.sm }}>
            <Image
              source={{ uri: photo.uri }}
              accessibilityLabel="Attached correction photo"
              contentFit="cover"
              style={{ width: "100%", aspectRatio: 4 / 3, borderRadius: theme.radii.card }}
            />
            <Button
              label="Remove photo"
              accessibilityLabel="Remove correction photo"
              variant="text"
              onPress={() => setPhoto(null)}
            />
          </View>
        ) : null}
        <TextField
          label={photo ? "Caption (optional)" : "What's different?"}
          value={correction}
          onChangeText={setCorrection}
          placeholder="Paneer, not eggs; half the bowl"
          hint={
            photo
              ? "The photo fills in details. It can't be a barcode: describe a product instead."
              : "If it's unclear which part you mean, you'll be asked first and nothing changes."
          }
          error={photoError}
          prose
        />
        {photo ? null : (
          <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
            <Button
              label="Take photo"
              accessibilityLabel="Take correction photo"
              variant="secondary"
              onPress={() => void attach("camera")}
              style={{ flex: 1 }}
            />
            <Button
              label="Choose photo"
              accessibilityLabel="Choose correction photo"
              variant="secondary"
              onPress={() => void attach("library")}
              style={{ flex: 1 }}
            />
          </View>
        )}
        <Button
          label="Correct meal"
          accessibilityLabel="Correct meal"
          disabled={!fix && !photo}
          onPress={() => onCorrect(fix, photo?.photo)}
        />
      </Section>

      <Section title="Or rewrite it" subtitle="Replaces the description and re-estimates it all.">
        <TextField label="Meal" value={description} onChangeText={setDescription} prose />
        <Button
          label="Save meal"
          accessibilityLabel="Save meal"
          variant="secondary"
          disabled={!trimmed || trimmed === meal.description}
          onPress={() => onSave(trimmed)}
        />
      </Section>

      {confirmDelete ? (
        <>
          <ThemedText accessibilityRole="alert">Delete this meal from the day?</ThemedText>
          <Button
            label="Delete meal"
            accessibilityLabel="Confirm delete meal"
            variant="danger"
            onPress={onDelete}
          />
          <Button
            label="Keep meal"
            accessibilityLabel="Keep meal"
            variant="text"
            onPress={() => setConfirmDelete(false)}
          />
        </>
      ) : (
        <Button
          label="Delete meal"
          accessibilityLabel="Delete meal"
          variant="danger"
          onPress={() => setConfirmDelete(true)}
        />
      )}
      <Button
        label="Cancel"
        accessibilityLabel="Close edit meal"
        variant="text"
        onPress={onClose}
      />
    </Screen>
  );
}
