import Storage from "expo-sqlite/kv-store";
import { fireEvent, renderRouter, screen, waitFor, within } from "expo-router/testing-library";
import { AppState } from "react-native";
import type * as ReactNative from "react-native";

import type { PlanResponse, WeekPlanDay, WorkoutResponse } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
jest.mock("@/workout/youtube-player", () => {
  const { View } = jest.requireActual<typeof ReactNative>("react-native");
  return { YouTubePlayer: () => <View testID="youtube-player" /> };
});
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");
const initialAppState = Object.getOwnPropertyDescriptor(AppState, "currentState");

const rest = (date: string, weekday: string): WeekPlanDay => ({
  date,
  weekday,
  kind: "rest",
  notes: "",
  is_today: false,
  exercises: [],
});

/** The fixture week from coordinator/src/status.rs, read on its Wednesday. */
const PLAN: PlanResponse = {
  date: "2026-10-28",
  week_start: "2026-10-26",
  plan: {
    theme: "Build the base",
    days: [
      {
        date: "2026-10-26",
        weekday: "Monday",
        kind: "strength",
        notes: "lower body",
        is_today: false,
        exercises: [
          { name: "Leg press", sets: 3, reps: "10-12" },
          {
            name: "Bench press",
            sets: 3,
            reps: "8-10",
            media: { type: "youtube", video_id: "SCVCLChPQFY" },
          },
        ],
      },
      {
        date: "2026-10-27",
        weekday: "Tuesday",
        kind: "cardio",
        notes: "easy pace",
        is_today: false,
        exercises: [{ name: "Easy run", sets: 1, reps: "30 min easy" }],
      },
      {
        date: "2026-10-28",
        weekday: "Wednesday",
        kind: "strength",
        notes: "full body, RPE 7",
        is_today: true,
        exercises: [
          { name: "Leg press", sets: 3, reps: "10-12" },
          { name: "Lat pulldown", sets: 3, reps: "8-12" },
          { name: "Plank", sets: 3, reps: "45s" },
        ],
      },
      rest("2026-10-29", "Thursday"),
      rest("2026-10-30", "Friday"),
      rest("2026-10-31", "Saturday"),
      rest("2026-11-01", "Sunday"),
    ],
    today: {
      weekday: "Wednesday",
      kind: "strength",
      notes: "full body, RPE 7",
      exercises: [
        {
          name: "Leg press",
          sets: 3,
          reps: "10-12",
          target: { weight_lb: 190, reps: [10, 10, 10], note: "+10 lb" },
        },
        {
          name: "Lat pulldown",
          sets: 3,
          reps: "8-12",
          target: {
            weight_lb: null,
            reps: [],
            note: "first time: pick a weight you can lift 12 times at RPE 7",
          },
        },
        { name: "Plank", sets: 3, reps: "45s", target: null },
      ],
    },
    progress: {
      sessions_matched: 2,
      sessions_planned: 3,
      cardio_minutes: 30,
      planned_cardio_minutes: 30,
    },
  },
};

const WORKOUT: WorkoutResponse = {
  date: "2026-10-28",
  workout: null,
  plan: {
    plan_day: { weekday: "Wednesday", kind: "strength", notes: "full body, RPE 7" },
    exercises: PLAN.plan?.today?.exercises ?? [],
  },
};

let restoreFetch = () => {};
let calls: FetchCall[] = [];
let respond: () => Response = () => json(200, PLAN);
let generate: () => Response = () => json(200, PLAN);

