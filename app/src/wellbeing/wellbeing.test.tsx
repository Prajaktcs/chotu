import Storage from "expo-sqlite/kv-store";
import { cleanup, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { AppState } from "react-native";

import type { CheckinsResponse, ConditionsResponse, HealthTrendsResponse } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

import { comparisonText } from "./trends-screen";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");
const initialAppState = Object.getOwnPropertyDescriptor(AppState, "currentState");

const TODAY = "2026-10-28";
let conditions: ConditionsResponse;
let checkins: CheckinsResponse;
let trends: HealthTrendsResponse;
let write: (call: FetchCall) => Response = () => json(500, { error: "unexpected" });
let calls: FetchCall[] = [];
let restoreFetch = () => {};

const skin = {
  id: "skin",
  label: "Skin symptoms",
  check_in: true,
  lag_window: [1, 3] as [number, number],
  watchlist: ["dairy"],
};

beforeEach(async () => {
  Object.defineProperty(AppState, "currentState", { configurable: true, value: "active" });
  jest.useFakeTimers({ now: new Date(`${TODAY}T15:00:00`), doNotFake: ["nextTick"] });
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
  conditions = {
    conditions: [skin],
    tags: [
      { tag: "alcohol", label: "Alcohol", description: "beer, wine" },
      { tag: "dairy", label: "Dairy", description: "milk, cheese" },
    ],
  };
  checkins = {
    today: TODAY,
    from: "2026-10-21",
    to: TODAY,
    checkins: [{ date: "2026-10-27", condition_id: "skin", score: 2, note: "itchy" }],
  };
  trends = {
    from: "2026-10-01",
    to: TODAY,
    days: 28,
    thresholds: { timeline_checkins: 7, comparison_pairs: 10, sleep_caliper_hours: 0.5 },
    conditions: [
      {
        ...skin,
        checkins: 1,
        days: [
          { date: "2026-10-27", score: 2, sleep_hours: 7, watch_hits: [], food_covered: true },
        ],
        comparisons: [],
      },
    ],
  };
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/health/conditions": () => json(200, conditions),
    "GET /v1/health/checkins": () => json(200, checkins),
    "GET /v1/health/trends": () => json(200, trends),
    "PUT /v1/health/conditions/skin/watchlist/alcohol": () => write(calls.at(-1)!),
    "PUT /v1/health/checkins/2026-10-28/skin": () => write(calls.at(-1)!),
    "PUT /v1/health/checkins/2026-10-27/skin": () => write(calls.at(-1)!),
    "DELETE /v1/health/checkins/2026-10-27/skin": () => write(calls.at(-1)!),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(async () => {
  await cleanup();
  restoreFetch();
  jest.useRealTimers();
  if (initialAppState) Object.defineProperty(AppState, "currentState", initialAppState);
});

const writes = () => calls.filter((call) => call.method !== "GET");

it("opens from the drawer and shows today's check-in and the week", async () => {
  const router = await renderRouter("./src/app", { initialUrl: "/wellbeing" });
  expect(await screen.findByLabelText("Skin symptoms today: Not checked in")).toBeTruthy();
  expect(screen.getByText("·  ·  ·  ·  ·  2  ·")).toBeTruthy();
  expect(screen.getByText("dairy")).toBeTruthy();
  expect(calls.find((c) => c.path === "/v1/health/conditions")?.headers["x-chotu-member"]).toBe(
    "alex",
  );
  await fireEvent.press(screen.getByRole("button", { name: "Open check-ins" }));
  await waitFor(() => expect(router.getPathname()).toBe("/wellbeing/check-ins"));
});

it("says where conditions come from when none are set", async () => {
  conditions = { conditions: [], tags: [] };
  await renderRouter("./src/app", { initialUrl: "/wellbeing/check-ins" });
  expect(await screen.findByRole("header", { name: "No conditions set up" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
});

it("checks in today and clears an earlier day, with a key per write", async () => {
  write = (call) =>
    call.method === "DELETE"
      ? ((checkins = { ...checkins, checkins: [] }),
        json(200, { today: TODAY, from: "2026-10-27", to: "2026-10-27", checkins: [] }))
      : json(200, {
          today: TODAY,
          from: TODAY,
          to: TODAY,
          checkins: [{ date: TODAY, condition_id: "skin", score: 0 }],
        });
  await renderRouter("./src/app", { initialUrl: "/wellbeing/check-ins" });
  expect(await screen.findByRole("header", { name: "Today" })).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save Skin symptoms check-in" });
  expect(save).toBeDisabled();
  // Zero is a real score, not "skipped".
  await fireEvent.press(screen.getByRole("radio", { name: "Skin symptoms 0 of 5" }));
  await fireEvent.press(save);
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0]).toMatchObject({
    method: "PUT",
    path: `/v1/health/checkins/${TODAY}/skin`,
    body: { score: 0 },
  });

  await fireEvent.press(screen.getByRole("button", { name: "Previous day" }));
  expect(await screen.findByRole("header", { name: "Yesterday" })).toBeTruthy();
  expect(screen.getByText("Recorded: 2/5")).toBeTruthy();
  expect(screen.getByLabelText("Skin symptoms note (optional)").props.value).toBe("itchy");
  await fireEvent.press(screen.getByRole("button", { name: "Clear Skin symptoms check-in" }));
  await waitFor(() => expect(writes()).toHaveLength(2));
  expect(writes()[1]).toMatchObject({
    method: "DELETE",
    path: "/v1/health/checkins/2026-10-27/skin",
  });
  expect(writes()[1]?.headers["idempotency-key"]).not.toBe(writes()[0]?.headers["idempotency-key"]);
  // The cleared day reads as skipped, and its form no longer holds the old score.
  expect(await screen.findByText("Recorded: Not checked in")).toBeTruthy();
  expect(screen.getByRole("radio", { name: "Skin symptoms 2 of 5" })).not.toBeChecked();
  expect(screen.getByLabelText("Skin symptoms note (optional)").props.value).toBe("");
  expect(screen.getByRole("button", { name: "Save Skin symptoms check-in" })).toBeDisabled();
});

it("keeps an unanswered check-in for an unchanged retry", async () => {
  const answers = [
    json(503, { error: "unavailable" }),
    json(200, { today: TODAY, from: TODAY, to: TODAY, checkins: [] }),
  ];
  write = () => answers.shift() ?? json(500, { error: "unexpected" });
  await renderRouter("./src/app", { initialUrl: "/wellbeing/check-ins" });
  await fireEvent.press(await screen.findByRole("radio", { name: "Skin symptoms 4 of 5" }));
  await fireEvent.changeText(screen.getByLabelText("Skin symptoms note (optional)"), " flare ");
  await fireEvent.press(screen.getByRole("button", { name: "Save Skin symptoms check-in" }));
  expect(await screen.findByText("Couldn't save Skin symptoms check-in")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.queryByText("Couldn't save Skin symptoms check-in")).toBeNull(),
  );
  const [first, second] = writes();
  expect(first?.body).toEqual({ score: 4, note: "flare" });
  expect(second?.body).toEqual(first?.body);
  expect(second?.headers["idempotency-key"]).toBe(first?.headers["idempotency-key"]);
});

it("toggles a watchlist tag and shows the server's list", async () => {
  write = () => {
    conditions = { ...conditions, conditions: [{ ...skin, watchlist: ["alcohol", "dairy"] }] };
    return json(200, conditions);
  };
  await renderRouter("./src/app", { initialUrl: "/wellbeing/conditions" });
  const alcohol = await screen.findByRole("checkbox", { name: "Watch Alcohol for Skin symptoms" });
  expect(alcohol).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Watch Dairy for Skin symptoms" })).toBeChecked();
  await fireEvent.press(alcohol);
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "Watch Alcohol for Skin symptoms" })).toBeChecked(),
  );
  expect(writes()[0]).toMatchObject({
    method: "PUT",
    path: "/v1/health/conditions/skin/watchlist/alcohol",
  });
});

