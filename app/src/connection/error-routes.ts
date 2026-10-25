import type { Href } from "expo-router";

import { ApiError } from "@/api";

/**
 * The recovery screen for a failed call, or null when the error has no
 * screen of its own (a 4xx rejection, or not an ApiError) and the caller
 * shows it in place.
 */
export function routeForApiError(error: unknown): Href | null {
  if (!(error instanceof ApiError)) return null;
  const detail = error.detail;
  switch (detail.kind) {
    case "network":
      return "/connection/tailscale";
    case "unauthorized":
      return "/connection/token";
    case "forbidden":
      return "/connection/profile-denied";
    case "updateRequired":
      return {
        pathname: "/connection/update",
        params: detail.minAppVersion ? { required: detail.minAppVersion } : {},
      };
    case "server":
      return "/connection/unavailable";
    case "rejected":
      return null;
    default: {
      const unhandled: never = detail;
      return unhandled;
    }
  }
}

/** A message safe to show for an error with no recovery screen. */
export function messageForError(error: unknown): string {
  if (error instanceof ApiError && error.detail.kind === "rejected") return error.detail.message;
  return "Something went wrong. Try again.";
}
