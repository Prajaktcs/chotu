import { ApiError } from "@/api";

import { messageForError, needsRecovery, routeForApiError } from "./error-routes";

describe("needsRecovery", () => {
  it.each([
    [new ApiError({ kind: "unauthorized", status: 401 }), true],
    [new ApiError({ kind: "forbidden", status: 403 }), true],
    [new ApiError({ kind: "updateRequired", status: 426, minAppVersion: null }), true],
    [new ApiError({ kind: "network" }), false],
    [new ApiError({ kind: "server", status: 503 }), false],
    [new ApiError({ kind: "rejected", status: 422, message: "reps too high" }), false],
    [new Error("boom"), false],
  ])("is %s for %s", (error, expected) => {
    expect(needsRecovery(error)).toBe(expected);
  });
});

describe("routeForApiError", () => {
  it.each([
    [new ApiError({ kind: "network" }), "/connection/tailscale"],
    [new ApiError({ kind: "unauthorized", status: 401 }), "/connection/token"],
    [new ApiError({ kind: "forbidden", status: 403 }), "/connection/profile-denied"],
    [new ApiError({ kind: "server", status: 502 }), "/connection/unavailable"],
  ])("routes %s", (error, route) => {
    expect(routeForApiError(error)).toBe(route);
  });

  it("passes the required version to the update screen", () => {
    expect(
      routeForApiError(
        new ApiError({ kind: "updateRequired", status: 426, minAppVersion: "0.2.0" }),
      ),
    ).toEqual({ pathname: "/connection/update", params: { required: "0.2.0" } });
    expect(
      routeForApiError(new ApiError({ kind: "updateRequired", status: 426, minAppVersion: null })),
    ).toEqual({ pathname: "/connection/update", params: {} });
  });

  it("leaves rejections and other errors to the caller", () => {
    const rejected = new ApiError({ kind: "rejected", status: 422, message: "reps too high" });
    expect(routeForApiError(rejected)).toBeNull();
    expect(messageForError(rejected)).toBe("reps too high");
    expect(routeForApiError(new Error("boom"))).toBeNull();
    expect(messageForError(new Error("secret detail"))).toBe("Something went wrong. Try again.");
  });
});
