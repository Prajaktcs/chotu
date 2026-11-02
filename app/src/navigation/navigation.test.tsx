import Storage from "expo-sqlite/kv-store";
import { router as appRouter } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

import FOOD_EMPTY from "../api/fixtures/food-day-empty.json";
import STATUS_EMPTY from "../api/fixtures/status-empty.json";
import { resetRememberedScreens, sections } from "./sections";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

// A phone by default; the expanded test widens it.
let mockWindowWidth = 400;
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({
  __esModule: true,
  default: () => ({ width: mockWindowWidth, height: 800, scale: 1, fontScale: 1 }),
}));

const SERVER = "https://mini.ts.net:8787";
const QUEUE_KEY = `chotu.set_queue.v1:${SERVER}#alex`;
let restoreFetch = () => {};

beforeEach(async () => {
  resetRememberedScreens();
  mockWindowWidth = 400;
  secure.reset();
  await Storage.clear();
  secure.items.set(TOKEN_KEY, "alex_phone.test-token");
  secure.items.set(
    SETTINGS_KEY,
    JSON.stringify({ version: 1, serverUrl: SERVER, profile: { id: "alex", name: "Alex" } }),
  );
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/me": () =>
      json(200, {
        device: "alex_phone",
        member: { id: "alex", name: "Alex", weight_unit: "lb" },
        profiles: [{ id: "alex", name: "Alex", weight_unit: "lb" }],
      }),
    "GET /v1/workout": () => json(200, { workout: null }),
    "GET /v1/status": () => json(200, STATUS_EMPTY),
    "GET /v1/tasks": () => json(200, { tasks: [] }),
    "GET /v1/food": () => json(200, FOOD_EMPTY),
    "GET /v1/plan": () => json(200, { date: "2026-10-26", week_start: "2026-10-26", plan: null }),
    "POST /v1/workout/sets": () => new Response("Bad Gateway", { status: 502 }),
  });
  restoreFetch = mock.restore;
});

afterEach(() => {
  restoreFetch();
});

const openDrawer = () =>
  fireEvent.press(screen.getByRole("button", { name: "Open section navigation" }));

describe("sections", () => {
  it("gives every section but Today exactly four tabs", () => {
    for (const section of sections) {
      expect(section.tabs).toHaveLength(section.id === "today" ? 0 : 4);
    }
    expect(sections.find((section) => section.id === "memory")?.tabs.at(-1)?.label).toBe(
      "Activity",
    );
  });
});

describe("phone drawer", () => {
  it("lists the sections, marks unbuilt ones unavailable, and closes", async () => {
    await renderRouter("./src/app");
    await screen.findByRole("header", { name: "Nothing logged yet today" });
    expect(screen.queryByRole("button", { name: "Fitness" })).toBeNull();

    await openDrawer();
    expect(screen.getByText("Alex")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Today" })).toBeSelected();
    for (const name of ["Fitness", "Nutrition", "Tasks", "Settings"]) {
      expect(screen.getByRole("button", { name })).toBeEnabled();
    }
    expect(screen.getByRole("button", { name: "Health, coming soon" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Finance, coming later" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Memory, coming later" })).toBeDisabled();

    await fireEvent.press(screen.getByRole("button", { name: "Close section navigation" }));
    expect(screen.queryByRole("button", { name: "Fitness" })).toBeNull();
  });

  it("opens a section from Today, and Back returns to Today", async () => {
    const router = await renderRouter("./src/app");
    await screen.findByRole("header", { name: "Nothing logged yet today" });
    await openDrawer();
    await fireEvent.press(screen.getByRole("button", { name: "Fitness" }));
    await waitFor(() => expect(router.getPathname()).toBe("/workout"));
    expect(screen.getByRole("header", { name: "Fitness" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fitness" })).toBeNull();

    // Tabs within a section replace each other, so Back still goes to Today.
    await fireEvent.press(screen.getByRole("tab", { name: "Plan" }));
    await waitFor(() => expect(router.getPathname()).toBe("/plan"));
    await act(async () => appRouter.back());
    await waitFor(() => expect(router.getPathname()).toBe("/today"));
  });

  it("disables tabs that are not built yet", async () => {
    await renderRouter("./src/app", { initialUrl: "/food" });
    expect(await screen.findByLabelText("Nutrition tabs")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Today" })).toBeSelected();
    for (const name of ["Food log", "Goals", "Trends"]) {
      const tab = screen.getByRole("tab", { name });
      expect(tab).toBeDisabled();
      expect(tab.props.accessibilityHint).toBe("Not available yet");
    }
  });

  it("reopens a section on its last tab", async () => {
    const router = await renderRouter("./src/app", { initialUrl: "/plan" });
    await screen.findByRole("header", { name: "Fitness" });
    await openDrawer();
    await fireEvent.press(screen.getByRole("button", { name: "Tasks" }));
    await waitFor(() => expect(router.getPathname()).toBe("/tasks"));
    await openDrawer();
    await fireEvent.press(screen.getByRole("button", { name: "Fitness" }));
    await waitFor(() => expect(router.getPathname()).toBe("/plan"));
  });

  it("keeps unsent sets across sections", async () => {
    const item = {
      exercise: "Bench press",
      weight: 135,
      unit: "lb",
      reps: 8,
      performedAt: "2026-10-24T09:32:00-04:00",
      status: "pending",
      requestId: "3f2b9c4e-8a1d-4c55-9a8e-2b7f0c1d9e6a",
    };
    await Storage.setItem(QUEUE_KEY, JSON.stringify({ version: 1, items: [item] }));
    const router = await renderRouter("./src/app", { initialUrl: "/workout" });
    await screen.findByRole("header", { name: "Fitness" });
    await openDrawer();
    await fireEvent.press(screen.getByRole("button", { name: "Tasks" }));
    await waitFor(() => expect(router.getPathname()).toBe("/tasks"));
    await openDrawer();
    await fireEvent.press(screen.getByRole("button", { name: "Fitness" }));
    await waitFor(() => expect(router.getPathname()).toBe("/workout"));
    const queued = JSON.parse((await Storage.getItem(QUEUE_KEY)) ?? "null");
    expect(queued.items.map((queuedItem: { requestId: string }) => queuedItem.requestId)).toEqual([
      item.requestId,
    ]);
  });
});

describe("expanded layout", () => {
  it("keeps the sidebar visible instead of a menu button", async () => {
    mockWindowWidth = 1280;
    const router = await renderRouter("./src/app", { initialUrl: "/workout" });
    await screen.findByRole("header", { name: "Fitness" });
    expect(screen.queryByRole("button", { name: "Open section navigation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Fitness" })).toBeSelected();
    await fireEvent.press(screen.getByRole("button", { name: "Nutrition" }));
    await waitFor(() => expect(router.getPathname()).toBe("/food"));
    expect(screen.getByRole("tab", { name: "Today" })).toBeSelected();
  });
});
