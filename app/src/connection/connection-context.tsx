import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type ApiClient,
  ApiError,
  createApiClient,
  type Me,
  type Profile,
  type WeightUnit,
} from "@/api";

import {
  type KeyValueStore,
  loadConnection,
  platformStore,
  saveConnection,
  type StoredConnection,
} from "./storage";

/**
 * The saved connection, without the token. The token stays inside the
 * provider and the API clients it builds; it is never handed to a screen.
 */
export type ConnectionContextValue = {
  /** "loading" until the saved settings have been read. */
  status: "loading" | "ready";
  /** The normalised server URL, or null before setup. */
  serverUrl: string | null;
  /** Whether a device token is saved. */
  hasToken: boolean;
  /** The chosen profile, or null until one is picked. */
  profile: Profile | null;
  /** A client for the saved connection and chosen profile (`X-Chotu-Member`). */
  client: ApiClient | null;
  /** A client for the saved connection with no member, for `/v1/me` in the picker. */
  deviceClient: ApiClient | null;
  /**
   * Saves a server URL (already normalised) and token, and clears the chosen
   * profile. With no token, the saved one is kept.
   */
  saveServer(serverUrl: string, token?: string): Promise<void>;
  /** Replaces the saved device token. */
  replaceToken(token: string): Promise<void>;
  chooseProfile(profile: Profile): Promise<void>;
  clearProfile(): Promise<void>;
  /**
   * Checks the saved connection: `GET /v1/health`, then `GET /v1/me` (with
   * the chosen profile, if any). Rejects with an ApiError.
   */
  verify(): Promise<Me>;
};

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export type ConnectionProviderProps = {
  children: ReactNode;
  /** Defaults to secure storage on native and localStorage on web. */
  store?: KeyValueStore;
  /** Defaults to the global fetch; injectable for tests. */
  fetch?: typeof fetch;
};

