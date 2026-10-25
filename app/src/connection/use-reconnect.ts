import { type Href, useRouter } from "expo-router";
import { useState } from "react";

import { useConnection } from "./connection-context";
import { messageForError, routeForApiError } from "./error-routes";

export type Reconnect = {
  /** Re-checks the saved connection, then goes on or to the matching recovery screen. */
  reconnect(): Promise<void>;
  checking: boolean;
  /** A message for a failure with no recovery screen, shown in place. */
  error: string | null;
};

/**
 * Re-checks the saved connection (health, then /me). On success it replaces
 * the current screen with the workout (or the profile picker when no profile
 * is chosen); on failure with the recovery screen for the error.
 */
export function useReconnect(): Reconnect {
  const router = useRouter();
  const connection = useConnection();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reconnect = async () => {
    setChecking(true);
    setError(null);
    try {
      await connection.verify();
      const next: Href = connection.profile ? "/workout" : "/profile";
      router.dismissTo(next);
    } catch (failure) {
      const route = routeForApiError(failure);
      if (route) router.replace(route);
      else setError(messageForError(failure));
    } finally {
      setChecking(false);
    }
  };

  return { reconnect, checking, error };
}
