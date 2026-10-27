import Storage from "expo-sqlite/kv-store";
import { fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import type { Task } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");
const original: Task = {
  id: "task-full-uuid",
  title: "Pay the electricity bill",
  status: "open",
  due_date: "2026-10-25",
  due_at: null,
  due_has_time: false,
  assigned_to: null,
  email_subject: "October bill",
};
let restoreFetch = () => {};
let calls: FetchCall[] = [];

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
  let task: Task = { ...original };
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/me": () =>
      json(200, {
        device: "alex_phone",
        member: { id: "alex", name: "Alex" },
        profiles: [{ id: "alex", name: "Alex" }],
      }),
    "GET /v1/workout": () => json(200, { workout: null }),
    "GET /v1/tasks": () => json(200, { tasks: task.status === "done" ? [] : [task] }),
    "POST /v1/tasks/task-full-uuid/complete": () => {
      task = { ...task, status: "done" };
      return json(200, { task });
    },
    "POST /v1/tasks/task-full-uuid/snooze": () => {
      task = { ...task, status: "snoozed", due_date: "2026-11-01" };
      return json(200, { task });
    },
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => restoreFetch());

async function openTasks() {
  const router = await renderRouter("./src/app", { initialUrl: "/tasks" });
  await screen.findByText(original.title);
  return router;
}

it("a rightward swipe completes directly, without opening a menu, with member auth and a request id", async () => {
  await openTasks();
  await fireEvent(screen.getByTestId(`task-swipe-${original.id}`), "swipeableOpen", "right");
  await waitFor(() => expect(screen.queryByText(original.title)).toBeNull());
  const write = calls.find((call) => call.method === "POST");
  expect(write?.path).toBe(`/v1/tasks/${original.id}/complete`);
  expect(write?.body).toBeUndefined();
  expect(write?.headers["x-chotu-member"]).toBe("alex");
  expect(write?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(screen.queryByRole("header", { name: "Task actions" })).toBeNull();
});

it.each([1, 3, 7])("a leftward swipe directly sends the configured %i-day snooze", async (days) => {
  await openTasks();
  await fireEvent.press(
    screen.getByRole("radio", { name: `Swipe snooze ${days} ${days === 1 ? "day" : "days"}` }),
  );
  await fireEvent(screen.getByTestId(`task-swipe-${original.id}`), "swipeableOpen", "left");
  await waitFor(() => expect(calls.some((call) => call.path.endsWith("/snooze"))).toBe(true));
  expect(calls.find((call) => call.path.endsWith("/snooze"))?.body).toEqual({ days });
  expect(await screen.findByRole("header", { name: "Snoozed · 1" })).toBeTruthy();
  expect(screen.queryByRole("header", { name: "Task actions" })).toBeNull();
});

it("provides labelled menu alternatives for all snooze durations", async () => {
  await openTasks();
  await fireEvent.press(
    screen.getByRole("button", { name: /Task actions: Pay the electricity bill/ }),
  );
  expect(await screen.findByRole("header", { name: "Task actions" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Complete task" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Snooze 1 day" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Snooze 7 days" })).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Snooze 3 days" }));
  await waitFor(() =>
    expect(calls.find((call) => call.path.endsWith("/snooze"))?.body).toEqual({ days: 3 }),
  );
});

it("navigates to Workout and back without typing a task id", async () => {
  const router = await openTasks();
  await fireEvent.press(screen.getByRole("tab", { name: "Workout" }));
  await waitFor(() => expect(router.getPathname()).toBe("/workout"));
  await fireEvent.press(await screen.findByRole("tab", { name: "Tasks" }));
  expect(await screen.findByText(original.title)).toBeTruthy();
  expect(router.getPathname()).toBe("/tasks");
});