beforeEach(async () => {
  Object.defineProperty(AppState, "currentState", { configurable: true, value: "active" });
  jest.useFakeTimers({ now: new Date("2026-10-28T12:00:00"), doNotFake: ["nextTick"] });
  secure.reset();
  await Storage.clear();
  secure.items.set(TOKEN_KEY, "alex_phone.test-token");
  secure.items.set(
    SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      serverUrl: "https://mini.ts.net:8787",
      profile: { id: "alex", name: "Alex", weight_unit: "lb" },
    }),
  );
  respond = () => json(200, PLAN);
  generate = () => json(200, PLAN);
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/workout": () => json(200, WORKOUT),
    "GET /v1/plan": () => respond(),
    "POST /v1/plan": () => generate(),
    "POST /v1/plan/regenerate": () => generate(),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => {
  restoreFetch();
  jest.useRealTimers();
  if (initialAppState) Object.defineProperty(AppState, "currentState", initialAppState);
});

async function openPlan() {
  const router = await renderRouter("./src/app", { initialUrl: "/plan" });
  return router;
}

it("shows the week, today's targets and progress with Signal's numbers", async () => {
  await openPlan();
  expect(await screen.findByRole("header", { name: "Build the base" })).toBeTruthy();
  expect(calls.find((call) => call.path === "/v1/plan")?.headers["x-chotu-member"]).toBe("alex");
  expect(screen.getByText("Week of Mon, Oct 26")).toBeTruthy();

  expect(screen.getByText("2 of 3 planned sessions done")).toBeTruthy();
  expect(screen.getByText("30 min cardio logged")).toBeTruthy();

  const today = screen.getByTestId("plan-day-2026-10-28");
  expect(within(today).getByRole("header", { name: "Wednesday · Strength · Today" })).toBeTruthy();
  expect(within(today).getByText("Next: 190 lb · aim 10/10/10 · +10 lb")).toBeTruthy();
  expect(
    within(today).getByText("Next: first time: pick a weight you can lift 12 times at RPE 7"),
  ).toBeTruthy();
  expect(within(today).getByText("3 × 45s")).toBeTruthy();

  const monday = screen.getByTestId("plan-day-2026-10-26");
  expect(within(monday).getByRole("header", { name: "Monday · Strength" })).toBeTruthy();
  expect(within(monday).getByText("Mon, Oct 26 · lower body")).toBeTruthy();
  expect(within(screen.getByTestId("plan-day-2026-10-27")).getByText("30 min easy")).toBeTruthy();
  expect(within(screen.getByTestId("plan-day-2026-10-29")).getByText("Rest day")).toBeTruthy();

  for (const marker of ["*", "📌", "📊", "◦"]) {
    expect(screen.queryByText(marker, { exact: false })).toBeNull();
  }
});

