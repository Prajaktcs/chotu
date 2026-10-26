import Storage from "expo-sqlite/kv-store";
import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import type { LoggedSet, PlannedExercise, Workout } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch, type Routes } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";

import { parseQueue, queueKey } from "./queue/set-queue";

jest.mock("expo-secure-store", () =>
  jest
    .requireActual<typeof import("@/test/secure-store-mock")>("@/test/secure-store-mock")
    .createSecureStoreMock(),
);

const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

const SERVER = "https://mini.ts.net:8787";
const TOKEN = "alex_phone.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SCOPE = `${SERVER}#alex`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

const bench: PlannedExercise = {
  name: "Bench press",
  sets: 3,
  reps: "8-10",
  target: { weight_lb: 135, reps: [9, 9, 8], note: null },
};
const squat: PlannedExercise = {
  name: "Squat",
  sets: 3,
  reps: "5",
  target: { weight_lb: 225, reps: [5, 5, 5], note: null },
};

type Body = { exercise: string; weight: number | null; unit: string; reps: number };

/** A coordinator stand-in that keeps today's workout and answers like the real one. */
function coordinator(
  sets: LoggedSet[] = [{ id: "a", exercise: "Bench press", weight_lb: 135, reps: 9 }],
) {
  const state: { workout: Workout | null } = {
    workout: {
      session_id: "s1",
      current_exercise: "Bench press",
      plan_day: { weekday: "Saturday", kind: "strength", notes: "Upper body" },
      exercises: [bench, squat],
      sets: [...sets],
    },
  };
  let next = 0;
  const routes: Routes = {
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/me": () => json(200, { device: "alex_phone", member: null, profiles: [] }),
    "GET /v1/workout": () => json(200, state),
    "POST /v1/workout/sets": (init) => {
      const body = bodyOf(init);
      const set: LoggedSet = {
        id: `n${(next += 1)}`,
        exercise: body.exercise,
        weight_lb:
          body.weight === null
            ? null
            : body.unit === "kg"
              ? body.weight * 2.20462262185
              : body.weight,
        reps: body.reps,
      };
      if (!state.workout) throw new Error("no workout in this fake");
      state.workout = { ...state.workout, sets: [...state.workout.sets, set] };
      return json(201, { set, workout: state.workout });
    },
    "POST /v1/workout/done": () => {
      const summary = {
        exercises: [{ name: "Bench press", sets: state.workout?.sets ?? [], next: null }],
      };
      state.workout = null;
      return json(200, summary);
    },
  };
  const remove = (id: string) => {
    if (!state.workout) return json(404, { error: "no such set" });
    const removed = state.workout.sets.find((set) => set.id === id);
    state.workout = { ...state.workout, sets: state.workout.sets.filter((set) => set.id !== id) };
    return json(200, { set: removed, workout: state.workout });
  };
  return { state, routes, remove };
}

let restoreFetch: () => void = () => undefined;
let calls: FetchCall[] = [];

function serve(routes: Routes) {
  restoreFetch();
  const mock = mockFetch(routes);
  calls = mock.calls;
  restoreFetch = mock.restore;
}

function bodies(method: string, path: string): unknown[] {
  return calls
    .filter((call) => call.method === method && call.path === path)
    .map((call) => call.body);
}

/** A set request body, checked field by field. */
function bodyOf(init: RequestInit): Body {
  const value: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (!isBody(value)) throw new Error("expected a set body");
  return value;
}

function isBody(value: unknown): value is Body {
  return (
    typeof value === "object" &&
    value !== null &&
    "exercise" in value &&
    typeof value.exercise === "string" &&
    "weight" in value &&
    (value.weight === null || typeof value.weight === "number") &&
    "unit" in value &&
    typeof value.unit === "string" &&
    "reps" in value &&
    typeof value.reps === "number"
  );
}

function saved(units: Record<string, string> = {}) {
  secure.items.set(TOKEN_KEY, TOKEN);
  secure.items.set(
    SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      serverUrl: SERVER,
      profile: {
        id: "alex",
        name: "Alex",
        weight_unit: units.alex ?? "lb",
      },
    }),
  );
}

async function storedQueue() {
  return parseQueue(await Storage.getItem(queueKey(SCOPE)));
}

const offline = () => {
  throw new TypeError("Network request failed");
};

