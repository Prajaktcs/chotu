import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useState, useSyncExternalStore } from "react";
import { Modal, Pressable, View } from "react-native";

import type { Meal } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Screen } from "@/components/screen";
import { Section } from "@/components/section";
import { TabScreen } from "@/components/tab-screen";
import { TextField } from "@/components/text-field";
import { ThemedText } from "@/components/themed-text";
import { messageForError, useAuthErrorRoute, useProfileSession } from "@/connection";
import { useTheme } from "@/theme";

import { ambiguousFoodError, type FoodOperation, foodActions } from "./actions";
import {
  dayLabel,
  dayTotals,
  foodQueryKey,
  localDate,
  macroLine,
  mealTime,
  shiftDate,
} from "./format";
import { type PhotoSource, type PickedPhoto, pickMealPhoto } from "./photo";

/** One day's meals, today by default, with add, edit and delete. */
export function FoodScreen() {
  const session = useProfileSession();
  return <ProfileFoodScreen key={session.scope} />;
}

function ProfileFoodScreen() {
  const theme = useTheme();
  const { client, scope } = useProfileSession();
  const queryClient = useQueryClient();
  const actions = foodActions(queryClient, scope, client);
  const operation = useSyncExternalStore(
    actions.subscribe,
    actions.getSnapshot,
    actions.getSnapshot,
  );
  const today = localDate();
  const [date, setDate] = useState(today);
  const [draft, setDraft] = useState("");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Meal | null>(null);
  const query = useQuery({
    queryKey: foodQueryKey(scope, date),
    queryFn: () => client.food(date),
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error, operation?.error]);
  const label = dayLabel(date, today);
  const busy = operation !== null;

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
    <TabScreen title="Food" tab="food" onRefresh={() => query.refetch()}>
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
              accessibilityHint="Opens edit and delete"
              disabled={busy}
              onPress={() => setEditing(meal)}
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

      <Modal
        visible={editing !== null}
        animationType="slide"
        onRequestClose={() => setEditing(null)}
      >
        {editing ? (
          <EditMeal
            meal={editing}
            onSave={(description) => {
              setEditing(null);
              void actions.start({ kind: "edit", meal: editing, description });
            }}
            onDelete={() => {
              setEditing(null);
              void actions.start({ kind: "delete", meal: editing });
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
}: {
  operation: FoodOperation;
  showError: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { write } = operation;
  const subject = write.kind === "add" ? write.description || "Meal photo" : write.meal.description;
  if (operation.pending) {
    return (
      <Progress
        label={
          write.kind === "add"
            ? write.photo
              ? "Analyzing photo and adding meal…"
              : "Estimating nutrition and adding meal…"
            : write.kind === "edit"
              ? "Re-estimating and updating meal…"
              : "Deleting meal…"
        }
      />
    );
  }
  if (!showError) return null;
  const ambiguous = ambiguousFoodError(operation.error);
  const verb = write.kind === "add" ? "add" : write.kind === "edit" ? "update" : "delete";
  return (
    <Card title={`Couldn't ${verb} meal`}>
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

function EditMeal({
  meal,
  onSave,
  onDelete,
  onClose,
}: {
  meal: Meal;
  onSave: (description: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [description, setDescription] = useState(meal.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const trimmed = description.trim();
  return (
    <Screen scroll>
      <ThemedText variant="headline" accessibilityRole="header">
        Edit meal
      </ThemedText>
      <ThemedText color="muted">
        {mealTime(meal)} · {macroLine(meal)}
      </ThemedText>
      <TextField
        label="Meal"
        value={description}
        onChangeText={setDescription}
        hint="Saving re-estimates nutrition from this description."
        prose
      />
      <Button
        label="Save meal"
        accessibilityLabel="Save meal"
        disabled={!trimmed || trimmed === meal.description}
        onPress={() => onSave(trimmed)}
      />
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
