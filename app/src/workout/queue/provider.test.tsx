import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";

import type { ApiClient } from "@/api";
import { browserStore, type ConnectionContextValue, useConnection } from "@/connection";
import { ConnectionProvider } from "@/connection/connection-context";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";

import { SetQueueProvider, useSetQueue } from "./provider";
import type { SetQueue } from "./set-queue";

const ALEX = { id: "alex", name: "Alex" };
const JORDAN = { id: "jordan", name: "Jordan" };

function memoryStore(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));
  return browserStore({
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  });
}

type Seen = { connection: ConnectionContextValue | null; queues: SetQueue[]; clients: ApiClient[] };

/** Records each distinct queue, client and the latest connection as they render. */
function record(seen: Seen) {
  return {
    connection: (connection: ConnectionContextValue) => {
      seen.connection = connection;
      if (connection.client && seen.clients.at(-1) !== connection.client) {
        seen.clients.push(connection.client);
      }
    },
    queue: (queue: SetQueue) => {
      if (seen.queues.at(-1) !== queue) seen.queues.push(queue);
    },
  };
}

type Recorder = ReturnType<typeof record>;

function QueueProbe({ onQueue }: { onQueue: Recorder["queue"] }) {
  onQueue(useSetQueue().queue);
  return null;
}

function Probe({ recorder }: { recorder: Recorder }) {
  const connection = useConnection();
  recorder.connection(connection);
  return connection.profile ? <QueueProbe onQueue={recorder.queue} /> : null;
}

function renderApp(seen: Seen, children?: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  const settings = { version: 1, serverUrl: "https://mini.ts.net:8787", profile: ALEX };
  // Offline, so no queue ever sends.
  const fetchImpl = jest.fn(() => Promise.reject(new TypeError("Network request failed")));
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectionProvider
        store={memoryStore({
          [TOKEN_KEY]: "alex_phone.secret",
          [SETTINGS_KEY]: JSON.stringify(settings),
        })}
        fetch={fetchImpl}
      >
        <SetQueueProvider store={memoryStore()} retryDelay={() => 60 * 60 * 1000}>
          <Probe recorder={record(seen)} />
          {children}
        </SetQueueProvider>
      </ConnectionProvider>
    </QueryClientProvider>,
  );
}

function connectionOf(seen: Seen): ConnectionContextValue {
  if (!seen.connection) throw new Error("not rendered");
  return seen.connection;
}

describe("SetQueueProvider", () => {
  it("keeps one queue per profile, so switching back never adds a second writer", async () => {
    const seen: Seen = { connection: null, queues: [], clients: [] };
    const view = await renderApp(seen);
    await waitFor(() => expect(seen.queues).toHaveLength(1));
    const alex = seen.queues[0];

    await act(() => connectionOf(seen).chooseProfile(JORDAN));
    await act(() => connectionOf(seen).chooseProfile(ALEX));

    expect(seen.queues).toHaveLength(3);
    expect(seen.queues[1]).not.toBe(alex);
    expect(seen.queues[2]).toBe(alex);
    await view.unmount();
  });
});

describe("ConnectionProvider", () => {
  it("keeps the same client when only a weight unit changes", async () => {
    const seen: Seen = { connection: null, queues: [], clients: [] };
    const view = await renderApp(seen);
    await waitFor(() => expect(seen.clients).toHaveLength(1));
    const deviceClient = connectionOf(seen).deviceClient;

    await act(() => connectionOf(seen).chooseProfile({ ...ALEX, weight_unit: "kg" }));

    expect(connectionOf(seen).profile?.weight_unit).toBe("kg");
    expect(seen.clients).toHaveLength(1);
    expect(connectionOf(seen).deviceClient).toBe(deviceClient);

    await act(() => connectionOf(seen).chooseProfile(JORDAN));
    expect(seen.clients).toHaveLength(2);
    await view.unmount();
  });
});
