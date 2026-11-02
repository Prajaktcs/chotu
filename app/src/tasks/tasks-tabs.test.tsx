import { router as appRouter } from "expo-router";
import Storage from "expo-sqlite/kv-store";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";

import type { DoneTask, Task } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

import TRENDS from "../api/fixtures/task-trends.json";
import { groupTasks } from "./format";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

const TODAY = "2026-10-26";
const NEW_TOKEN = "alex_phone.fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function task(title: string, overrides: Partial<Task> = {}): Task {
  return {
    id: title.replaceAll(" ", "-"),
    title,
    status: "open",
    due_date: TODAY,
    due_at: null,
    due_has_time: false,
    assigned_to: "alex",
    email_subject: null,
    ...overrides,
  };
}

const TASKS = [
  task("Overdue bill", { due_date: "2026-10-20" }),
  task("Call today"),
  task("Someday chore", { due_date: null, assigned_to: null }),
  task("Renew passport", { due_date: "2026-11-20" }),
  task("Snoozed errand", { status: "snoozed", due_date: "2026-10-28" }),
];

const DONE: DoneTask = {
  ...task("Paid rent", { status: "done" }),
  completed_at: "2026-10-25T13:00:00+00:00",
};

let calls: FetchCall[] = [];
let restoreFetch = () => {};
let create: () => Response;

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
  create = () =>
    json(201, {
      task: task("Buy milk", { id: "new-task", due_date: "2026-10-27" }),
      details: null,
      note: null,
      calendar: "not_linked",
    });
  const echo =
    (status: Task["status"], extra: Partial<Task> = {}) =>
    () => {
      const id = calls.at(-1)!.path.split("/")[3]!;
      const found = [...TASKS, DONE].find((item) => item.id === id)!;
      return json(200, { task: { ...found, status, ...extra } });
    };
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/me": () =>
      json(200, { device: "alex_phone", member: null, profiles: [{ id: "alex", name: "Alex" }] }),
    "GET /v1/tasks": () => json(200, { date: TODAY, tasks: TASKS }),
    "POST /v1/tasks": () => create(),
    "POST /v1/tasks/Snoozed-errand/reopen": echo("open"),
    "POST /v1/tasks/Paid-rent/reopen": echo("open"),
    "POST /v1/tasks/Someday-chore/assign": echo("open", { assigned_to: "alex" }),
    "POST /v1/tasks/Call-today/snooze": echo("snoozed"),
    // Once reopened, the server no longer lists it as done.
    "GET /v1/tasks/completed": () =>
      json(200, {
        tasks: writes().some((call) => call.path.endsWith("/Paid-rent/reopen")) ? [] : [DONE],
        next_before: null,
      }),
    "GET /v1/tasks/trends": () => json(200, TRENDS),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => restoreFetch());

const writes = () => calls.filter((call) => call.method === "POST");

describe("grouping", () => {
  it("puts every active task in exactly one tab, by household day", () => {
    const today = groupTasks(TASKS, TODAY, "today");
    const upcoming = groupTasks(TASKS, TODAY, "upcoming");
    expect(today.map((group) => [group.title, group.tasks.map((t) => t.title)])).toEqual([
      ["Overdue", ["Overdue bill"]],
      ["Today", ["Call today"]],
      ["No due date", ["Someday chore"]],
    ]);
    expect(upcoming.map((group) => [group.title, group.tasks.map((t) => t.title)])).toEqual([
      ["Scheduled", ["Renew passport"]],
      ["Snoozed", ["Snoozed errand"]],
    ]);
  });
});

