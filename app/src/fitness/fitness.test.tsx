import Storage from "expo-sqlite/kv-store";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import type { WorkoutHistoryResponse } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

import HISTORY from "../api/fixtures/workout-history.json";
import HISTORY_EMPTY from "../api/fixtures/workout-history-empty.json";
import TRENDS from "../api/fixtures/workout-trends.json";
import { loadChange } from "./format";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

const OLDER: WorkoutHistoryResponse = {
  workouts: [
    {
      session_id: "older",
      date: "2026-10-16",
      closed: true,
      set_count: 1,
      exercises: [
        {
          name: "Deadlift",
          sets: [
            {
              id: "older-set",
              weight_lb: 225,
              weight: 225,
              unit: "lb",
              reps: 5,
              performed_at: "2026-10-16T13:00:00+00:00",
            },
          ],
        },
      ],
    },
  ],
  next_before: null,
};

let calls: FetchCall[] = [];
let restoreFetch = () => {};
let history: () => Response;
let trends: () => Response;

function lastSearch(path: string): URLSearchParams {
  return new URLSearchParams(calls.findLast((call) => call.path === path)?.search ?? "");
}

beforeEach(async () => {
  secure.reset();
  await Storage.clear();
  secure.items.set(TOKEN_KEY, "alex_phone.test-token");
  secure.items.set(
    SETTINGS_KEY,
    JSON.stringify({
      version: 1,
      serverUrl: "https://mini.ts.net:8787",
      profile: { id: "alex", name: "Alex" },
    }),
  );
  history = () =>
    json(200, lastSearch("/v1/workout/history").get("before") === null ? HISTORY : OLDER);
  trends = () => json(200, TRENDS);
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/workout": () => json(200, { workout: null }),
    "GET /v1/workout/history": () => history(),
    "GET /v1/workout/trends": () => trends(),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => restoreFetch());

describe("history", () => {
  it("lists recorded workouts with their sets, times and units, for the profile", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/history" });
    expect(await screen.findByRole("header", { name: "Mon, Oct 26 · In progress" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "History" })).toBeSelected();
    expect(screen.getByText("2 exercises · 2 sets")).toBeTruthy();
    expect(screen.getByText("1. 100.5 lb × 8")).toBeTruthy();
    expect(screen.getByText("1. Bodyweight × 12")).toBeTruthy();
    expect(screen.getByRole("header", { name: "Fri, Oct 23" })).toBeTruthy();
    expect(screen.getByText("2. 95 lb × 7")).toBeTruthy();
    const request = calls.find((call) => call.path === "/v1/workout/history");
    expect(request?.headers["x-chotu-member"]).toBe("alex");
    expect(request?.search).toBe("?days=10");
  });

  it("pages older workouts from next_before until the last page", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/history" });
    await fireEvent.press(await screen.findByRole("button", { name: "Load older workouts" }));
    expect(await screen.findByText("1. 225 lb × 5")).toBeTruthy();
    expect(lastSearch("/v1/workout/history").get("before")).toBe("2026-10-23");
    expect(screen.queryByRole("button", { name: "Load older workouts" })).toBeNull();
    expect(screen.getByText("That's every logged workout.")).toBeTruthy();
  });

  it("says when nothing is logged", async () => {
    history = () => json(200, HISTORY_EMPTY);
    await renderRouter("./src/app", { initialUrl: "/fitness/history" });
    expect(await screen.findByRole("header", { name: "No workouts logged yet" })).toBeTruthy();
  });

  it("explains a server without the history endpoint and retries", async () => {
    history = () => new Response("", { status: 404 });
    await renderRouter("./src/app", { initialUrl: "/fitness/history" });
    expect(await screen.findByText(/Update the Chotu server to see this/)).toBeTruthy();
    history = () => json(200, HISTORY);
    await fireEvent.press(screen.getByRole("button", { name: "Retry loading workout history" }));
    expect(await screen.findByText("1. 100.5 lb × 8")).toBeTruthy();
  });
});

describe("trends", () => {
  it("shows volume and per-exercise working sets for the chosen range", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/trends" });
    expect(await screen.findByText("Oct 19 – Oct 26 · last 8 days")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Trends" })).toBeSelected();
    expect(lastSearch("/v1/workout/trends").get("days")).toBe("28");
    expect(screen.getByText("2 workout days · 4 sets logged")).toBeTruthy();
    expect(screen.getByLabelText("Week of Mon, Oct 19: 1 workout day, 2 sets")).toBeTruthy();
    expect(screen.getByText("+5.5 lb top load")).toBeTruthy();
    expect(screen.getByLabelText("Fri, Oct 23: 95 lb × 8/7, 2 sets")).toBeTruthy();
    expect(
      screen.getByText("One session in this range. Log it again to see a trend."),
    ).toBeTruthy();

    await fireEvent.press(screen.getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(lastSearch("/v1/workout/trends").get("days")).toBe("7"));
    expect(screen.getByRole("radio", { name: "Last 7 days" })).toBeChecked();
  });

  it("says when the range has no training", async () => {
    trends = () => json(200, { ...TRENDS, workout_days: 0, sets: 0, exercises: [] });
    await renderRouter("./src/app", { initialUrl: "/fitness/trends" });
    expect(
      await screen.findByRole("header", { name: "No training in the last 8 days" }),
    ).toBeTruthy();
  });
});

const point = (top_weight: number | null) => ({
  date: "2026-10-26",
  top_weight_lb: top_weight,
  top_weight,
  unit: "kg" as const,
  reps: [8],
  sets: 1,
});

describe("loadChange", () => {
  it("compares first and latest top loads only with two weighted sessions", () => {
    expect(loadChange([point(60)])).toBeNull();
    expect(loadChange([point(60), point(null)])).toBeNull();
    expect(loadChange([point(60), point(62.5)])).toBe("+2.5 kg top load");
    expect(loadChange([point(62.5), point(60)])).toBe("−2.5 kg top load");
    expect(loadChange([point(60), point(60)])).toBe("Same top load (60 kg)");
  });
});