it("links an exercise to the workout screen with it chosen", async () => {
  const router = await openPlan();
  const today = await screen.findByTestId("plan-day-2026-10-28");
  await fireEvent.press(
    within(today).getByRole("link", {
      name: "Lat pulldown. 3 × 8-12. Next: first time: pick a weight you can lift 12 times at RPE 7",
    }),
  );
  await waitFor(() => expect(router.getPathname()).toBe("/workout"));
  expect(await screen.findByRole("header", { name: "Lat pulldown" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Exercise 2 of 3. Change exercise" })).toBeTruthy();
});

it("links another day's exercise too, to log it today", async () => {
  const router = await openPlan();
  const monday = await screen.findByTestId("plan-day-2026-10-26");
  await fireEvent.press(within(monday).getByRole("link", { name: "Bench press. 3 × 8-10" }));
  await waitFor(() => expect(router.getPathname()).toBe("/workout"));
  expect(await screen.findByRole("header", { name: "Bench press" })).toBeTruthy();
});

it("watches another day's demo without selecting an exercise or starting a workout", async () => {
  const router = await openPlan();
  const monday = await screen.findByTestId("plan-day-2026-10-26");
  expect(screen.queryByTestId("youtube-player")).toBeNull();
  await fireEvent.press(within(monday).getByRole("button", { name: "Watch demo for Bench press" }));
  expect(await screen.findByRole("header", { name: "Bench press" })).toBeTruthy();
  expect(screen.getByTestId("youtube-player")).toBeTruthy();
  expect(router.getPathname()).toBe("/plan");
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  await fireEvent.press(screen.getByRole("button", { name: "Close demo" }));
  expect(screen.queryByTestId("youtube-player")).toBeNull();
  expect(router.getPathname()).toBe("/plan");
});

it.each([
  ["no_fitness_goals", "No fitness goals yet", /Add fitness_goals for Alex/],
  ["not_generated", "No plan this week yet", /saved fitness goals/],
  ["unreadable", "This week's plan can't be shown", /couldn't read the saved plan/],
] as const)("explains a missing plan (%s)", async (reason, title, body) => {
  respond = () => json(200, { date: "2026-10-28", week_start: "2026-10-26", plan: null, reason });
  await openPlan();
  expect(await screen.findByRole("header", { name: title })).toBeTruthy();
  expect(screen.getByText(body)).toBeTruthy();
});

it("offers Retry after a failed load and keeps the bottom navigation", async () => {
  respond = () => {
    throw new TypeError("Network request failed");
  };
  const router = await openPlan();
  expect(await screen.findByText(/Couldn't load this week's plan/)).toBeTruthy();
  respond = () => json(200, PLAN);
  await fireEvent.press(screen.getByRole("button", { name: "Retry loading plan" }));
  expect(await screen.findByRole("header", { name: "Build the base" })).toBeTruthy();
  await fireEvent.press(screen.getByRole("tab", { name: "Tasks" }));
  await waitFor(() => expect(router.getPathname()).toBe("/tasks"));
});

it("cancels replacement without sending a write or changing the visible plan", async () => {
  await openPlan();
  await screen.findByRole("header", { name: "Build the base" });
  await fireEvent.press(screen.getByRole("button", { name: "Regenerate plan" }));
  expect(screen.getByText("Your logged workouts will be kept.")).toBeTruthy();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  await fireEvent.press(screen.getByRole("button", { name: "Keep current plan" }));
  expect(screen.queryByRole("button", { name: "Replace plan" })).toBeNull();
  expect(screen.getByRole("header", { name: "Build the base" })).toBeTruthy();
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
});

it("confirms replacement before displaying the returned plan without opening Workout", async () => {
  generate = () => json(200, { ...PLAN, plan: { ...PLAN.plan, theme: "A fresh week" } });
  const router = await openPlan();
  await screen.findByRole("header", { name: "Build the base" });
  await fireEvent.press(screen.getByRole("button", { name: "Regenerate plan" }));
  await fireEvent.press(screen.getByRole("button", { name: "Replace plan" }));
  expect(await screen.findByRole("header", { name: "A fresh week" })).toBeTruthy();
  expect(screen.queryByRole("header", { name: "Build the base" })).toBeNull();
  expect(router.getPathname()).toBe("/plan");
  expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
    "/v1/plan/regenerate",
  ]);
});

it("generates an absent plan from saved goals", async () => {
  respond = () => json(200, { ...PLAN, plan: null, reason: "not_generated" });
  await openPlan();
  await fireEvent.press(await screen.findByRole("button", { name: "Generate plan" }));
  expect(await screen.findByRole("header", { name: "Build the base" })).toBeTruthy();
  expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
    "/v1/plan",
  ]);
});

it("keeps the saved plan on generation failure and offers an explicit retry", async () => {
  generate = () => {
    throw new TypeError("response lost");
  };
  await openPlan();
  await screen.findByRole("header", { name: "Build the base" });
  await fireEvent.press(screen.getByRole("button", { name: "Regenerate plan" }));
  await fireEvent.press(screen.getByRole("button", { name: "Replace plan" }));
  await screen.findByRole("button", { name: "Retry generating plan" });
  expect(screen.getByRole("header", { name: "Build the base" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Dismiss generation error" })).toBeNull();
  generate = () => json(200, PLAN);
  await fireEvent.press(screen.getByRole("button", { name: "Retry generating plan" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Retry generating plan" })).toBeNull(),
  );
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts[1]?.headers["idempotency-key"]).toBe(posts[0]?.headers["idempotency-key"]);
});
