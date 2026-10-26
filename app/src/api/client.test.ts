import { createApiClient } from "./client";
import { ApiError } from "./errors";
import type { WorkoutResponse } from "./types";

const TOKEN = "alex_phone.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

type Call = { url: string; init: RequestInit };

function mockFetch(respond: () => Response) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init: init ?? {} });
    try {
      return Promise.resolve(respond());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { calls, fetch: fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch, memberId: string | null = "alex") {
  return createApiClient({
    serverUrl: "https://mini.example.ts.net:8787/",
    token: TOKEN,
    memberId,
    appVersion: "0.1.0",
    fetch: fetchImpl,
  });
}

/** Request headers with lowercase names, as the server sees them. */
function headersOf(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(call?.init.headers));
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

describe("createApiClient", () => {
  it("sends the token, member and app version on reads", async () => {
    const workout: WorkoutResponse = { workout: null };
    const { calls, fetch } = mockFetch(() => json(200, workout));

    await expect(client(fetch).workout()).resolves.toEqual(workout);

    expect(calls[0]?.url).toBe("https://mini.example.ts.net:8787/v1/workout");
    expect(calls[0]?.init.method).toBe("GET");
    expect(headersOf(calls[0])).toEqual({
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-chotu-member": "alex",
      "x-chotu-app-version": "0.1.0",
    });
  });

  it("omits X-Chotu-Member until a profile is chosen", async () => {
    const { calls, fetch } = mockFetch(() =>
      json(200, { device: "alex_phone", member: null, profiles: [] }),
    );

    await client(fetch, null).me();

    expect(headersOf(calls[0])).not.toHaveProperty("x-chotu-member");
  });

  it("sends no token or member to the health check", async () => {
    const health = { status: "ok", server_version: "0.1.0+abc", min_app_version: "0.1.0" };
    const { calls, fetch } = mockFetch(() => json(200, health));

    await expect(client(fetch).health()).resolves.toEqual(health);

    expect(headersOf(calls[0])).toEqual({
      accept: "application/json",
      "x-chotu-app-version": "0.1.0",
    });
  });

  it("posts a set as JSON with the caller's idempotency key", async () => {
    const { calls, fetch } = mockFetch(() => json(201, { set: {}, workout: {} }));
    const set = { exercise: "Bench press", weight: 135, unit: "lb", reps: 8 } as const;

    await client(fetch).logSet(set, "key-1");
    await client(fetch).logSet(set, "key-1");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://mini.example.ts.net:8787/v1/workout/sets");
      expect(call.init.method).toBe("POST");
      expect(call.init.body).toBe(JSON.stringify(set));
      expect(headersOf(call)).toMatchObject({
        "content-type": "application/json",
        "idempotency-key": "key-1",
      });
    }
  });

  it("finishes a workout and deletes a set with idempotency keys and no body", async () => {
    const { calls, fetch } = mockFetch(() => json(200, { exercises: [] }));

    await client(fetch).finishWorkout("key-done");
    await client(fetch).deleteSet("b0a7e5c2/1", "key-del");

    expect(calls[0]?.url).toBe("https://mini.example.ts.net:8787/v1/workout/done");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBeUndefined();
    expect(headersOf(calls[0])["idempotency-key"]).toBe("key-done");
    expect(headersOf(calls[0])).not.toHaveProperty("content-type");

    expect(calls[1]?.url).toBe("https://mini.example.ts.net:8787/v1/workout/sets/b0a7e5c2%2F1");
    expect(calls[1]?.init.method).toBe("DELETE");
    expect(headersOf(calls[1])["idempotency-key"]).toBe("key-del");
  });

  it.each([
    [401, { error: "missing or invalid device token" }, { kind: "unauthorized", status: 401 }],
    [403, { error: "member not allowed for this device" }, { kind: "forbidden", status: 403 }],
    [
      426,
      { error: "app update required", min_app_version: "0.2.0" },
      { kind: "updateRequired", status: 426, minAppVersion: "0.2.0" },
    ],
    [
      422,
      { error: "reps must be between 1 and 100" },
      { kind: "rejected", status: 422, message: "reps must be between 1 and 100" },
    ],
    [
      422,
      { error: "performed_at is more than 7 days old", code: "too_old" },
      {
        kind: "rejected",
        status: 422,
        message: "performed_at is more than 7 days old",
        code: "too_old",
      },
    ],
    [
      409,
      { error: "no open workout" },
      { kind: "rejected", status: 409, message: "no open workout" },
    ],
    [500, { error: "internal error" }, { kind: "server", status: 500 }],
  ])("maps %i to a typed error", async (status, body, detail) => {
    const { fetch } = mockFetch(() => json(status, body));

    const error = await apiError(client(fetch).workout());

    expect(error.detail).toEqual(detail);
    expect(error.kind).toBe(detail.kind);
  });

  it("maps a non-JSON gateway error to a server error", async () => {
    const { fetch } = mockFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }));

    expect((await apiError(client(fetch).workout())).detail).toEqual({
      kind: "server",
      status: 502,
    });
  });

  it("maps a 4xx without a JSON body to a rejection with the status", async () => {
    const { fetch } = mockFetch(() => new Response("", { status: 404 }));

    expect((await apiError(client(fetch).workout())).detail).toEqual({
      kind: "rejected",
      status: 404,
      message: "HTTP 404",
    });
  });

  it("maps a 426 without a body to an unknown minimum", async () => {
    const { fetch } = mockFetch(() => new Response("", { status: 426 }));

    expect((await apiError(client(fetch).workout())).detail).toEqual({
      kind: "updateRequired",
      status: 426,
      minAppVersion: null,
    });
  });

  it("maps a 200 that is not JSON to a server error", async () => {
    const { fetch } = mockFetch(() => new Response("captive portal", { status: 200 }));

    expect((await apiError(client(fetch).me())).kind).toBe("server");
  });

  it("maps a failed connection to a network error", async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError("Network request failed");
    });

    expect((await apiError(client(fetch).me())).detail).toEqual({ kind: "network" });
  });

  it.each([401, 403, 422, 426, 500])("never puts the token in a %i error", async (status) => {
    const { fetch } = mockFetch(() => json(status, { error: "nope" }));

    const error = await apiError(client(fetch).workout());

    const rendered = [
      error.message,
      String(error),
      error.stack ?? "",
      JSON.stringify(error),
      JSON.stringify(error.detail),
    ].join("\n");
    expect(rendered).not.toContain(TOKEN);
    expect(rendered).not.toContain("Bearer");
  });

  it("never puts the token in a network error", async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError("Network request failed");
    });

    const error = await apiError(client(fetch).workout());

    expect([error.message, String(error), JSON.stringify(error)].join("\n")).not.toContain(TOKEN);
  });
});
