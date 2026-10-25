import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";

import {
  type KeyValueStore,
  PendingSetCountProvider,
  profileScope,
  useConnection,
} from "@/connection";

import { newRequestId } from "../ids";
import { applyWorkout, workoutQueryKey } from "../queries";
import { type QueueSnapshot, SetQueue } from "./set-queue";
import { queueStore } from "./storage";

type SetQueueContextValue = { queue: SetQueue | null };

const SetQueueContext = createContext<SetQueueContextValue | null>(null);

const EMPTY: QueueSnapshot = {
  items: [],
  loaded: false,
  sending: null,
  waiting: false,
  blocked: null,
};
const noSubscription = () => () => undefined;
const emptySnapshot = () => EMPTY;

export type SetQueueProviderProps = {
  children: ReactNode;
  /** Defaults to AsyncStorage on native and localStorage on web; injectable for tests. */
  store?: KeyValueStore;
  /** Milliseconds before retry `attempt`; injectable for tests. */
  retryDelay?: (attempt: number) => number;
};

/**
 * Owns the offline set queue for the chosen server and profile, replays it on
 * foreground, and reports the pending count to the recovery screens. Wraps
 * the whole app so replay continues on any screen.
 */
export function SetQueueProvider({ children, store, retryDelay }: SetQueueProviderProps) {
  const connection = useConnection();
  const queryClient = useQueryClient();
  const [kv] = useState<KeyValueStore>(() => store ?? queueStore());
  const scope =
    connection.serverUrl && connection.profile
      ? profileScope(connection.serverUrl, connection.profile.id)
      : null;

  const [state, setState] = useState<{ scope: string | null; queue: SetQueue | null }>({
    scope: null,
    queue: null,
  });
  let queue = state.queue;
  if (state.scope !== scope) {
    queue = scope
      ? new SetQueue({
          store: kv,
          scope,
          newRequestId,
          retryDelay,
          onDelivered: (_item, response) => applyWorkout(queryClient, scope, response),
          onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: workoutQueryKey(scope) });
          },
          onUndoDelivered: () => {
            void queryClient.invalidateQueries({ queryKey: workoutQueryKey(scope) });
          },
        })
      : null;
    setState({ scope, queue });
  }

  useEffect(() => {
    if (!queue) return undefined;
    queue.start();
    const subscription = AppState.addEventListener("change", (appState) => {
      if (appState === "active") queue.kick();
    });
    return () => {
      subscription.remove();
      queue.stop();
    };
  }, [queue]);

  // The client changes when the token is replaced. Try again with it, which
  // also clears a stale 401.
  const { client } = connection;
  useEffect(() => {
    if (!queue) return;
    queue.setClient(client);
    queue.kick();
  }, [client, queue]);

  const snapshot = useSyncExternalStore(
    queue?.subscribe ?? noSubscription,
    queue?.getSnapshot ?? emptySnapshot,
    queue?.getSnapshot ?? emptySnapshot,
  );
  const contextValue = useMemo(() => ({ queue }), [queue]);
  const pending = snapshot.items.filter((item) => item.status === "pending").length;

  return (
    <SetQueueContext.Provider value={contextValue}>
      <PendingSetCountProvider value={queue ? pending : null}>{children}</PendingSetCountProvider>
    </SetQueueContext.Provider>
  );
}

export type SetQueueState = QueueSnapshot & {
  queue: SetQueue;
  pendingCount: number;
  failedCount: number;
};

/** The chosen profile's queue. Must be inside SetQueueProvider with a profile chosen. */
export function useSetQueue(): SetQueueState {
  const value = useContext(SetQueueContext);
  if (!value) throw new Error("useSetQueue must be used inside SetQueueProvider");
  const { queue } = value;
  const snapshot = useSyncExternalStore(
    queue?.subscribe ?? noSubscription,
    queue?.getSnapshot ?? emptySnapshot,
    queue?.getSnapshot ?? emptySnapshot,
  );
  if (!queue) throw new Error("useSetQueue needs a chosen profile");
  return {
    ...snapshot,
    queue,
    pendingCount: snapshot.items.filter((item) => item.status === "pending").length,
    failedCount: snapshot.items.filter((item) => item.status === "failed").length,
  };
}
