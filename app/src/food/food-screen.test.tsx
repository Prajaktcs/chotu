import Storage from "expo-sqlite/kv-store";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { AppState } from "react-native";

import type { FoodDayResponse, Meal } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");
const initialAppState = Object.getOwnPropertyDescriptor(AppState, "currentState");

const meal = (id: string, description: string, calories: number, revision = 0): Meal => ({
  id,
  revision,
  eaten_at: "2026-10-28T12:30:00Z",
  description,
  calories,
  protein_g: 20.4,
  carbs_g: 30,
  fat_g: 10,
});

const day = (date: string, meals: Meal[]): FoodDayResponse => ({ date, meals });

let restoreFetch = () => {};
let calls: FetchCall[] = [];
let days: Record<string, FoodDayResponse> = {};
let write: (init: RequestInit) => Response = () => json(500, { error: "unexpected" });

beforeEach(async () => {
  Object.defineProperty(AppState, "currentState", { configurable: true, value: "active" });
  jest.useFakeTimers({ now: new Date("2026-10-28T15:00:00"), doNotFake: ["nextTick"] });
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
  days = {
    "2026-10-28": day("2026-10-28", [meal("lunch", "Dal and rice", 450)]),
    "2026-10-27": day("2026-10-27", []),
  };
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/food": () => {
      const date = new URLSearchParams(calls.at(-1)?.search).get("date") ?? "";
      return json(200, days[date] ?? day(date, []));
    },
    "POST /v1/food": (init) => write(init),
    "PATCH /v1/food/lunch": (init) => write(init),
    "DELETE /v1/food/lunch": (init) => write(init),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => {
  restoreFetch();
  jest.useRealTimers();
  if (initialAppState) Object.defineProperty(AppState, "currentState", initialAppState);
});

const writes = () => calls.filter((call) => call.method !== "GET");

it("lists today's meals and moves between days, never past today", async () => {
  await renderRouter("./src/app", { initialUrl: "/food" });
  expect(await screen.findByText("Dal and rice")).toBeTruthy();
  const first = calls.find((call) => call.path === "/v1/food");
  expect(first?.search).toBe("?date=2026-10-28");
  expect(first?.headers["x-chotu-member"]).toBe("alex");
  expect(screen.getByRole("header", { name: "Today" })).toBeTruthy();
  expect(screen.getByText("Total 450 kcal · 20g P / 30g C / 10g F")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Next day" })).toBeDisabled();

  await fireEvent.press(screen.getByRole("button", { name: "Previous day" }));
  expect(await screen.findByRole("header", { name: "Yesterday" })).toBeTruthy();
  expect(await screen.findByText(/No meals logged/)).toBeTruthy();
  expect(calls.at(-1)?.search).toBe("?date=2026-10-27");

  await fireEvent.press(screen.getByRole("button", { name: "Back to today" }));
  expect(await screen.findByText("Dal and rice")).toBeTruthy();
  expect(writes()).toEqual([]);
});

it("adds a meal to the selected day with an idempotency key", async () => {
  write = () =>
    json(
      201,
      day("2026-10-27", [{ ...meal("eggs", "Two eggs", 140), eaten_at: "2026-10-27T16:00:00Z" }]),
    );
  await renderRouter("./src/app", { initialUrl: "/food" });
  await screen.findByText("Dal and rice");
  await fireEvent.press(screen.getByRole("button", { name: "Previous day" }));
  await screen.findByText(/No meals logged/);
  expect(screen.getByRole("button", { name: "Add meal to Yesterday" })).toBeDisabled();

  await fireEvent.changeText(screen.getByLabelText("What did you eat (Yesterday)?"), " Two eggs ");
  await fireEvent.press(screen.getByRole("button", { name: "Add meal to Yesterday" }));
  expect(await screen.findByText("Two eggs")).toBeTruthy();
  const [post] = writes();
  expect(post?.method).toBe("POST");
  expect(post?.body).toEqual({ description: "Two eggs", date: "2026-10-27" });
  expect(post?.headers["idempotency-key"]).toBeTruthy();
});

it("edits and deletes a meal with its revision", async () => {
  write = (init) =>
    init.method === "PATCH"
      ? json(200, day("2026-10-28", [meal("lunch", "Dal, rice and yogurt", 520, 1)]))
      : json(200, day("2026-10-28", []));
  await renderRouter("./src/app", { initialUrl: "/food" });
  await fireEvent.press(await screen.findByRole("button", { name: /Edit meal: Dal and rice/ }));
  expect(screen.getByRole("button", { name: "Save meal" })).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText("Meal"), "Dal, rice and yogurt");
  await fireEvent.press(screen.getByRole("button", { name: "Save meal" }));
  expect(await screen.findByText("Dal, rice and yogurt")).toBeTruthy();
  expect(writes()[0]).toMatchObject({
    method: "PATCH",
    path: "/v1/food/lunch",
    body: { description: "Dal, rice and yogurt", revision: 0 },
  });

  await fireEvent.press(screen.getByRole("button", { name: /Edit meal: Dal, rice and yogurt/ }));
  await fireEvent.press(screen.getByRole("button", { name: "Delete meal" }));
  expect(writes()).toHaveLength(1);
  await fireEvent.press(screen.getByRole("button", { name: "Confirm delete meal" }));
  expect(await screen.findByText(/No meals logged/)).toBeTruthy();
  expect(writes()[1]).toMatchObject({ method: "DELETE", path: "/v1/food/lunch" });
});

it("explains a meal changed elsewhere and reloads the day", async () => {
  write = () => json(409, { error: "meal changed since it was loaded", code: "meal_changed" });
  await renderRouter("./src/app", { initialUrl: "/food" });
  await fireEvent.press(await screen.findByRole("button", { name: /Edit meal: Dal and rice/ }));
  await fireEvent.changeText(screen.getByLabelText("Meal"), "Dal only");
  days["2026-10-28"] = day("2026-10-28", [meal("lunch", "Dal and roti", 400, 1)]);
  await fireEvent.press(screen.getByRole("button", { name: "Save meal" }));
  expect(await screen.findByText("Couldn't update meal")).toBeTruthy();
  expect(screen.getByText("meal changed since it was loaded")).toBeTruthy();
  expect(await screen.findByText("Dal and roti")).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByText("Couldn't update meal")).toBeNull());
});