it("needs enough check-ins before a timeline, then describes without causation", async () => {
  await renderRouter("./src/app", { initialUrl: "/wellbeing/trends" });
  expect(await screen.findByText("1 of 7 check-ins needed for a timeline.")).toBeTruthy();
  expect(calls.find((c) => c.path === "/v1/health/trends")?.search).toBe("?days=28");

  const days = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${22 + i}`,
    score: i === 3 ? null : 2,
    sleep_hours: null,
    watch_hits: i === 1 ? ["dairy"] : [],
    food_covered: true,
  }));
  trends = {
    ...trends,
    from: "2026-10-22",
    days: 7,
    conditions: [{ ...skin, checkins: 7, days, comparisons: [] }],
  };
  await fireEvent.press(screen.getByRole("radio", { name: "Last 7 days" }));
  expect(await screen.findByText("2 2 2 · 2 2 2")).toBeTruthy();
  expect(screen.getByText("dairy: Fri, Oct 23")).toBeTruthy();
  expect(screen.getByText("Sleep on scored days: not recorded.")).toBeTruthy();
  expect(screen.getByText(/No association estimate: each group needs 10/)).toBeTruthy();
  expect(comparisonText({ tag: "dairy", difference: -1.25, pairs: 10 })).toMatch(
    /1\.3 points lower with dairy .* does not show cause\.$/,
  );
});
