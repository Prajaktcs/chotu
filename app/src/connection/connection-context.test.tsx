import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react-native";

import type { WeightUnit } from "@/api";
import { HEALTH, json } from "@/test/fetch-mock";

import {
  ConnectionProvider,
  type ConnectionContextValue,
  useConnection,
} from "./connection-context";
import { loadConnection, type KeyValueStore, SETTINGS_KEY, TOKEN_KEY } from "./storage";

const fetchImpl: typeof fetch = (input, init) => {
  if ((input instanceof Request ? input.url : input.toString()).endsWith("/v1/health")) {
    return Promise.resolve(json(200, HEALTH));
  }
  const id = new Headers(init?.headers).get("X-Chotu-Member") ?? "alex";
  const profile = {
    id,
    name: id === "alex" ? "Alex" : "Jordan",
    weight_unit: "kg" as WeightUnit,
  };
  return Promise.resolve(json(200, { member: profile, profiles: [profile] }));
};

function Probe({ record }: { record: (connection: ConnectionContextValue) => void }) {
  record(useConnection());
  return null;
}

it.each(["profile", "clear", "server", "token"] as const)(
  "does not restore old %s settings after a delayed refresh write and restart",
  async (mutation) => {
    const items = new Map([
      [TOKEN_KEY, "old-token"],
      [
        SETTINGS_KEY,
        JSON.stringify({
          version: 1,
          serverUrl: "https://old.ts.net",
          profile: { id: "alex", name: "Alex", weight_unit: "lb" },
        }),
      ],
    ]);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstSave = true;
    const store: KeyValueStore = {
      getItem: (key) => Promise.resolve(items.get(key) ?? null),
      removeItem: (key) => {
        items.delete(key);
        return Promise.resolve();
      },
      setItem: async (key, value) => {
        if (key === SETTINGS_KEY && firstSave) {
          firstSave = false;
          started.resolve();
          await release.promise;
        }
        items.set(key, value);
      },
    };
    let connection: ConnectionContextValue | null = null;
    const current = (): ConnectionContextValue => {
      if (!connection) throw new Error("provider not ready");
      return connection;
    };
    const record = (value: ConnectionContextValue) => {
      connection = value;
    };
    const view = await render(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectionProvider store={store} fetch={fetchImpl}>
          <Probe record={record} />
        </ConnectionProvider>
      </QueryClientProvider>,
    );
    await act(() => started.promise);
    let saving: Promise<void> = Promise.resolve();
    await act(async () => {
      if (mutation === "profile")
        saving = current().chooseProfile({ id: "jordan", name: "Jordan", weight_unit: "kg" });
      if (mutation === "clear") saving = current().clearProfile();
      if (mutation === "server") saving = current().saveServer("https://new.ts.net", "new-token");
      if (mutation === "token") saving = current().replaceToken("new-token");
      await Promise.resolve();
      release.resolve();
      await saving;
    });
    await waitFor(() => {
      if (mutation === "profile") expect(current().profile?.id).toBe("jordan");
      if (mutation === "clear" || mutation === "server") expect(current().profile).toBeNull();
      if (mutation === "server") expect(current().serverUrl).toBe("https://new.ts.net");
    });
    await view.unmount();
    // A fresh load observes disk, not the provider's possibly newer React state.
    const restarted = await loadConnection(store);
    expect(restarted).toEqual({
      serverUrl: mutation === "server" ? "https://new.ts.net" : "https://old.ts.net",
      token: mutation === "token" || mutation === "server" ? "new-token" : "old-token",
      profile:
        mutation === "clear" || mutation === "server"
          ? null
          : {
              id: mutation === "profile" ? "jordan" : "alex",
              name: mutation === "profile" ? "Jordan" : "Alex",
              weight_unit: "kg",
            },
    });
  },
);
