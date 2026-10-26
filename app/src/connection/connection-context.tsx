import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
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

export const DEFAULT_WEIGHT_UNIT: WeightUnit = "lb";

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
  /** The weight unit for a profile id (default `lb`). */
  weightUnitFor(profileId: string): WeightUnit;
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
  setWeightUnit(profileId: string, unit: WeightUnit): Promise<void>;
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

  // Clients change only with the server, token or profile, so an unrelated
  // change (a weight unit) doesn't hand screens and the set queue new ones.
  const savedUrl = connection?.serverUrl ?? null;
  const savedToken = connection?.token ?? null;
  const savedProfileId = connection?.profile?.id ?? null;
  const clients = useMemo(() => {
    if (savedUrl === null || savedToken === null) return { client: null, deviceClient: null };
    const build = (memberId: string | null) =>
      createApiClient({ serverUrl: savedUrl, token: savedToken, memberId, fetch: fetchImpl });
    return { client: build(savedProfileId), deviceClient: build(null) };
  }, [fetchImpl, savedProfileId, savedToken, savedUrl]);

  const value = useMemo((): ConnectionContextValue => {
    const commit = async (next: StoredConnection) => {
      await saveConnection(kv, next);
      latest.current = next;
      setConnection(next);
    };
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
      weightUnitFor: (profileId) => connection?.units[profileId] ?? DEFAULT_WEIGHT_UNIT,
      client: clients.client,
      deviceClient: clients.deviceClient,
      saveServer: async (serverUrl, token) => {
        const previous = latest.current;
        const nextToken = token ?? previous?.token;
        if (!nextToken) throw new Error("A device token is required");
        await commit({ serverUrl, token: nextToken, profile: null, units: previous?.units ?? {} });
        queryClient.clear();
      },
      replaceToken: async (token) => {
        // Check the new token before it replaces the saved one, so a mistyped
        // token can't lock out a working one. Only a 401 proves it wrong; for
        // any other failure it is saved and the error is passed on.
        const next = { ...current(), token };
        let failure: unknown = null;
        try {
          const client = clientFor(next, true);
          await client.health();
          await client.me();
        } catch (error) {
          if (error instanceof ApiError && error.kind === "unauthorized") throw error;
          failure = error;
        }
        await commit(next);
        queryClient.clear();
        if (failure !== null) throw failure;
      },
      chooseProfile: (profile) =>
        commit({ ...current(), profile: { id: profile.id, name: profile.name } }),
      clearProfile: () => commit({ ...current(), profile: null }),
      setWeightUnit: (profileId, unit) => {
        const saved = current();
        return commit({ ...saved, units: { ...saved.units, [profileId]: unit } });
      },
      verify: async () => {
        const client = clientFor(current(), true);
        await client.health();
        return client.me();
      },
    };
  }, [clients, connection, fetchImpl, kv, queryClient, status]);

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
  /** The profile's weight unit on this phone. */
  weightUnit: WeightUnit;
  setWeightUnit(unit: WeightUnit): Promise<void>;
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
    weightUnit: connection.weightUnitFor(profile.id),
    setWeightUnit: (unit) => connection.setWeightUnit(profile.id, unit),
    scope: profileScope(serverUrl, profile.id),
  };
}
