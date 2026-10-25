/** What went wrong with an API call, by how the app should react. */
export type ApiErrorDetail =
  /** The server could not be reached (offline, Tailscale down, DNS). */
  | { kind: "network" }
  /** 401: the device token is missing, invalid or revoked. */
  | { kind: "unauthorized"; status: 401 }
  /** 403: this device may not act as the chosen profile. */
  | { kind: "forbidden"; status: 403 }
  /** 426: the app is older than the server supports. */
  | { kind: "updateRequired"; status: 426; minAppVersion: string | null }
  /** Any other 4xx: the server refused this request. */
  | { kind: "rejected"; status: number; message: string }
  /** 5xx, or a response the app cannot read. Safe to retry with the same key. */
  | { kind: "server"; status: number };

export type ApiErrorKind = ApiErrorDetail["kind"];

/**
 * A failed API call. Its message and fields never include the device token or
 * request headers, so it is safe to log or show.
 */
export class ApiError extends Error {
  readonly detail: ApiErrorDetail;

  constructor(detail: ApiErrorDetail, options?: { cause?: unknown }) {
    super(messageFor(detail), options);
    this.name = "ApiError";
    this.detail = detail;
  }

  get kind(): ApiErrorKind {
    return this.detail.kind;
  }
}

function messageFor(detail: ApiErrorDetail): string {
  switch (detail.kind) {
    case "network":
      return "Could not reach the server";
    case "unauthorized":
      return "Device token not accepted";
    case "forbidden":
      return "This device may not use that profile";
    case "updateRequired":
      return `App update required (minimum ${detail.minAppVersion ?? "unknown"})`;
    case "rejected":
      return `Request rejected (${detail.status}): ${detail.message}`;
    case "server":
      return `Server error (${detail.status})`;
    default: {
      const unhandled: never = detail;
      return unhandled;
    }
  }
}
