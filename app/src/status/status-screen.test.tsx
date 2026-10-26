import Storage from "expo-sqlite/kv-store";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import type { StatusResponse } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

/** The body the server returns for the fixture day in coordinator/src/api/status.rs tests. */
const STATUS: StatusResponse = {
  date: "2026-10-26",
  member: { id: "alex", name: "Alex" },
  activity: { steps: 8432, active_calories: 415, sleep_hours: 7.2, energy: 7 },
  exercises: ["Running (32 min, 310 kcal)", "Walking (20 min)"],
  fitness: {
    intent: "Run a 10k",
    target_date: "2025-06-01",
    days_to_target: -512,
    focus: "endurance",
  },
  nutrition: [
    { key: "calories", label: "Calories", amount: 1840, unit: "kcal", sub: false },
    { key: "protein", label: "Protein", amount: 121.2, unit: "g", sub: false },
    { key: "carbs", label: "Carbs", amount: 190.4, unit: "g", sub: false },
    { key: "fat", label: "Fat", amount: 61, unit: "g", sub: false },
    { key: "saturated_fat", label: "Saturated", amount: 18.5, unit: "g", sub: true },
  ],
  goals: [
    { key: "calories", label: "Calories", actual: 1840, goal: 2200, percent: 84, unit: "kcal" },
    { key: "steps", label: "Steps", actual: 8432, goal: 10000, percent: 84, unit: "" },
  ],
};

const EMPTY: StatusResponse = {
  ...STATUS,
  activity: { steps: 0, active_calories: 0, sleep_hours: null, energy: null },
  exercises: [],
  fitness: null,
  nutrition: [],
  goals: [],
};

let restoreFetch = () => {};
let calls: FetchCall[] = [];
let respond: () => Response = () => json(200, STATUS);

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
  respond = () => json(200, STATUS);
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/workout": () => json(200, { workout: null }),
    "GET /v1/status": () => respond(),
    "GET /v1/plan": () => json(200, { date: "2026-10-26", week_start: "2026-10-26", plan: null }),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => restoreFetch());

async function openStatus() {
  const router = await renderRouter("./src/app", { initialUrl: "/status" });
  return router;
}

it("shows Signal's numbers natively, with the member's auth", async () => {
  await openStatus();
  expect(await screen.findByText("MON, OCT 26 · Alex")).toBeTruthy();
  const request = calls.find((call) => call.path === "/v1/status");
  expect(request?.headers["x-chotu-member"]).toBe("alex");

  expect(screen.getByLabelText("Steps: 8432")).toBeTruthy();
  expect(screen.getByLabelText("Active energy: 415 kcal")).toBeTruthy();
  expect(screen.getByLabelText("Sleep: 7.2 h")).toBeTruthy();
  expect(screen.getByLabelText("Energy: 7/10")).toBeTruthy();
  expect(screen.getByText("Running (32 min, 310 kcal)")).toBeTruthy();

  expect(screen.getByLabelText("Calories: 1840 kcal")).toBeTruthy();
  expect(screen.getByLabelText("Protein: 121.2 g")).toBeTruthy();
  expect(screen.getByLabelText("Fat: 61.0 g")).toBeTruthy();
  expect(screen.getByLabelText("Of fat, Saturated: 18.5 g")).toBeTruthy();

  // Goals are text first; the bar only reinforces the percentage.
  expect(screen.getByText("1840 / 2200 kcal · 84%")).toBeTruthy();
  expect(screen.getByLabelText("Steps: 8432 / 10000 steps, 84%")).toBeTruthy();

  expect(screen.getByLabelText("Outcome: Run a 10k")).toBeTruthy();
  expect(screen.getByText("Target date 2025-06-01 was 512 days ago")).toBeTruthy();
  expect(screen.getByLabelText("Focus: endurance")).toBeTruthy();

  // Nothing is rendered as Markdown source (exact: false matches a substring).
  for (const marker of ["*", "```", "_No", "•"]) {
    expect(screen.queryByText(marker, { exact: false })).toBeNull();
  }
});

it("says when nothing is logged yet", async () => {
  respond = () => json(200, EMPTY);
  await openStatus();
  expect(await screen.findByRole("header", { name: "Nothing logged yet today" })).toBeTruthy();
  expect(screen.getByLabelText("Sleep: Not synced")).toBeTruthy();
  expect(screen.queryByRole("header", { name: "Nutrition" })).toBeNull();
  expect(screen.queryByRole("header", { name: "Goals" })).toBeNull();
});

it("offers Retry after a failed load, then shows the status", async () => {
  respond = () => json(503, { error: "unavailable" });
  await openStatus();
  expect(await screen.findByText(/Couldn't load today's status/)).toBeTruthy();
  respond = () => json(200, STATUS);
  await fireEvent.press(screen.getByRole("button", { name: "Retry loading status" }));
  expect(await screen.findByLabelText("Steps: 8432")).toBeTruthy();
  expect(screen.queryByText(/Couldn't load today's status/)).toBeNull();
});

it("sends a revoked token to its recovery screen", async () => {
  respond = () => json(401, { error: "missing or invalid device token" });
  const router = await openStatus();
  await waitFor(() => expect(router.getPathname()).toBe("/connection/token"));
});

it("is a bottom tab next to Workout, Plan and Tasks", async () => {
  const router = await openStatus();
  await screen.findByLabelText("Steps: 8432");
  expect(screen.getByRole("tab", { name: "Status" }).props.accessibilityState).toEqual({
    selected: true,
  });
  await fireEvent.press(screen.getByRole("tab", { name: "Plan" }));
  await waitFor(() => expect(router.getPathname()).toBe("/plan"));
  await fireEvent.press(await screen.findByRole("tab", { name: "Status" }));
  await waitFor(() => expect(router.getPathname()).toBe("/status"));
});
