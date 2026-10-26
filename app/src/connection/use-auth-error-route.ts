import { useRouter } from "expo-router";
import { useEffect } from "react";

import type { ApiError } from "@/api";

import { needsRecovery, routeForApiError } from "./error-routes";

/**
 * Opens the recovery screen for a 401, 403 or 426 among `errors` and returns
 * that error, so the screen doesn't also show it in place. Other errors are
 * left to the screen (it keeps its last loaded data and offers Retry).
 */
export function useAuthErrorRoute(errors: readonly unknown[]): ApiError | undefined {
  const router = useRouter();
  // The first 401, 403 or 426: those always have a recovery screen.
  const error = errors.find(needsRecovery);
  useEffect(() => {
    if (!error) return;
    const route = routeForApiError(error);
    if (route) router.replace(route);
  }, [error, router]);
  return error;
}