export function ConnectionProvider({ children, store, fetch: fetchImpl }: ConnectionProviderProps) {
  const queryClient = useQueryClient();
  const [kv] = useState<KeyValueStore>(() => store ?? platformStore());
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [connection, setConnection] = useState<StoredConnection | null>(null);
  // The latest saved connection, for actions that run right after a save.
  const latest = useRef<StoredConnection | null>(null);
  const revision = useRef(0);
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  // One persistence owner orders every write. Refreshes are conditional on
  // the revision they read; user actions derive from the latest queued save.
  const commit = useCallback(
    (
      update: (saved: StoredConnection | null) => StoredConnection,
      expectedRevision?: number,
    ): Promise<void> => {
      if (expectedRevision !== undefined && revision.current !== expectedRevision) {
        return Promise.resolve();
      }
      const writeRevision = ++revision.current;
      const saved = pendingSave.current
        .catch(() => undefined)
        .then(async () => {
          if (expectedRevision !== undefined && revision.current !== writeRevision) return;
          const next = update(latest.current);
          await saveConnection(kv, next);
          latest.current = next;
          setConnection(next);
        });
      pendingSave.current = saved;
      return saved;
    },
    [kv],
  );

  useEffect(() => {
    let cancelled = false;
    loadConnection(kv)
      .catch(() => null)
      .then((loaded) => {
        if (cancelled) return;
        latest.current = loaded;
        setConnection(loaded);
        setStatus("ready");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [kv]);

  // Keep clients stable when refreshed profile metadata changes.
  const savedUrl = connection?.serverUrl ?? null;
  const savedToken = connection?.token ?? null;
  const savedProfileId = connection?.profile?.id ?? null;
  const clients = useMemo(() => {
    if (savedUrl === null || savedToken === null) return { client: null, deviceClient: null };
    const build = (memberId: string | null) =>
      createApiClient({ serverUrl: savedUrl, token: savedToken, memberId, fetch: fetchImpl });
    return { client: build(savedProfileId), deviceClient: build(null) };
  }, [fetchImpl, savedProfileId, savedToken, savedUrl]);

  useEffect(() => {
    if (!clients.client || !savedProfileId) return undefined;
    let cancelled = false;
    const readRevision = revision.current;
    void clients.client
      .me()
      .then(async (me) => {
        const profile = me.member ?? me.profiles.find((item) => item.id === savedProfileId);
        if (cancelled || !profile) return;
        await commit((saved) => {
          if (!saved) throw new Error("No saved connection");
          return { ...saved, profile: { ...profile, weight_unit: profile.weight_unit ?? "lb" } };
        }, readRevision);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clients.client, commit, savedProfileId]);

  const value = useMemo((): ConnectionContextValue => {
    const current = (): StoredConnection => {
      if (!latest.current) throw new Error("No saved connection");
      return latest.current;
    };
    const clientFor = (saved: StoredConnection, withMember: boolean): ApiClient =>
      createApiClient({
        serverUrl: saved.serverUrl,
        token: saved.token,
        memberId: withMember ? (saved.profile?.id ?? null) : null,
        fetch: fetchImpl,
      });

    return {
      status,
      serverUrl: connection?.serverUrl ?? null,
      hasToken: Boolean(connection?.token),
      profile: connection?.profile ?? null,
      client: clients.client,
      deviceClient: clients.deviceClient,
      saveServer: async (serverUrl, token) => {
        await commit((previous) => {
          const nextToken = token ?? previous?.token;
          if (!nextToken) throw new Error("A device token is required");
          return { serverUrl, token: nextToken, profile: null };
        });
        queryClient.clear();
      },
      replaceToken: async (token) => {
        // Check the new token before it replaces the saved one, so a mistyped
        // token can't lock out a working one. Only a 401 proves it wrong; for
        // any other failure it is saved and the error is passed on.
        const saved = current();
        const next = { ...saved, token };
        let failure: unknown = null;
        try {
          const client = clientFor(next, true);
          await client.health();
          await client.me();
        } catch (error) {
          if (error instanceof ApiError && error.kind === "unauthorized") throw error;
          failure = error;
        }
        await commit((latestSaved) => {
          if (
            !latestSaved ||
            latestSaved.serverUrl !== saved.serverUrl ||
            latestSaved.token !== saved.token
          ) {
            throw new Error("Connection changed while checking the token. Try again.");
          }
          return { ...latestSaved, token };
        });
        queryClient.clear();
        if (failure !== null) throw failure;
      },
      chooseProfile: (profile) =>
        commit((saved) => {
          if (!saved) throw new Error("No saved connection");
          return { ...saved, profile: { ...profile, weight_unit: profile.weight_unit ?? "lb" } };
        }),
      clearProfile: () =>
        commit((saved) => {
          if (!saved) throw new Error("No saved connection");
          return { ...saved, profile: null };
        }),
      verify: async () => {
        const saved = current();
        const readRevision = revision.current;
        const client = clientFor(saved, true);
        await client.health();
        const me = await client.me();
        const profile = me.member ?? me.profiles.find((item) => item.id === saved.profile?.id);
        if (profile) {
          await commit((latestSaved) => {
            if (!latestSaved) throw new Error("No saved connection");
            return {
              ...latestSaved,
              profile: { ...profile, weight_unit: profile.weight_unit ?? "lb" },
            };
          }, readRevision);
        }
        return me;
      },
    };
  }, [clients, commit, connection, fetchImpl, queryClient, status]);

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

/** The connection settings and actions. Must be inside ConnectionProvider. */
export function useConnection(): ConnectionContextValue {
  const value = useContext(ConnectionContext);
  if (!value) throw new Error("useConnection must be used inside ConnectionProvider");
  return value;
}

/** What a profile-scoped screen (workout, offline queue) needs. */
export type ProfileSession = {
  /** Sends the token and `X-Chotu-Member` for this profile. */
  client: ApiClient;
  profile: Profile;
  serverUrl: string;
  /** The profile's server-configured weight unit. */
  weightUnit: WeightUnit;
  /** Changes with the server or profile; put it in TanStack Query keys. */
  scope: string;
};

/**
 * The key for one server and profile. The offline set queue and the workout
 * query are kept per scope, so another server or profile never sees them.
 */
export function profileScope(serverUrl: string, profileId: string): string {
  return `${serverUrl}#${profileId}`;
}

/**
 * The ready client and settings for the chosen profile. Throws when no
 * profile is chosen; the `(main)` routes redirect before that can happen.
 */
export function useProfileSession(): ProfileSession {
  const connection = useConnection();
  const { client, profile, serverUrl } = connection;
  if (!client || !profile || !serverUrl) {
    throw new Error("useProfileSession needs a saved connection and a chosen profile");
  }
  return {
    client,
    profile,
    serverUrl,
    weightUnit: profile.weight_unit ?? "lb",
    scope: profileScope(serverUrl, profile.id),
  };
}
