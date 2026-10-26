import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useRef, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";

import type { Task } from "@/api";
import { AppBar } from "@/components/app-bar";
import { BottomNav } from "@/components/bottom-nav";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { Screen } from "@/components/screen";
import { ThemedText } from "@/components/themed-text";
import {
  messageForError,
  type ProfileSession,
  useAuthErrorRoute,
  useProfileSession,
} from "@/connection";
import { useTheme } from "@/theme";

import {
  ambiguousTaskError,
  type SnoozeDays,
  type TaskAction,
  taskActions,
  tasksQueryKey,
  visibleTasks,
} from "./actions";

const snoozeDays = [1, 3, 7] as const;

function taskDate(task: Task): string {
  if (task.due_has_time && task.due_at) {
    return new Date(task.due_at).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }
  // Date-only deadlines are calendar dates, not UTC instants.
  return task.due_date
    ? new Date(`${task.due_date}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "No due date";
}

export function TasksScreen() {
  const session = useProfileSession();
  return <ProfileTasksScreen key={session.scope} session={session} />;
}

function ProfileTasksScreen({ session }: { session: ProfileSession }) {
  const theme = useTheme();
  const router = useRouter();
  const { client, scope } = session;
  const queryClient = useQueryClient();
  const actions = taskActions(queryClient, scope, client);
  const operations = useSyncExternalStore(
    actions.subscribe,
    actions.getSnapshot,
    actions.getSnapshot,
  );
  const query = useQuery({
    queryKey: tasksQueryKey(scope),
    queryFn: () => client.tasks(),
    retry: false,
  });
  const [days, setDays] = useState<SnoozeDays>(1);
  const [menuTask, setMenuTask] = useState<Task | null>(null);
  const tasks = visibleTasks(query.data?.tasks ?? [], operations);
  const pending = operations.filter((operation) => operation.pending);
  const failures = operations.filter((operation) => !operation.pending && !operation.warning);
  const authError = useAuthErrorRoute([
    query.error,
    ...failures.map((operation) => operation.error),
  ]);

  const perform = (task: Task, action: TaskAction) => {
    setMenuTask(null);
    void actions.perform(task, action);
  };
  const blocked = (task: Task) =>
    operations.some((operation) => operation.task.id === task.id && !operation.warning);

  return (
    <Screen>
      <AppBar
        title="Tasks"
        action={{
          label: "Profile",
          accessibilityLabel: "Profile and settings",
          onPress: () => router.push("/settings"),
        }}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.lg }}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
        }
      >
        <ThemedText color="muted">
          Swipe right to complete. Swipe left to snooze for the selected days. Or open Task actions.
        </ThemedText>
        <ThemedText variant="label">SWIPE SNOOZE DURATION</ThemedText>
        <View style={{ flexDirection: "row", gap: theme.spacing.sm }}>
          {snoozeDays.map((choice) => (
            <Pressable
              key={choice}
              accessibilityRole="radio"
              accessibilityLabel={`Swipe snooze ${choice} ${choice === 1 ? "day" : "days"}`}
              accessibilityState={{ checked: days === choice }}
              aria-checked={days === choice}
              onPress={() => setDays(choice)}
              style={{
                flex: 1,
                minHeight: theme.minTapTarget,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: theme.radii.card,
                backgroundColor: days === choice ? theme.colors.container : theme.colors.surface,
              }}
            >
              <ThemedText medium>
                {choice} {choice === 1 ? "day" : "days"}
                {days === choice ? " · selected" : ""}
              </ThemedText>
            </Pressable>
          ))}
        </View>
        {!query.data && query.isPending && <Progress label="Loading your tasks" />}
        {query.error && !authError ? (
          <LoadFailed
            what="your tasks"
            noun="tasks"
            message={messageForError(query.error)}
            keptNote={query.data ? "Showing the last loaded list." : undefined}
            onRetry={() => void query.refetch()}
          />
        ) : null}
        {pending.length > 0 && (
          <ThemedText accessibilityLiveRegion="polite">
            Saving {pending.length} {pending.length === 1 ? "task" : "tasks"}…
          </ThemedText>
        )}
        {operations
          .filter((operation) => operation.warning)
          .map((operation) => (
            <Card key={operation.requestId} title="Calendar sync">
              <ThemedText accessibilityRole="alert">
                Task snoozed: {operation.task.title}. Calendar warning: {operation.warning}.
              </ThemedText>
              <ThemedText color="muted">
                The task was saved. Its calendar event may still show the old date.
              </ThemedText>
              <Button
                label="Dismiss warning"
                accessibilityLabel={`Dismiss calendar warning: ${operation.task.title}`}
                variant="text"
                onPress={() => actions.dismiss(operation.requestId)}
              />
            </Card>
          ))}
        {failures.map((operation) => (
          <Card key={operation.requestId} title="Task action">
            <ThemedText color="error" accessibilityRole="alert">
              {operation.task.title}: {messageForError(operation.error)}
            </ThemedText>
            <ThemedText>The list update was rolled back.</ThemedText>
            {ambiguousTaskError(operation.error) ? (
              <>
                <ThemedText color="muted">
                  The server may have saved this action. Retry the same{" "}
                  {operation.action.kind === "complete"
                    ? "completion"
                    : `${operation.action.days}-day snooze`}{" "}
                  before changing this task again. Keep the app open until resolved.
                </ThemedText>
                <Button
                  label="Retry unchanged"
                  accessibilityLabel={`Retry unchanged: ${operation.task.title}`}
                  variant="secondary"
                  onPress={() => void actions.retry(operation.requestId)}
                />
              </>
            ) : (
              <Button
                label="Keep task"
                accessibilityLabel={`Keep task: ${operation.task.title}`}
                variant="text"
                onPress={() => actions.dismiss(operation.requestId)}
              />
            )}
          </Card>
        ))}
        {query.data && tasks.length === 0 && pending.length === 0 && (
          <Card title="Tasks">
            <ThemedText variant="title" accessibilityRole="header">
              You're up to date
            </ThemedText>
            <ThemedText color="muted">
              No open or snoozed tasks. Pull down to refresh tasks from Signal.
            </ThemedText>
          </Card>
        )}
        {(["open", "snoozed"] as const).map((status) => {
          const section = tasks.filter((task) => task.status === status);
          if (section.length === 0) return null;
          return (
            <View key={status} style={{ gap: theme.spacing.md }}>
              <ThemedText variant="title" accessibilityRole="header">
                {status === "open" ? "Open" : "Snoozed"} · {section.length}
              </ThemedText>
              {section.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  days={days}
                  disabled={blocked(task)}
                  onAction={(action) => perform(task, action)}
                  onMenu={() => setMenuTask(task)}
                />
              ))}
            </View>
          );
        })}
      </ScrollView>
      <BottomNav selected="tasks" />
      <Modal
        visible={menuTask !== null}
        animationType="slide"
        onRequestClose={() => setMenuTask(null)}
      >
        <Screen scroll>
          <ThemedText variant="headline" accessibilityRole="header">
            Task actions
          </ThemedText>
          <ThemedText variant="title">{menuTask?.title}</ThemedText>
          <Button
            label="Complete task"
            accessibilityLabel="Complete task"
            disabled={!menuTask || blocked(menuTask)}
            onPress={() => {
              if (menuTask) perform(menuTask, { kind: "complete" });
            }}
          />
          {snoozeDays.map((choice) => (
            <Button
              key={choice}
              label={`Snooze ${choice} ${choice === 1 ? "day" : "days"}`}
              accessibilityLabel={`Snooze ${choice} ${choice === 1 ? "day" : "days"}`}
              variant="secondary"
              disabled={!menuTask || blocked(menuTask)}
              onPress={() => {
                if (menuTask) perform(menuTask, { kind: "snooze", days: choice });
              }}
            />
          ))}
          <Button
            label="Keep task"
            accessibilityLabel="Close task actions"
            variant="text"
            onPress={() => setMenuTask(null)}
          />
        </Screen>
      </Modal>
    </Screen>
  );
}

function TaskRow({
  task,
  days,
  disabled,
  onAction,
  onMenu,
}: {
  task: Task;
  days: SnoozeDays;
  disabled: boolean;
  onAction: (action: TaskAction) => void;
  onMenu: () => void;
}) {
  const theme = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  return (
    <ReanimatedSwipeable
      ref={swipeable}
      testID={`task-swipe-${task.id}`}
      enabled={!disabled}
      overshootLeft={false}
      overshootRight={false}
      leftThreshold={72}
      rightThreshold={72}
      renderLeftActions={() => (
        <View
          style={{
            justifyContent: "center",
            padding: theme.spacing.lg,
            backgroundColor: theme.colors.container,
          }}
        >
          <ThemedText medium>Complete</ThemedText>
        </View>
      )}
      renderRightActions={() => (
        <View
          style={{
            justifyContent: "center",
            padding: theme.spacing.lg,
            backgroundColor: theme.colors.container,
          }}
        >
          <ThemedText medium>Snooze {days}d</ThemedText>
        </View>
      )}
      onSwipeableOpen={(direction) => {
        swipeable.current?.close();
        if (!disabled)
          onAction(
            direction === SwipeDirection.RIGHT ? { kind: "complete" } : { kind: "snooze", days },
          );
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Task actions: ${task.title}. ${task.status === "snoozed" ? "Snoozed until" : "Due"} ${taskDate(task)}${disabled ? ". Action needs attention or is saving" : ""}`}
        accessibilityHint="Opens complete and snooze choices"
        accessibilityActions={[
          { name: "complete", label: "Complete task" },
          ...snoozeDays.map((choice) => ({
            name: `snooze${choice}`,
            label: `Snooze ${choice} days`,
          })),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (disabled) return;
          if (nativeEvent.actionName === "complete") onAction({ kind: "complete" });
          for (const choice of snoozeDays)
            if (nativeEvent.actionName === `snooze${choice}`)
              onAction({ kind: "snooze", days: choice });
        }}
        onPress={onMenu}
        onLongPress={onMenu}
        style={{
          minHeight: theme.minTapTarget,
          padding: theme.spacing.lg,
          gap: theme.spacing.sm,
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.card,
        }}
      >
        <ThemedText medium>{task.title}</ThemedText>
        <ThemedText color="muted">
          {task.status === "snoozed" ? "Snoozed until" : "Due"} {taskDate(task)}
        </ThemedText>
        {task.email_subject && <ThemedText color="muted">Email: {task.email_subject}</ThemedText>}
        <ThemedText variant="label" color="primary">
          Task actions
        </ThemedText>
      </Pressable>
    </ReanimatedSwipeable>
  );
}
