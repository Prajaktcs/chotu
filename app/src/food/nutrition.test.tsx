import Storage from "expo-sqlite/kv-store";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { AppState } from "react-native";

import type { FoodDayResponse } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

import STATUS from "../api/fixtures/status.json";
import TRENDS from "../api/fixtures/food-trends.json";
import { parseTotals } from "./food-screen";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");
const initialAppState = Object.getOwnPropertyDescriptor(AppState, "currentState");

const TODAY = "2026-10-28";
const MEALS: FoodDayResponse = {
  date: TODAY,
  meals: [
    {
      id: "lunch",
      revision: 0,
      eaten_at: "2026-10-28T12:30:00Z",
      description: "Dal and rice",
      calories: 450,
      protein_g: 20,
      carbs_g: 30,
      fat_g: 10,
    },
  ],
};
const WITH_GOALS = {
  ...STATUS,
  goals: [
    ...STATUS.goals,
    { key: "calories", label: "Calories", actual: 1840, goal: 2200, percent: 84, unit: "kcal" },
  ],
};

let calls: FetchCall[] = [];
let restoreFetch = () => {};
let status: () => Response;
let dayWrite: () => Response;
let foodAnswer: () => Response;

beforeEach(async () => {
  Object.defineProperty(AppState, "currentState", { configurable: true, value: "active" });
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
  status = () => json(200, WITH_GOALS);
  dayWrite = () => json(200, { date: TODAY, meals: [] });
  foodAnswer = () => json(200, MEALS);
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/food": () => foodAnswer(),
    "GET /v1/status": () => status(),
    "GET /v1/food/trends": () => json(200, TRENDS),
    "POST /v1/food/clear": () => dayWrite(),
    "POST /v1/food/adjust": () => dayWrite(),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => {
  restoreFetch();
  if (initialAppState) Object.defineProperty(AppState, "currentState", initialAppState);
});

const writes = () => calls.filter((call) => call.method !== "GET");
const confirm = () =>
  screen.getByRole("button", { name: "Confirm replace today's meals with totals" });
const totals = (calories: string, protein = "1", carbs = "1", fat = "1") =>
  parseTotals({ calories, protein_g: protein, carbs_g: carbs, fat_g: fat });

describe("Today", () => {
  it("shows the household's today with Signal's totals and goals", async () => {
    await renderRouter("./src/app", { initialUrl: "/food" });
    expect(await screen.findByText("Dal and rice")).toBeTruthy();
    expect(calls.find((call) => call.path === "/v1/food")?.search).toBe("");
    expect(screen.getByRole("tab", { name: "Today" })).toBeSelected();
    expect(await screen.findByLabelText("Protein: 42.5 g")).toBeTruthy();
    expect(screen.getByLabelText(/^Calories: 1840/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Previous day" })).toBeNull();
  });

  it("keeps Today's writes off until the household date has loaded", async () => {
    foodAnswer = () => json(503, { error: "unavailable" });
    await renderRouter("./src/app", { initialUrl: "/food" });
    await fireEvent.changeText(await screen.findByLabelText(/What did you eat/), "toast");
    expect(await screen.findByText(/Couldn't load meals/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Add meal/ })).toBeDisabled();
    foodAnswer = () => json(200, MEALS);
    await fireEvent.press(screen.getByRole("button", { name: "Retry loading meals" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Add meal/ })).toBeEnabled());
  });

  it("clears today's meals after confirming, with the household date", async () => {
    await renderRouter("./src/app", { initialUrl: "/food" });
    await fireEvent.press(await screen.findByRole("button", { name: "Clear today's meals" }));
    expect(screen.getByText(/Removes today's 1 logged meal/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Confirm clear today's meals" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ path: "/v1/food/clear", body: { date: TODAY } });
    expect(writes()[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(screen.queryByText("Dal and rice")).toBeNull());
  });

  it("retries a clear the server may have started with the same request", async () => {
    dayWrite = () =>
      json(502, {
        error: "meal deletion is still pending; retry to finish it",
        code: "deletion_pending",
      });
    await renderRouter("./src/app", { initialUrl: "/food" });
    await fireEvent.press(await screen.findByRole("button", { name: "Clear today's meals" }));
    await fireEvent.press(screen.getByRole("button", { name: "Confirm clear today's meals" }));
    expect(await screen.findByText("Couldn't clear today's meals")).toBeTruthy();
    // The server's state-specific reason is shown, not a generic error.
    expect(screen.getByText("meal deletion is still pending; retry to finish it")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    dayWrite = () => json(200, { date: TODAY, meals: [] });
    foodAnswer = () => json(200, MEALS);
    await fireEvent.press(screen.getByRole("button", { name: "Retry clear meal" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]!.headers["idempotency-key"]).toBe(writes()[0]!.headers["idempotency-key"]);
  });

  it("replaces today's meals with entered totals", async () => {
    await renderRouter("./src/app", { initialUrl: "/food" });
    await fireEvent.press(await screen.findByRole("button", { name: "Set today's totals" }));
    expect(confirm()).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText("Calories (kcal)"), "2000");
    await fireEvent.changeText(screen.getByLabelText("Protein (g)"), "150");
    await fireEvent.changeText(screen.getByLabelText("Carbs (g)"), "200");
    await fireEvent.changeText(screen.getByLabelText("Fat (g)"), "60.5");
    await fireEvent.press(confirm());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      path: "/v1/food/adjust",
      body: { date: TODAY, calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 60.5 },
    });
  });
});

describe("Goals and Trends", () => {
  it("shows configured nutrition goals read-only, and says when there are none", async () => {
    await renderRouter("./src/app", { initialUrl: "/food/goals" });
    expect(await screen.findByLabelText(/^Calories: 1840 \/ 2200 kcal/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Steps:/)).toBeNull();
    expect(screen.getByText(/config.yaml \(nutrition_goals\)/)).toBeTruthy();
  });

  it("says when no goals are set", async () => {
    status = () => json(200, STATUS);
    await renderRouter("./src/app", { initialUrl: "/food/goals" });
    expect(await screen.findByRole("header", { name: "No goals set" })).toBeTruthy();
  });

  it("averages days with a summary against the goals", async () => {
    await renderRouter("./src/app", { initialUrl: "/food/trends" });
    expect(await screen.findByText("Oct 21 – Oct 27 · 2 of 7 days with a summary")).toBeTruthy();
    expect(screen.getByLabelText("Calories: 2075 kcal of 2200 kcal goal")).toBeTruthy();
    expect(screen.getByLabelText("Carbs: 210 g")).toBeTruthy();
    expect(screen.getByLabelText("Tue, Oct 27: 2310 kcal, 160 grams protein")).toBeTruthy();
    expect(calls.find((call) => call.path === "/v1/food/trends")?.search).toBe("?days=28");
  });
});

describe("parseTotals", () => {
  it("accepts what the server accepts", () => {
    expect(totals("2000")).toEqual({ calories: 2000, protein_g: 1, carbs_g: 1, fat_g: 1 });
    expect(totals("20001")).toBeNull();
    expect(totals("12.5")).toBeNull();
    expect(totals("-1")).toBeNull();
    expect(totals("100", "2001")).toBeNull();
    expect(totals("")).toBeNull();
  });
});
