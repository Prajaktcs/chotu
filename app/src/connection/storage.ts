import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { Profile } from "@/api";

/** The async key-value store the connection settings persist to. */
export type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** Android/iOS: the OS keystore through expo-secure-store. */
export const secureStore: KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

type WebStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Web: browser storage (localStorage by default; null means none). It is not
 * a secret store; the web build is for development and for phones without
 * the APK.
 */
export function browserStore(storage?: WebStorage | null): KeyValueStore {
  const target = (): WebStorage | null => (storage === undefined ? localStorageOrNull() : storage);
  return {
    getItem: (key) => settle(() => target()?.getItem(key) ?? null),
    setItem: (key, value) => settle(() => target()?.setItem(key, value)),
    removeItem: (key) => settle(() => target()?.removeItem(key)),
  };
}

/**
 * Runs a synchronous storage call as a promise. Browser storage throws when
 * it is blocked or full; that becomes a rejection, as with the native stores,
 * so callers see one failure path.
 */
function settle<T>(run: () => T): Promise<T> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}

function localStorageOrNull(): WebStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Access throws when the browser blocks storage.
    return null;
  }
}

/** The store for this platform. */
export function platformStore(os: typeof Platform.OS = Platform.OS): KeyValueStore {
  return os === "web" ? browserStore() : secureStore;
}

/** Everything the app keeps about its connection. */
export type StoredConnection = {
  /** Normalised, e.g. `https://mini.ts.net:8787`. */
  serverUrl: string;
  token: string;
  /** The chosen profile, or null until one is picked. */
  profile: Profile | null;
};

// SecureStore keys allow only letters, digits, ".", "-" and "_".
export const TOKEN_KEY = "chotu.device_token";
export const SETTINGS_KEY = "chotu.connection";

type StoredSettings = {
  version: 1;
  serverUrl: string;
  profile: Profile | null;
};

/** Reads the saved connection, or null when there is none (or it is unreadable). */
export async function loadConnection(store: KeyValueStore): Promise<StoredConnection | null> {
  const [token, raw] = await Promise.all([store.getItem(TOKEN_KEY), store.getItem(SETTINGS_KEY)]);
  if (!token || !raw) return null;
  const settings = parseSettings(raw);
  if (!settings) return null;
  return { serverUrl: settings.serverUrl, token, profile: settings.profile };
}

/** Saves the connection. The token is stored under its own key. */
export async function saveConnection(
  store: KeyValueStore,
  connection: StoredConnection,
): Promise<void> {
  const settings: StoredSettings = {
    version: 1,
    serverUrl: connection.serverUrl,
    profile: connection.profile,
  };
  await store.setItem(TOKEN_KEY, connection.token);
  await store.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** Forgets the connection. */
export async function clearConnection(store: KeyValueStore): Promise<void> {
  await store.removeItem(TOKEN_KEY);
  await store.removeItem(SETTINGS_KEY);
}

function parseSettings(raw: string): StoredSettings | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== 1 || typeof value.serverUrl !== "string") return null;
  const profile: Profile | null = isProfile(value.profile)
    ? {
        id: value.profile.id,
        name: value.profile.name,
        weight_unit: value.profile.weight_unit === "kg" ? "kg" : "lb",
      }
    : null;
  return { version: 1, serverUrl: value.serverUrl, profile };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProfile(value: unknown): value is Profile {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}
