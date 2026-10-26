import { useRouter } from "expo-router";
import { useEffect } from "react";

import { ApiError } from "@/api";

import { routeForApiError } from "./error-routes";

const AUTH_KINDS: ReadonlySet<string> = new Set(["unauthorized", "forbidden", "updateRequired"]);

/** The first 401, 403 or 426 among `errors`: those always have a recovery screen. */
function findAuthError(errors: readonly unknown[]): ApiError | undefined {
  return errors.find(
    (error): error is ApiError => error instanceof ApiError && AUTH_KINDS.has(error.kind),
  );
}

/**
 * Opens the recovery screen for a 401, 403 or 426 among `errors` and returns
 * that error, so the screen doesn't also show it in place. Other errors are
 * left to the screen (it keeps its last loaded data and offers Retry).
 */
export function useAuthErrorRoute(errors: readonly unknown[]): ApiError | undefined {
  const router = useRouter();
  const error = findAuthError(errors);
  useEffect(() => {
    if (!error) return;
    const route = routeForApiError(error);
    if (route) router.replace(route);
  }, [error, router]);
  return error;
}