describe("Today and Upcoming", () => {
  it("shows overdue, today and undated tasks, and Upcoming the rest", async () => {
    await renderRouter("./src/app", { initialUrl: "/tasks" });
    expect(await screen.findByRole("header", { name: "Overdue · 1" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "No due date · 1" })).toBeTruthy();
    expect(screen.getByText("Household · unassigned")).toBeTruthy();
    expect(screen.queryByText("Renew passport")).toBeNull();
    await fireEvent.press(screen.getByRole("tab", { name: "Upcoming" }));
    expect(await screen.findByRole("header", { name: "Scheduled · 1" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "Snoozed · 1" })).toBeTruthy();
  });

  it("unsnoozes from Upcoming and takes an unassigned task", async () => {
    await renderRouter("./src/app", { initialUrl: "/tasks/upcoming" });
    await fireEvent.press(
      await screen.findByRole("button", { name: /Task actions: Snoozed errand/ }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Unsnooze task" }));
    await waitFor(() => expect(writes().at(-1)?.path).toBe("/v1/tasks/Snoozed-errand/reopen"));
    expect(writes().at(-1)?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    await fireEvent.press(screen.getByRole("tab", { name: "Today" }));
    await fireEvent.press(
      await screen.findByRole("button", { name: /Task actions: Someday chore/ }),
    );
    await fireEvent.press(screen.getByRole("button", { name: "Assign task to me" }));
    await waitFor(() => expect(writes().at(-1)?.path).toBe("/v1/tasks/Someday-chore/assign"));
  });

  it("snoozes for a custom number of days within the server's range", async () => {
    await renderRouter("./src/app", { initialUrl: "/tasks" });
    await fireEvent.press(await screen.findByRole("button", { name: /Task actions: Call today/ }));
    const field = screen.getByLabelText("Snooze for days");
    await fireEvent.changeText(field, "91");
    expect(screen.getByRole("button", { name: "Snooze for the entered days" })).toBeDisabled();
    await fireEvent.changeText(field, "14");
    await fireEvent.press(screen.getByRole("button", { name: "Snooze for the entered days" }));
    await waitFor(() => expect(writes().at(-1)?.body).toEqual({ days: 14 }));
  });
});

async function fill(title: string, due = "") {
  const router = await renderRouter("./src/app", { initialUrl: "/tasks" });
  await fireEvent.press(await screen.findByRole("button", { name: "Add task" }));
  await fireEvent.changeText(screen.getByLabelText("Title"), title);
  if (due) await fireEvent.changeText(screen.getByLabelText("Due (optional)"), due);
  await fireEvent.press(screen.getByRole("button", { name: "Save task" }));
  return router;
}

describe("Add task", () => {
  it("creates the task with Signal's due text and reports the calendar", async () => {
    await fill("Buy milk", "tomorrow 9am");
    expect(await screen.findByText("Task added")).toBeTruthy();
    expect(screen.getByText(/calendar isn't linked/)).toBeTruthy();
    const write = writes().find((call) => call.path === "/v1/tasks");
    expect(write?.body).toEqual({ title: "Buy milk", due: "tomorrow 9am" });
    expect(write?.headers["x-chotu-member"]).toBe("alex");
  });

  it("keeps a rejected due time editable", async () => {
    create = () => json(422, { error: "Couldn't parse due `blorp`.", code: "due_unparsed" });
    await fill("Buy milk", "blorp");
    expect(await screen.findByText("Couldn't parse due `blorp`.")).toBeTruthy();
    expect(screen.getByLabelText("Title").props.value).toBe("Buy milk");
  });

  it("retries an unconfirmed save with the same request id and won't silently drop it", async () => {
    create = () => {
      throw new TypeError("Network request failed");
    };
    await fill("Buy milk");
    expect(await screen.findByText("Task not confirmed")).toBeTruthy();
    const first = writes().find((call) => call.path === "/v1/tasks")!;
    expect(screen.queryByRole("button", { name: "Cancel adding a task" })).toBeNull();
    create = () =>
      json(201, {
        task: task("Buy milk", { id: "new-task" }),
        details: null,
        note: null,
        calendar: null,
      });
    await fireEvent.press(screen.getByRole("button", { name: "Retry unchanged: Buy milk" }));
    expect(await screen.findByText("Task added")).toBeTruthy();
    const retries = writes().filter((call) => call.path === "/v1/tasks");
    expect(retries).toHaveLength(2);
    expect(retries[1]!.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    expect(retries[1]!.body).toEqual(first.body);
  });
});

describe("Add task across navigation", () => {
  it("keeps an unconfirmed save after leaving Tasks, and a 401 retry stays unconfirmed", async () => {
    create = () => {
      throw new TypeError("Network request failed");
    };
    const router = await fill("Buy milk");
    expect(await screen.findByText("Task not confirmed")).toBeTruthy();
    const key = writes().find((call) => call.path === "/v1/tasks")!.headers["idempotency-key"];
    // Leaving the route (web Back) and coming back offers the same save again.
    await act(async () => appRouter.replace("/tasks/upcoming"));
    await act(async () => appRouter.replace("/tasks"));
    expect(await screen.findByText("Task not confirmed")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Retry unchanged: Buy milk" }));
    create = () => json(401, { error: "missing or invalid device token" });
    await fireEvent.press(await screen.findByRole("button", { name: "Retry unchanged: Buy milk" }));
    await waitFor(() =>
      expect(writes().filter((call) => call.path === "/v1/tasks").length).toBe(3),
    );
    // The 401 opens token recovery; replacing the token keeps the save.
    await waitFor(() => expect(router.getPathname()).toBe("/connection/token"));
    await fireEvent.changeText(screen.getByLabelText("New device token"), NEW_TOKEN);
    await fireEvent.press(screen.getByRole("button", { name: "Save and reconnect" }));
    await waitFor(() => expect(router.getPathname()).toBe("/today"));
    await act(async () => appRouter.push("/tasks"));
    expect(await screen.findByText("Task not confirmed")).toBeTruthy();
    create = () =>
      json(201, {
        task: task("Buy milk", { id: "new-task" }),
        details: null,
        note: null,
        calendar: null,
      });
    await fireEvent.press(screen.getByRole("button", { name: "Retry unchanged: Buy milk" }));
    // eslint-disable-next-line no-console
    console.log(
      "DBG2",
      screen
        .queryAllByText(/./)
        .map((n) => n.props.children)
        .join(" | ")
        .slice(0, 500),
    );
    expect(await screen.findByText("Task added")).toBeTruthy();
    const sent = writes().filter((call) => call.path === "/v1/tasks");
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((call) => call.headers["idempotency-key"]))).toEqual(new Set([key]));
    expect(sent.at(-1)?.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`);
  });
});

describe("Completed and Trends", () => {
  it("rolls a failed reopen back into Completed with its retry", async () => {
    restoreFetch();
    const mock = mockFetch({
      "GET /v1/health": () => json(200, HEALTH),
      "GET /v1/tasks/completed": () => json(200, { tasks: [DONE], next_before: null }),
      "POST /v1/tasks/Paid-rent/reopen": () => {
        throw new TypeError("Network request failed");
      },
    });
    calls = mock.calls;
    restoreFetch = mock.restore;
    await renderRouter("./src/app", { initialUrl: "/tasks/completed" });
    await fireEvent.press(await screen.findByRole("button", { name: "Reopen Paid rent" }));
    expect(await screen.findByRole("button", { name: "Retry unchanged: Paid rent" })).toBeTruthy();
    expect(screen.getByText("Paid rent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reopen Paid rent" })).toBeDisabled();
  });

  it("lists completed tasks and reopens one", async () => {
    await renderRouter("./src/app", { initialUrl: "/tasks/completed" });
    expect(await screen.findByText("Paid rent")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Completed" })).toBeSelected();
    await fireEvent.press(screen.getByRole("button", { name: "Reopen Paid rent" }));
    await waitFor(() => expect(writes().at(-1)?.path).toBe("/v1/tasks/Paid-rent/reopen"));
    await waitFor(() => expect(screen.queryByText("Paid rent")).toBeNull());
  });

  it("shows created and completed tasks per week", async () => {
    await renderRouter("./src/app", { initialUrl: "/tasks/trends" });
    expect(await screen.findByText("3 added · 2 completed")).toBeTruthy();
    expect(screen.getByText("4 open tasks · 1 overdue")).toBeTruthy();
    expect(screen.getByLabelText("Week of Mon, Oct 26: 2 added, 1 completed")).toBeTruthy();
    expect(calls.find((call) => call.path === "/v1/tasks/trends")?.search).toBe("?days=28");
  });
});
