import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useRef, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, RefreshControl, ScrollView, View } from "react-native";
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";

import type { Task } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { usePullToRefresh } from "@/components/pull-to-refresh";
import { Screen } from "@/components/screen";
import { TextField } from "@/components/text-field";
import { SectionScreen } from "@/components/section-screen";
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
  MAX_SNOOZE_DAYS,
  MIN_SNOOZE_DAYS,
  SNOOZE_CHOICES,
  type SnoozeDays,
  type TaskAction,
  taskActions,
  tasksQueryKey,
  visibleTasks,
} from "./actions";
import { CreateTaskModal, taskCreation } from "./create-task";
import { actionText, groupTasks, type TaskListTab, taskDate, todayOf } from "./format";

const snoozeDays = SNOOZE_CHOICES;

/** Whole days in the server's snooze range, or null. */
function validDays(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const days = Number(raw.trim());
  return days >= MIN_SNOOZE_DAYS && days <= MAX_SNOOZE_DAYS ? days : null;
}

/** Tasks › Today: overdue, due today and undated open tasks. */
export function TasksScreen() {
  const session = useProfileSession();
  return <ProfileTasksScreen key={session.scope} session={session} tab="today" />;
}

/** Tasks › Upcoming: open tasks due later and snoozed tasks. */
export function UpcomingTasksScreen() {
  const session = useProfileSession();
  return <ProfileTasksScreen key={session.scope} session={session} tab="upcoming" />;
}

function ProfileTasksScreen({ session, tab }: { session: ProfileSession; tab: TaskListTab }) {
  const theme = useTheme();
  const { client, scope } = session;
  const queryClient = useQueryClient();
  const actions = taskActions(queryClient, scope, client);
  const creation = taskCreation(queryClient, scope, client);
  const creationState = useSyncExternalStore(
    creation.subscribe,
    creation.getSnapshot,
    creation.getSnapshot,
  );
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
  const pull = usePullToRefresh(() => query.refetch());
  const [days, setDays] = useState<SnoozeDays>(1);
  const [chosenTask, setMenuTask] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const [customDays, setCustomDays] = useState("");
  const allTasks = visibleTasks(query.data?.tasks ?? [], operations);
  const today = todayOf(query.data);
  const groups = groupTasks(allTasks, today, tab);
  const tasks = groups.flatMap((group) => group.tasks);
  // `?task=<id>` (from Today) opens that task's actions once it has loaded,
  // until the menu is first closed.
  const { task: linkedId } = useLocalSearchParams<{ task?: string }>();
  const [linkHandled, setLinkHandled] = useState(false);
  const linked = linkedId && !linkHandled ? tasks.find((task) => task.id === linkedId) : undefined;
  const menuTask = chosenTask ?? linked ?? null;
  const closeMenu = () => {
    setMenuTask(null);
    setLinkHandled(true);
    setCustomDays("");
  };
  const pending = operations.filter((operation) => operation.pending);
  const failures = operations.filter((operation) => !operation.pending && !operation.warning);
  const authError = useAuthErrorRoute([
    query.error,
    ...failures.map((operation) => operation.error),
  ]);

  const perform = (task: Task, action: TaskAction) => {
    closeMenu();
    void actions.perform(task, action);
  };
  const blocked = (task: Task) =>
    operations.some((operation) => operation.task.id === task.id && !operation.warning);

  return (
    <SectionScreen screen={tab === "today" ? "tasks" : "tasks-upcoming"}>
      <ScrollView
        testID={`tasks-${tab}-scroll`}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.lg }}
        refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      >
        {tab === "today" ? (
          <Button
            label="Add task"
            accessibilityLabel="Add task"
            variant="secondary"
            onPress={() => setAdding(true)}
          />
        ) : null}
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
                  {actionText(operation.action)} before changing this task again. Keep the app open
                  until resolved.
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
              {tab === "today" ? "You're up to date" : "Nothing upcoming"}
            </ThemedText>
            <ThemedText color="muted">
              {tab === "today"
                ? "Nothing due today or overdue, and no undated tasks. Later and snoozed tasks are in Upcoming."
                : "No tasks due later and nothing snoozed. Pull down to refresh tasks from Signal."}
            </ThemedText>
          </Card>
        )}
        {groups.map((group) => {
          if (group.tasks.length === 0) return null;
          return (
            <View key={group.title} style={{ gap: theme.spacing.md }}>
              <ThemedText variant="title" accessibilityRole="header">
                {group.title} · {group.tasks.length}
              </ThemedText>
              {group.tasks.map((task) => (
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
      <Modal visible={menuTask !== null} animationType="slide" onRequestClose={closeMenu}>
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
          <TextField
            label="Snooze for days"
            value={customDays}
            onChangeText={setCustomDays}
            keyboardType="number-pad"
            hint={`${MIN_SNOOZE_DAYS} to ${MAX_SNOOZE_DAYS} days, from today`}
            error={
              customDays && validDays(customDays) === null
                ? `Enter ${MIN_SNOOZE_DAYS} to ${MAX_SNOOZE_DAYS}`
                : null
            }
          />
          <Button
            label={validDays(customDays) ? `Snooze ${validDays(customDays)} days` : "Snooze"}
            accessibilityLabel="Snooze for the entered days"
            variant="secondary"
            disabled={!menuTask || blocked(menuTask) || validDays(customDays) === null}
            onPress={() => {
              const entered = validDays(customDays);
              if (menuTask && entered !== null)
                perform(menuTask, { kind: "snooze", days: entered });
            }}
          />
          {menuTask?.status === "snoozed" ? (
            <Button
              label="Unsnooze"
              accessibilityLabel="Unsnooze task"
              variant="secondary"
              disabled={blocked(menuTask)}
              onPress={() => perform(menuTask, { kind: "reopen" })}
            />
          ) : null}
          {menuTask && menuTask.assigned_to === null ? (
            <Button
              label="Assign to me"
              accessibilityLabel="Assign task to me"
              variant="secondary"
              disabled={blocked(menuTask)}
              onPress={() => perform(menuTask, { kind: "assign", memberId: session.profile.id })}
            />
          ) : null}
          <Button
            label="Keep task"
            accessibilityLabel="Close task actions"
            variant="text"
            onPress={closeMenu}
          />
        </Screen>
      </Modal>
      {tab === "today" ? (
        <CreateTaskModal
          // A save from before (unconfirmed, or its result) reopens here.
          visible={adding || creationState.kind !== "editing"}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </SectionScreen>
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
          ...(task.status === "snoozed" ? [{ name: "reopen", label: "Unsnooze task" }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (disabled) return;
          if (nativeEvent.actionName === "complete") onAction({ kind: "complete" });
          if (nativeEvent.actionName === "reopen") onAction({ kind: "reopen" });
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
        {task.assigned_to === null ? (
          <ThemedText color="muted">Household · unassigned</ThemedText>
        ) : null}
        <ThemedText variant="label" color="primary">
          Task actions
        </ThemedText>
      </Pressable>
    </ReanimatedSwipeable>
  );
}
