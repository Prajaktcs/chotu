import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { View } from "react-native";

import type { DoneTask } from "@/api";
import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { LoadFailed } from "@/components/load-failed";
import { Progress } from "@/components/progress";
import { TabScreen } from "@/components/tab-screen";
import { ThemedText } from "@/components/themed-text";
import { messageForLoad, useAuthErrorRoute, useProfileSession } from "@/connection";
import { useTheme } from "@/theme";

import { completedTasksQueryKey, taskActions } from "./actions";
import { taskDate } from "./format";

const PAGE = 20;

/** Tasks › Completed: recorded completions, newest first, with Reopen. */
export function CompletedTasksScreen() {
  const session = useProfileSession();
  return <ProfileCompletedScreen key={session.scope} />;
}

function ProfileCompletedScreen() {
  const { client, scope } = useProfileSession();
  const queryClient = useQueryClient();
  const actions = taskActions(queryClient, scope, client);
  const operations = useSyncExternalStore(
    actions.subscribe,
    actions.getSnapshot,
    actions.getSnapshot,
  );
  const query = useInfiniteQuery({
    queryKey: completedTasksQueryKey(scope),
    queryFn: ({ pageParam }) =>
      client.completedTasks({ before: pageParam ?? undefined, limit: PAGE }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_before,
    retry: false,
  });
  const authError = useAuthErrorRoute([query.error]);
  // A pending or saved reopen leaves the list at once; a failed one shows on Tasks › Today.
  const reopening = new Set(
    operations.filter((item) => item.action.kind === "reopen").map((item) => item.task.id),
  );
  const tasks = (query.data?.pages.flatMap((page) => page.tasks) ?? []).filter(
    (task) => !reopening.has(task.id),
  );

  return (
    <TabScreen screen="tasks-completed" onRefresh={() => query.refetch()}>
      {!query.data && query.isPending ? <Progress label="Loading completed tasks" /> : null}
      {query.error && !authError ? (
        <LoadFailed
          what="completed tasks"
          noun="completed tasks"
          message={messageForLoad(query.error)}
          keptNote={query.data ? "Showing the tasks already loaded." : undefined}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data && tasks.length === 0 ? (
        <Card title="Completed">
          <ThemedText variant="title" accessibilityRole="header">
            Nothing completed yet
          </ThemedText>
          <ThemedText color="muted">Tasks you complete here or in Signal show up here.</ThemedText>
        </Card>
      ) : null}
      {tasks.map((task) => (
        <CompletedRow
          key={task.id}
          task={task}
          onReopen={() => void actions.perform(task, { kind: "reopen" })}
        />
      ))}
      {query.hasNextPage ? (
        <Button
          variant="secondary"
          label={query.isFetchingNextPage ? "Loading…" : "Load older tasks"}
          accessibilityLabel="Load older completed tasks"
          disabled={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
        />
      ) : null}
    </TabScreen>
  );
}

function CompletedRow({ task, onReopen }: { task: DoneTask; onReopen: () => void }) {
  const theme = useTheme();
  const at = new Date(task.completed_at);
  const when = Number.isNaN(at.getTime())
    ? task.completed_at
    : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <View
      style={{
        padding: theme.spacing.lg,
        gap: theme.spacing.xs,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radii.card,
      }}
    >
      <ThemedText medium>{task.title}</ThemedText>
      <ThemedText color="muted">{`Completed ${when}`}</ThemedText>
      {task.due_date ? <ThemedText color="muted">{`Was due ${taskDate(task)}`}</ThemedText> : null}
      <Button
        variant="text"
        label="Reopen"
        accessibilityLabel={`Reopen ${task.title}`}
        onPress={onReopen}
        style={{ alignSelf: "flex-start", paddingHorizontal: 0 }}
      />
    </View>
  );
}
