import type { Href } from "expo-router";

import type { Profile } from "@/api";

export {
  ConnectionProvider,
  type ConnectionProviderProps,
  type ConnectionContextValue,
  DEFAULT_WEIGHT_UNIT,
  type ProfileSession,
  profileScope,
  useConnection,
  useProfileSession,
} from "./connection-context";
export { messageForError, routeForApiError } from "./error-routes";
export { PendingSetCountProvider, pendingSetsLabel, usePendingSetCount } from "./pending";
export { normalizeServerUrl, type ServerUrlResult } from "./server-url";
export {
  browserStore,
  type KeyValueStore,
  platformStore,
  secureStore,
  type StoredConnection,
} from "./storage";
export { useAuthErrorRoute } from "./use-auth-error-route";
export { useReconnect } from "./use-reconnect";

/** Where launch goes: setup, then the profile picker, then the workout. */
export function homeRoute(state: { serverUrl: string | null; profile: Profile | null }): Href {
  if (!state.serverUrl) return "/setup";
  if (!state.profile) return "/profile";
  return "/workout";
}
