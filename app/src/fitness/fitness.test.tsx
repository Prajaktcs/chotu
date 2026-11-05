import Storage from "expo-sqlite/kv-store";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import type { WorkoutHistoryResponse } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

import SET_LOGGED from "../api/fixtures/set-logged.json";
import HISTORY from "../api/fixtures/workout-history.json";
import HISTORY_EMPTY from "../api/fixtures/workout-history-empty.json";
import TRENDS from "../api/fixtures/workout-trends.json";
import { dayLabel, localDate, shiftDate } from "@/food/format";

import { loadChange } from "./format";
import { pastSetTime } from "./past-workout-draft";

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
let logSet: () => Response;

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
  logSet = () => json(201, SET_LOGGED);
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/workout": () => json(200, { workout: null }),
    "GET /v1/workout/history": () => history(),
    "GET /v1/workout/trends": () => trends(),
    "POST /v1/workout/sets": () => logSet(),
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

  it("retries a failed older page rather than reloading the first", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/history" });
    history = () =>
      lastSearch("/v1/workout/history").get("before") === null
        ? json(200, HISTORY)
        : json(503, { error: "unavailable" });
    await fireEvent.press(await screen.findByRole("button", { name: "Load older workouts" }));
    expect(await screen.findByText(/Couldn't load workout history/)).toBeTruthy();
    history = () =>
      json(200, lastSearch("/v1/workout/history").get("before") === null ? HISTORY : OLDER);
    await fireEvent.press(screen.getByRole("button", { name: "Retry loading workout history" }));
    expect(await screen.findByText("1. 225 lb × 5")).toBeTruthy();
    expect(lastSearch("/v1/workout/history").get("before")).toBe("2026-10-23");
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

const sent = () => calls.filter((call) => call.method === "POST");

async function addSet(exercise: string, weight: string, reps: string) {
  await fireEvent.changeText(screen.getByTestId("past-exercise"), exercise);
  await fireEvent.changeText(screen.getByTestId("past-weight"), weight);
  await fireEvent.changeText(screen.getByTestId("past-reps"), reps);
  await fireEvent.press(screen.getByRole("button", { name: "Add set" }));
}

describe("log a past workout", () => {
  it("saves several sets to yesterday, in order, then returns to history", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/history" });
    await fireEvent.press(await screen.findByRole("button", { name: "Log a past workout" }));
    expect(await screen.findByRole("header", { name: "Yesterday" })).toBeTruthy();
    await addSet("deadlift", "135", "8");
    await fireEvent.press(screen.getByRole("button", { name: "Add set" }));
    await addSet("Pull-ups", "", "10");
    expect(screen.getAllByText("Deadlift · 135 lb × 8")).toHaveLength(2);
    expect(screen.getByText("Pull-ups · Bodyweight × 10")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Save sets" }));
    expect(await screen.findByRole("tab", { name: "History" })).toBeSelected();
    const yesterday = shiftDate(localDate(), -1);
    expect(sent().map((call) => call.body)).toEqual([
      {
        exercise: "Deadlift",
        weight: 135,
        unit: "lb",
        reps: 8,
        performed_at: pastSetTime(yesterday, 0),
      },
      {
        exercise: "Deadlift",
        weight: 135,
        unit: "lb",
        reps: 8,
        performed_at: pastSetTime(yesterday, 1),
      },
      {
        exercise: "Pull-ups",
        weight: null,
        unit: "lb",
        reps: 10,
        performed_at: pastSetTime(yesterday, 2),
      },
    ]);
    expect(pastSetTime(yesterday, 1)).toMatch(
      new RegExp(`^${yesterday}T12:00:01[+-]\\d\\d:\\d\\d$`),
    );
    const keys = sent().map((call) => call.headers["idempotency-key"]);
    expect(new Set(keys).size).toBe(3);
    expect(sent()[0]?.headers["x-chotu-member"]).toBe("alex");
  });

  it("offers yesterday back to six days ago, never today", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/log-past" });
    const today = localDate();
    expect(await screen.findByRole("header", { name: "Yesterday" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Later day" })).toBeDisabled();
    for (let back = 0; back < 5; back++) {
      // oxlint-disable-next-line no-await-in-loop -- one press at a time, in order
      await fireEvent.press(screen.getByRole("button", { name: "Earlier day" }));
    }
    expect(
      screen.getByRole("header", { name: dayLabel(shiftDate(today, -6), today) }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Earlier day" })).toBeDisabled();
  });

  it("checks the fields before adding a set", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/log-past" });
    await screen.findByRole("header", { name: "Yesterday" });
    await addSet("", "135", "8");
    expect(screen.getByText("Enter the exercise.")).toBeTruthy();
    await addSet("Squat", "lots", "8");
    expect(screen.getByText(/Enter a weight up to 1500 lb/)).toBeTruthy();
    await addSet("Squat", "135", "0");
    expect(screen.getByText("Enter 1–100 reps.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save sets" })).toBeDisabled();
  });

  it("keeps a set that may be saved, across leaving the screen, and resends it unchanged", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/log-past" });
    await screen.findByRole("header", { name: "Yesterday" });
    await addSet("Squat", "185", "5");
    await addSet("Squat", "185", "4");
    let sends = 0;
    logSet = () => {
      sends += 1;
      if (sends === 2) throw new TypeError("Network request failed");
      return json(201, SET_LOGGED);
    };
    await fireEvent.press(screen.getByRole("button", { name: "Save sets" }));
    expect(await screen.findByText(/Couldn't reach Chotu/)).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("Unconfirmed")).toBeTruthy();
    // It may be on the server: it can't be dropped, and its day can't move.
    expect(screen.queryByRole("button", { name: "Remove Squat · 185 lb × 4" })).toBeNull();
    expect(screen.getByRole("button", { name: "Earlier day" })).toBeDisabled();

    // Leaving and coming back keeps the draft and its request ids.
    await fireEvent.press(screen.getByRole("button", { name: "Back to history" }));
    await fireEvent.press(await screen.findByRole("button", { name: "Log a past workout" }));
    expect(await screen.findByText("Unconfirmed")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Save sets" }));
    expect(await screen.findByRole("tab", { name: "History" })).toBeSelected();
    const keys = sent().map((call) => call.headers["idempotency-key"]);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[1]);
    expect(sent()[2]?.body).toEqual(sent()[1]?.body);
  });

  it("discards the draft only after confirming", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/history" });
    await fireEvent.press(await screen.findByRole("button", { name: "Log a past workout" }));
    await screen.findByRole("header", { name: "Yesterday" });
    await addSet("Squat", "185", "5");
    await fireEvent.press(screen.getByRole("button", { name: "Discard sets" }));
    expect(screen.getByText(/Sets not saved yet are lost/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Confirm discard" }));
    await fireEvent.press(await screen.findByRole("button", { name: "Log a past workout" }));
    await screen.findByRole("header", { name: "Yesterday" });
    expect(screen.queryByText("Squat · 185 lb × 5")).toBeNull();
    expect(sent()).toHaveLength(0);
  });

  it("marks a set the server refuses and still sends the rest", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/log-past" });
    await screen.findByRole("header", { name: "Yesterday" });
    await addSet("Squat", "185", "5");
    await addSet("Bench", "135", "8");
    let sends = 0;
    logSet = () => {
      sends += 1;
      return sends === 1 ? json(422, { error: "exercise is not allowed" }) : json(201, SET_LOGGED);
    };
    await fireEvent.press(screen.getByRole("button", { name: "Save sets" }));
    expect(await screen.findByText(/Not saved: exercise is not allowed. Remove it/)).toBeTruthy();
    expect(sent()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save sets" })).toBeDisabled();
    await fireEvent.press(screen.getByRole("button", { name: "Remove Squat · 185 lb × 5" }));
    expect(screen.queryByText(/Not saved/)).toBeNull();
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

  it("keeps the last loaded range when another range fails", async () => {
    await renderRouter("./src/app", { initialUrl: "/fitness/trends" });
    expect(await screen.findByText("Oct 19 – Oct 26 · last 8 days")).toBeTruthy();
    trends = () => json(503, { error: "unavailable" });
    await fireEvent.press(screen.getByRole("radio", { name: "Last 90 days" }));
    expect(await screen.findByText(/Couldn't load training trends/)).toBeTruthy();
    expect(screen.getByText("Showing the last loaded trends.")).toBeTruthy();
    // Still labelled with the range it actually covers.
    expect(screen.getByText("Oct 19 – Oct 26 · last 8 days")).toBeTruthy();
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