async function openWorkout() {
  const router = await renderRouter("./src/app", { initialUrl: "/workout" });
  expect(await screen.findByRole("header", { name: "Bench press" })).toBeTruthy();
  return router;
}

/** Undo set 1 from Set actions while the server answers 500. */
async function undoFails() {
  await fireEvent.press(screen.getByRole("button", { name: "Set 1: 135 lb × 9. Saved" }));
  await fireEvent.press(
    await screen.findByRole("button", { name: "Undo set 1: Bench press, 135 lb × 9" }),
  );
  expect(await screen.findByText("Couldn't undo that set. Try again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Set 1: 135 lb × 9. Saved" })).toBeTruthy();
}

beforeEach(async () => {
  secure.reset();
  await Storage.clear();
  saved();
});

afterEach(() => {
  restoreFetch();
  jest.useRealTimers();
});

describe("workout screen", () => {
  it("uses the workout's kg unit while a legacy profile's metadata request is delayed", async () => {
    secure.items.set(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        serverUrl: SERVER,
        profile: { id: "alex", name: "Alex" },
        units: { alex: "lb" },
      }),
    );
    const kgTarget = {
      weight_lb: 132.277357308,
      weight: 60,
      unit: "kg" as const,
      reps: [8, 8, 8],
      note: null,
    };
    const server = coordinator([
      {
        id: "a",
        exercise: "Bench press",
        weight_lb: 132.277357308,
        weight: 60,
        unit: "kg",
        reps: 8,
      },
    ]);
    if (!server.state.workout) throw new Error("expected workout");
    server.state.workout.exercises = [{ ...bench, target: kgTarget }];
    serve(server.routes);
    const metadata = Promise.withResolvers<Response>();
    const routeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      (input instanceof Request ? input.url : input.toString()).endsWith("/v1/me")
        ? metadata.promise
        : routeFetch(input, init);
    await openWorkout();
    expect(screen.getByRole("button", { name: "Log set: Bench press, 60 kg × 8" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Increase weight" }));
    await fireEvent.press(
      screen.getByRole("button", { name: "Log set: Bench press, 62.5 kg × 8" }),
    );
    await waitFor(() => expect(bodies("POST", "/v1/workout/sets")).toHaveLength(1));
    expect(bodies("POST", "/v1/workout/sets")[0]).toMatchObject({
      weight: 62.5,
      unit: "kg",
      reps: 8,
    });
    await act(async () =>
      metadata.resolve(
        json(200, {
          member: { id: "alex", name: "Alex", weight_unit: "kg" },
          profiles: [{ id: "alex", name: "Alex", weight_unit: "kg" }],
        }),
      ),
    );
  });
  it("gates an unknown legacy unit until an old v1 metadata response confirms lb", async () => {
    secure.items.set(
      SETTINGS_KEY,
      JSON.stringify({
        version: 1,
        serverUrl: SERVER,
        profile: { id: "alex", name: "Alex" },
      }),
    );
    const server = coordinator();
    serve(server.routes);
    const metadata = Promise.withResolvers<Response>();
    const routeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      (input instanceof Request ? input.url : input.toString()).endsWith("/v1/me")
        ? metadata.promise
        : routeFetch(input, init);
    await renderRouter("./src/app", { initialUrl: "/workout" });
    expect(await screen.findByRole("button", { name: "Retry profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Log set:/ })).toBeNull();
    await act(async () =>
      metadata.resolve(
        json(200, {
          member: { id: "alex", name: "Alex" },
          profiles: [{ id: "alex", name: "Alex" }],
        }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Log set: Bench press, 135 lb × 9" }),
    ).toBeTruthy();
  });
  it("logs a set at the pre-filled target in one tap", async () => {
    const server = coordinator();
    serve(server.routes);
    await openWorkout();

    expect(screen.getByRole("button", { name: "Exercise 1 of 2. Change exercise" })).toBeTruthy();
    expect(screen.getByText("135 lb × 9")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" }));

    expect(await screen.findByRole("button", { name: "Set 2: 135 lb × 9. Saved" })).toBeTruthy();
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe("/v1/workout/sets");
    expect(posts[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "x-chotu-member": "alex",
      "content-type": "application/json",
    });
    expect(posts[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
    expect(bodies("POST", "/v1/workout/sets")).toEqual([
      {
        exercise: "Bench press",
        weight: 135,
        unit: "lb",
        reps: 9,
        performed_at: expect.stringMatching(RFC3339_WITH_OFFSET),
      },
    ]);
    // The next target moves on to set 3.
    expect(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 8" })).toBeTruthy();
    expect(await storedQueue()).toEqual([]);
  });

  it("shows the date and plan day", async () => {
    serve(coordinator().routes);
    await openWorkout();
    expect(screen.getByText(/ · Upper body$/)).toBeTruthy();
  });

  it("steps weight and reps in the profile's unit and sends that unit", async () => {
    saved({ alex: "kg" });
    serve(coordinator().routes);
    await openWorkout();

    expect(screen.getByText("61.2 kg × 9")).toBeTruthy();
    expect(screen.getByRole("adjustable", { name: "Weight" })).toHaveAccessibilityValue({
      text: "61 kg",
    });
    await fireEvent.press(screen.getByRole("button", { name: "Increase weight" }));
    await fireEvent.press(screen.getByRole("button", { name: "Decrease reps" }));
    expect(screen.getByRole("adjustable", { name: "Weight" })).toHaveAccessibilityValue({
      text: "62.5 kg",
    });
    expect(screen.getByRole("adjustable", { name: "Reps" })).toHaveAccessibilityValue({
      text: "8 reps",
    });

    await fireEvent.press(
      screen.getByRole("button", { name: "Log set: Bench press, 62.5 kg × 8" }),
    );

    await waitFor(() =>
      expect(bodies("POST", "/v1/workout/sets")).toEqual([
        expect.objectContaining({ weight: 62.5, unit: "kg", reps: 8 }),
      ]),
    );
  });

  it("pre-fills the chosen exercise's next target", async () => {
    serve(coordinator().routes);
    await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Exercise 1 of 2. Change exercise" }));
    expect(await screen.findByRole("button", { name: "Bench press · 1 of 3 sets" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Squat · 0 of 3 sets" }));

    expect(await screen.findByRole("header", { name: "Squat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exercise 2 of 2. Change exercise" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log set: Squat, 225 lb × 5" })).toBeTruthy();
  });

  it("logs a lift outside the plan by name", async () => {
    serve(coordinator().routes);
    await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Exercise 1 of 2. Change exercise" }));
    await fireEvent.changeText(await screen.findByLabelText("Other exercise"), "Pull-ups");
    await fireEvent.press(screen.getByRole("button", { name: "Use this exercise" }));

    expect(await screen.findByRole("header", { name: "Pull-ups" })).toBeTruthy();
    await fireEvent.press(
      screen.getByRole("button", { name: "Log set: Pull-ups, Bodyweight × 8" }),
    );
    await waitFor(() =>
      expect(bodies("POST", "/v1/workout/sets")).toEqual([
        expect.objectContaining({ exercise: "Pull-ups", weight: null, reps: 8 }),
      ]),
    );
  });

  it("resolves a typed lift to the planned name the server saves, so its rows stay", async () => {
    serve(coordinator().routes);
    await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Exercise 1 of 2. Change exercise" }));
    await fireEvent.changeText(await screen.findByLabelText("Other exercise"), "squ");
    await fireEvent.press(screen.getByRole("button", { name: "Use this exercise" }));

    expect(await screen.findByRole("header", { name: "Squat" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Log set: Squat, 225 lb × 5" }));
    expect(await screen.findByRole("button", { name: "Set 1: 225 lb × 5. Saved" })).toBeTruthy();
  });

  it("undoes a saved set on the server with an idempotency key", async () => {
    const server = coordinator();
    serve({ ...server.routes, "DELETE /v1/workout/sets/a": () => server.remove("a") });
    await openWorkout();

    await fireEvent(screen.getByRole("button", { name: "Set 1: 135 lb × 9. Saved" }), "longPress");
    expect(await screen.findByText("Bench press · Set 1")).toBeTruthy();
    expect(screen.getByText("135 lb × 9 · Saved")).toBeTruthy();
    await fireEvent.press(
      screen.getByRole("button", { name: "Undo set 1: Bench press, 135 lb × 9" }),
    );

    expect(await screen.findByText("No sets yet for this exercise.")).toBeTruthy();
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.headers["idempotency-key"]).toMatch(UUID_V4);
  });

  it("opens Set actions when a row is swiped", async () => {
    serve(coordinator().routes);
    const router = await openWorkout();

    await fireEvent(screen.getByTestId("set-row-1-swipe"), "swipeableOpen", "right");

    expect(await screen.findByText("Bench press · Set 1")).toBeTruthy();
    expect(router.getPathname()).toBe("/workout/set");
    // The same actions stay reachable without the gesture.
    await fireEvent.press(screen.getByRole("button", { name: "Keep set" }));
    expect(await screen.findByRole("button", { name: "Set 1: 135 lb × 9. Saved" })).toBeTruthy();
  });

  it("brings an undone set back when the server refuses, and reuses the key on retry", async () => {
    serve({
      ...coordinator().routes,
      "DELETE /v1/workout/sets/a": () => json(500, { error: "internal error" }),
    });
    await openWorkout();

    await undoFails();
    await undoFails();

    const keys = calls
      .filter((call) => call.method === "DELETE")
      .map((call) => call.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("shows Ready to train before the first set, then logging", async () => {
    serve(coordinator([]).routes);
    await renderRouter("./src/app", { initialUrl: "/workout" });

    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();
    expect(screen.getByText("3 sets · next target 135 lb × 9")).toBeTruthy();
    expect(screen.getByText("3 sets · next target 225 lb × 5")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Start workout" }));

    expect(
      await screen.findByRole("button", { name: "Log set: Bench press, 135 lb × 9" }),
    ).toBeTruthy();
  });

  it("shows today's plan before a workout is open, and the first set opens it", async () => {
    const server = coordinator([]);
    const planned = server.state.workout;
    if (!planned) throw new Error("expected a planned workout");
    server.state.workout = null;
    const plan = { plan_day: planned.plan_day, exercises: planned.exercises };
    serve({
      ...server.routes,
      "GET /v1/workout": () =>
        json(
          200,
          server.state.workout ? { workout: server.state.workout } : { workout: null, plan },
        ),
      "POST /v1/workout/sets": (init) => {
        // The first set opens the workout, as the coordinator does.
        server.state.workout ??= { ...planned, sets: [] };
        return server.routes["POST /v1/workout/sets"]!(init);
      },
    });
    await renderRouter("./src/app", { initialUrl: "/workout" });

    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();
    expect(screen.getByText(/· Upper body$/)).toBeTruthy();
    expect(screen.getByText("Bench press")).toBeTruthy();
    expect(screen.getByText("3 sets · next target 135 lb × 9")).toBeTruthy();
    expect(screen.getByText("3 sets · next target 225 lb × 5")).toBeTruthy();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);

    await fireEvent.press(screen.getByRole("button", { name: "Start workout" }));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Exercise 1 of 2. Change exercise" })).toBeTruthy();
    await fireEvent.press(
      await screen.findByRole("button", { name: "Log set: Bench press, 135 lb × 9" }),
    );

    expect(await screen.findByRole("button", { name: "Set 1: 135 lb × 9. Saved" })).toBeTruthy();
    expect(bodies("POST", "/v1/workout/sets")).toEqual([
      {
        exercise: "Bench press",
        weight: 135,
        unit: "lb",
        reps: 9,
        performed_at: expect.stringMatching(RFC3339_WITH_OFFSET),
      },
    ]);
  });

  it("pre-fills the plan's target in kg before a workout is open", async () => {
    saved({ alex: "kg" });
    const server = coordinator([]);
    const planned = server.state.workout;
    if (!planned) throw new Error("expected a planned workout");
    serve({
      ...server.routes,
      "GET /v1/workout": () =>
        json(200, {
          workout: null,
          plan: { plan_day: planned.plan_day, exercises: planned.exercises },
        }),
    });
    await renderRouter("./src/app", { initialUrl: "/workout" });

    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Start workout" }));
    expect(
      await screen.findByRole("button", { name: /^Log set: Bench press, [\d.]+ kg × 9$/ }),
    ).toBeTruthy();
  });

  it("offers no Done before a workout is open, only the way back to Ready to train", async () => {
    const server = coordinator([]);
    const planned = server.state.workout;
    if (!planned) throw new Error("expected a planned workout");
    serve({
      ...server.routes,
      "GET /v1/workout": () =>
        json(200, {
          workout: null,
          plan: { plan_day: planned.plan_day, exercises: planned.exercises },
        }),
    });
    await renderRouter("./src/app", { initialUrl: "/workout" });

    await fireEvent.press(await screen.findByRole("button", { name: "Start workout" }));
    expect(
      await screen.findByRole("button", { name: "Log set: Bench press, 135 lb × 9" }),
    ).toBeTruthy();
    // No workout is open yet: Done would only get a 409.
    expect(screen.queryByRole("button", { name: "Done: finish today's workout" })).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Back to Ready to train" }));
    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();
    expect(calls.filter((call) => call.path === "/v1/workout/done")).toEqual([]);
  });

  it("doesn't show yesterday's cached plan offline the next morning", async () => {
    const server = coordinator([]);
    const planned = server.state.workout;
    if (!planned) throw new Error("expected a planned workout");
    serve({
      ...server.routes,
      "GET /v1/workout": () =>
        json(200, {
          workout: null,
          plan: { plan_day: planned.plan_day, exercises: planned.exercises },
        }),
    });
    // Loaded yesterday (renderRouter keeps the fake clock's time)...
    const today = Date.now();
    jest.useFakeTimers();
    jest.setSystemTime(today - 24 * 60 * 60 * 1000);
    const router = await renderRouter("./src/app", { initialUrl: "/workout" });
    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();

    // ...and opened again this morning with no connection.
    jest.setSystemTime(today);
    serve({ "GET /v1/workout": offline });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    expect(await screen.findByRole("header", { name: "Connect to Tailscale" })).toBeTruthy();
    expect(router.getPathname()).toBe("/connection/tailscale");
    expect(screen.queryByRole("button", { name: "Start workout" })).toBeNull();
  });

  it("keeps an open workout on screen past midnight, offline", async () => {
    serve(coordinator().routes);
    const today = Date.now();
    jest.useFakeTimers();
    jest.setSystemTime(today - 24 * 60 * 60 * 1000);
    const router = await openWorkout();

    jest.setSystemTime(today);
    serve({ "GET /v1/workout": offline });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    expect(screen.getByRole("header", { name: "Bench press" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" })).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
  });

  it("loads today's plan after yesterday's failed load, not the recovery screen", async () => {
    const server = coordinator([]);
    const planned = server.state.workout;
    if (!planned) throw new Error("expected a planned workout");
    const plan = { plan_day: planned.plan_day, exercises: planned.exercises };
    const online = {
      ...server.routes,
      "GET /v1/workout": () => json(200, { date: "2026-10-24", workout: null, plan }),
    };
    serve(online);
    const today = Date.now();
    jest.useFakeTimers();
    jest.setSystemTime(today - 24 * 60 * 60 * 1000);
    const router = await renderRouter("./src/app", { initialUrl: "/workout" });
    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();
    // Yesterday evening a reload failed; the error stays on the query.
    serve({ "GET /v1/workout": offline });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    // This morning the server answers: the old error must not send us away.
    jest.setSystemTime(today);
    serve(online);
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
    expect(calls.filter((call) => call.path === "/v1/workout").length).toBeGreaterThan(0);
  });

  it("keeps the plan while the phone's day matches its load, whatever date the server names", async () => {
    const server = coordinator([]);
    const planned = server.state.workout;
    if (!planned) throw new Error("expected a planned workout");
    // The household is a day behind the phone (another timezone).
    serve({
      ...server.routes,
      "GET /v1/workout": () =>
        json(200, {
          date: "1999-01-01",
          workout: null,
          plan: { plan_day: planned.plan_day, exercises: planned.exercises },
        }),
    });
    const router = await renderRouter("./src/app", { initialUrl: "/workout" });
    expect(await screen.findByRole("header", { name: "Ready to train" })).toBeTruthy();

    serve({ "GET /v1/workout": offline });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Start workout" })).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
  });

  it("goes back to the workout home with a notice when the server closed the workout", async () => {
    const server = coordinator();
    serve(server.routes);
    await openWorkout();

    // Done elsewhere (or the idle close): no workout, and no plan.
    server.state.workout = null;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });

    expect(await screen.findByRole("header", { name: "No workout today" })).toBeTruthy();
    expect(
      screen.getByText("This workout was closed. A new set starts a new workout."),
    ).toBeTruthy();
    expect(calls.filter((call) => call.path === "/v1/workout/sets")).toEqual([]);
  });

  it("shows No workout today, and starts one from a named lift", async () => {
    serve({ ...coordinator().routes, "GET /v1/workout": () => json(200, { workout: null }) });
    await renderRouter("./src/app", { initialUrl: "/workout" });

    expect(await screen.findByRole("header", { name: "No workout today" })).toBeTruthy();
    expect(screen.getByText("You're up to date")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View weekly plan" })).toBeTruthy();
    expect(screen.queryByText(/View exercise demo/)).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Log a set: choose an exercise" }));
    await fireEvent.changeText(await screen.findByLabelText("Other exercise"), "Deadlift");
    await fireEvent.press(screen.getByRole("button", { name: "Use this exercise" }));

    expect(await screen.findByRole("header", { name: "Deadlift" })).toBeTruthy();
  });

  it("uses a new Done key after a definitive answer, and the same one after a transient one", async () => {
    const answers = [
      () => json(503, { error: "unavailable" }),
      () => json(409, { error: "no open workout" }),
      () => json(503, { error: "unavailable" }),
    ];
    serve({
      ...coordinator().routes,
      "POST /v1/workout/done": () => (answers.shift() ?? answers[0])?.() ?? json(500, {}),
    });
    await openWorkout();
    const done = screen.getByRole("button", { name: "Done: finish today's workout" });

    await fireEvent.press(done);
    expect(await screen.findByText("Couldn't finish the workout. Try again.")).toBeTruthy();
    await fireEvent.press(done);
    expect(await screen.findByText("Couldn't finish the workout. no open workout")).toBeTruthy();
    await fireEvent.press(done);
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "/v1/workout/done")).toHaveLength(3),
    );

    const keys = calls
      .filter((call) => call.path === "/v1/workout/done")
      .map((call) => call.headers["idempotency-key"]);
    // A 503 is retried with its key; the stored 409 isn't replayed forever.
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it("uses a new Done key once sets are logged after a failed Done", async () => {
    const answers = [() => json(503, { error: "unavailable" })];
    serve({
      ...coordinator().routes,
      "POST /v1/workout/done": () => answers.shift()?.() ?? json(500, {}),
    });
    await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Done: finish today's workout" }));
    expect(await screen.findByText("Couldn't finish the workout. Try again.")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: /^Log set:/ }));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "/v1/workout/sets")).toHaveLength(1),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Done: finish today's workout" }));
    await waitFor(() =>
      expect(calls.filter((call) => call.path === "/v1/workout/done")).toHaveLength(2),
    );

    const keys = calls
      .filter((call) => call.path === "/v1/workout/done")
      .map((call) => call.headers["idempotency-key"]);
    // The first Done may have closed the workout; the new set needs a fresh Done.
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("won't finish while the sets saved on this phone can't be read", async () => {
    const read = jest.spyOn(Storage, "getItem").mockRejectedValue(new Error("disk I/O error"));
    serve(coordinator().routes);
    await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Done: finish today's workout" }));

    expect(
      await screen.findByText("Sets saved on this phone couldn't be read yet. Try Done again."),
    ).toBeTruthy();
    expect(calls.filter((call) => call.path === "/v1/workout/done")).toHaveLength(0);
    read.mockRestore();
  });

  it("finishes the workout and says all sets are saved", async () => {
    serve(coordinator().routes);
    const router = await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Done: finish today's workout" }));

    expect(await screen.findByText("Upper body · Today")).toBeTruthy();
    expect(router.getPathname()).toBe("/workout/complete");
    expect(screen.getByText("1 set logged")).toBeTruthy();
    expect(screen.getByText("All sets saved")).toBeTruthy();
    const done = calls.find((call) => call.path === "/v1/workout/done");
    expect(done?.headers["idempotency-key"]).toMatch(UUID_V4);

    await fireEvent.press(screen.getByRole("button", { name: "Back to today" }));
    expect(await screen.findByRole("header", { name: "No workout today" })).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "View weekly plan" }));
    await waitFor(() => expect(router.getPathname()).toBe("/plan"));
  });

  it("opens the plan from Workout complete", async () => {
    serve(coordinator().routes);
    const router = await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Done: finish today's workout" }));
    expect(await screen.findByText("Upper body · Today")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "View plan" }));
    await waitFor(() => expect(router.getPathname()).toBe("/plan"));
  });
});

describe("offline queue on the workout screen", () => {
  it("keeps logging from the loaded workout while offline, with accessible pending state", async () => {
    const server = coordinator();
    serve(server.routes);
    const router = await openWorkout();

    serve({});
    globalThis.fetch = jest.fn(() => Promise.reject(new TypeError("Network request failed")));
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });
    await fireEvent.press(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" }));

    expect(await screen.findByText("◷ Pending")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set 2: 135 lb × 9. Pending" })).toBeTruthy();
    expect(await screen.findByText("Offline · 1 set pending")).toBeTruthy();
    expect(screen.getByText("Saved on this phone. Sends when connected.")).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
    expect(await storedQueue()).toHaveLength(1);

    await fireEvent.press(screen.getByRole("button", { name: "Review 1 pending set" }));
    expect(await screen.findByText("1 pending · kept on this phone until delivered")).toBeTruthy();
    expect(screen.getByText("◷ Pending · Bench press")).toBeTruthy();
  });

  it("undoes a pending set at once, and keeps the undo until the server confirms", async () => {
    serve({ ...coordinator().routes, "POST /v1/workout/sets": offline });
    await openWorkout();
    await fireEvent.press(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" }));
    const pendingRow = await screen.findByRole("button", { name: "Set 2: 135 lb × 9. Pending" });
    await waitFor(() => expect(calls.filter((call) => call.method === "POST")).toHaveLength(1));
    const before = calls.length;

    await fireEvent(pendingRow, "longPress");
    expect(await screen.findByText(/Pending since/)).toBeTruthy();
    await fireEvent.press(
      screen.getByRole("button", { name: "Undo set 2: Bench press, 135 lb × 9" }),
    );

    await waitFor(() => expect(screen.queryByText("◷ Pending")).toBeNull());
    // Its send was attempted, so the server may have it: the undo stays on the
    // phone (hidden) until a replay finds out and deletes it.
    expect(calls.slice(before).filter((call) => call.method === "DELETE")).toEqual([]);
    expect(await storedQueue()).toEqual([
      expect.objectContaining({ undo: expect.objectContaining({ deleteKey: expect.any(String) }) }),
    ]);
  });

  it("says why when the server refuses to delete an undone queued set", async () => {
    // Undone in an earlier run, after its send landed as set "old".
    const undone = {
      requestId: "00000000-0000-4000-8000-000000000001",
      exercise: "Bench press",
      weight: 135,
      unit: "lb",
      reps: 9,
      performedAt: "2026-10-17T09:31:00-04:00",
      status: "pending",
      sent: true,
      undo: { deleteKey: "delete-key", setId: "old" },
    };
    await Storage.setItem(queueKey(SCOPE), JSON.stringify({ version: 1, items: [undone] }));
    const server = coordinator();
    serve({
      ...server.routes,
      "DELETE /v1/workout/sets/old": () => json(404, { error: "set not found" }),
      "DELETE /v1/workout/sets/a": () => server.remove("a"),
    });

    await openWorkout();

    const problem =
      "Couldn't undo Bench press 135 lb × 9: it's more than 7 days old. It may still be saved.";
    expect(await screen.findByText(problem)).toBeTruthy();
    expect(await storedQueue()).toEqual([]);

    // Another undo starts with a clean slate of its own messages, but never
    // wipes the queue's before it is dismissed.
    await fireEvent.press(screen.getByRole("button", { name: "Set 1: 135 lb × 9. Saved" }));
    await fireEvent.press(
      await screen.findByRole("button", { name: "Undo set 1: Bench press, 135 lb × 9" }),
    );
    expect(await screen.findByText("No sets yet for this exercise.")).toBeTruthy();
    expect(screen.getByText(problem)).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Dismiss message" }));
    await waitFor(() => expect(screen.queryByText(problem)).toBeNull());
  });

  it("shows a rejected set as failed with the server's reason", async () => {
    serve({
      ...coordinator().routes,
      "POST /v1/workout/sets": () => json(422, { error: "performed_at is more than 7 days old" }),
    });
    await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" }));

    expect(await screen.findByText("! Failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set 2: 135 lb × 9. Failed" })).toBeTruthy();
    expect(screen.getByText("1 set needs attention")).toBeTruthy();
    expect(screen.getByText("Not saved: performed_at is more than 7 days old")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Review failed set" }));
    expect(await screen.findByText("performed_at is more than 7 days old")).toBeTruthy();
    expect(screen.getByText("Rejected sets are never silently dropped.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry unchanged: same set and time" })).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Remove failed set" }));

    expect(await screen.findByRole("header", { name: "Bench press" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("! Failed")).toBeNull());
    expect(await storedQueue()).toEqual([]);
  });

  it("doesn't finish while a set is waiting to send, and says why", async () => {
    serve({
      ...coordinator().routes,
      "POST /v1/workout/sets": () => json(503, { error: "unavailable" }),
    });
    const router = await openWorkout();
    await fireEvent.press(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" }));
    expect(await screen.findByText("◷ Pending")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Done: finish today's workout" }));

    expect(await screen.findByText("1 set waiting to send. Done when they're sent.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review 1 pending set" })).toBeTruthy();
    expect(router.getPathname()).toBe("/workout");
    // The workout stays open, so the set joins it when it lands.
    expect(calls.filter((call) => call.path === "/v1/workout/done")).toEqual([]);
    expect(await storedQueue()).toHaveLength(1);
  });

  it("doesn't finish while a failed set is on this phone", async () => {
    serve({
      ...coordinator().routes,
      "POST /v1/workout/sets": () => json(422, { error: "performed_at is more than 7 days old" }),
    });
    await openWorkout();
    await fireEvent.press(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" }));
    expect(await screen.findByText("! Failed")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Done: finish today's workout" }));

    expect(
      await screen.findByText("1 set not saved. Retry or remove it before Done."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review failed set" })).toBeTruthy();
    expect(calls.filter((call) => call.path === "/v1/workout/done")).toEqual([]);
  });

  it("stops on a 401, opens the token screen, and keeps the queue", async () => {
    serve({
      ...coordinator().routes,
      "POST /v1/workout/sets": () => json(401, { error: "missing or invalid device token" }),
    });
    const router = await openWorkout();

    await fireEvent.press(screen.getByRole("button", { name: "Log set: Bench press, 135 lb × 9" }));

    expect(await screen.findByRole("header", { name: "Token not accepted" })).toBeTruthy();
    expect(router.getPathname()).toBe("/connection/token");
    expect(await storedQueue()).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("sends sets queued before a restart once the server is back", async () => {
    // Two sets tapped offline in an earlier run of the app.
    const queued = [1, 2].map((n) => ({
      requestId: `00000000-0000-4000-8000-00000000000${n}`,
      exercise: "Bench press",
      weight: 135,
      unit: "lb",
      reps: 9,
      performedAt: `2026-10-24T09:3${n}:00-04:00`,
      status: "pending",
    }));
    await Storage.setItem(queueKey(SCOPE), JSON.stringify({ version: 1, items: queued }));
    serve(coordinator().routes);

    await openWorkout();

    await waitFor(async () => expect(await storedQueue()).toEqual([]));
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((post) => post.headers["idempotency-key"])).toEqual(
      queued.map((item) => item.requestId),
    );
    expect(bodies("POST", "/v1/workout/sets")).toEqual(
      queued.map((item) => expect.objectContaining({ performed_at: item.performedAt })),
    );
    expect(await screen.findByRole("button", { name: "Set 3: 135 lb × 9. Saved" })).toBeTruthy();
  });

  it("goes to Connect to Tailscale when no workout was ever loaded", async () => {
    serve({ "GET /v1/workout": offline });
    const router = await renderRouter("./src/app", { initialUrl: "/workout" });

    expect(await screen.findByRole("header", { name: "Connect to Tailscale" })).toBeTruthy();
    expect(router.getPathname()).toBe("/connection/tailscale");
  });

  it("shows Connect to load your workout after Keep logging offline", async () => {
    serve({
      "GET /v1/workout": () => new Response("Bad Gateway", { status: 502 }),
    });
    await renderRouter("./src/app", { initialUrl: "/workout" });
    expect(await screen.findByRole("header", { name: "Server unavailable" })).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Keep logging offline" }));

    expect(
      await screen.findByRole("header", { name: "Connect to load your workout" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
