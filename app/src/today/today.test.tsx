import { router as appRouter } from "expo-router";
import Storage from "expo-sqlite/kv-store";
import {
  act,
  cleanup,
  fireEvent,
  renderRouter,
  screen,
  waitFor,
} from "expo-router/testing-library";

import type { Task } from "@/api";
import { SETTINGS_KEY, TOKEN_KEY } from "@/connection/storage";
import { type FetchCall, HEALTH, json, mockFetch } from "@/test/fetch-mock";
import type { SecureStoreMock } from "@/test/secure-store-mock";
import type * as SecureStoreModule from "@/test/secure-store-mock";

import CALENDAR from "../api/fixtures/calendar.json";
import CALENDAR_NOT_LINKED from "../api/fixtures/calendar-not-linked.json";
import STATUS from "../api/fixtures/status.json";
import TIP from "../api/fixtures/status-tip.json";
import TIP_NONE from "../api/fixtures/status-tip-none.json";
import WORKOUT_BEFORE from "../api/fixtures/workout-before.json";
import WORKOUT_OPEN from "../api/fixtures/workout-open.json";
import { dueTasks, taskDueText } from "./format";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof SecureStoreModule>("@/test/secure-store-mock").createSecureStoreMock(),
);
const secure = jest.requireMock<SecureStoreMock>("expo-secure-store");

const TODAY = "2026-10-26";

function task(id: string, overrides: Partial<Task>): Task {
  return {
    id,
    title: id,
    status: "open",
    due_date: TODAY,
    due_at: null,
    due_has_time: false,
    assigned_to: "alex",
    email_subject: null,
    ...overrides,
  };
}

const TASKS: Task[] = [
  task("Pay rent", { due_date: "2026-10-24" }),
  // A household-day deadline whose UTC instant is already tomorrow still counts today.
  task("Call dentist", { due_at: "2026-10-27T01:30:00Z", due_has_time: true }),
  task("Renew passport", { due_date: "2026-11-20" }),
  task("Snoozed chore", { status: "snoozed" }),
  task("Someday", { due_date: null }),
];

let calls: FetchCall[] = [];
let restoreFetch = () => {};
let tasks: () => Response;
let status: () => Response;
let workout: () => Response;
let calendar: () => Response;
let tip: () => Response;

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
  tasks = () => json(200, { date: TODAY, tasks: TASKS });
  status = () => json(200, STATUS);
  workout = () => json(200, WORKOUT_BEFORE);
  calendar = () => json(200, CALENDAR);
  tip = () => json(200, TIP);
  const mock = mockFetch({
    "GET /v1/health": () => json(200, HEALTH),
    "GET /v1/status": () => status(),
    "GET /v1/workout": () => workout(),
    "GET /v1/tasks": () => tasks(),
    "GET /v1/calendar": () => calendar(),
    "GET /v1/status/tip": () => tip(),
  });
  calls = mock.calls;
  restoreFetch = mock.restore;
});

afterEach(() => restoreFetch());

const tipCalls = () => calls.filter((call) => call.path === "/v1/status/tip").length;

async function openToday() {
  const router = await renderRouter("./src/app", { initialUrl: "/today" });
  await screen.findByLabelText("Steps: 5000");
  return router;
}

it("shows today's plan, due tasks and status for the profile", async () => {
  await openToday();
  expect(screen.getByText("MON, OCT 26 · Example Member")).toBeTruthy();
  expect(await screen.findByText("Strength · Synthetic training day")).toBeTruthy();
  expect(screen.getByRole("link", { name: /^Example squat\. 3 × 8-10/ })).toBeTruthy();
  expect(await screen.findByText("2 due")).toBeTruthy();
  expect(screen.getByText("Overdue · Sat, Oct 24")).toBeTruthy();
  expect(screen.getByText("Call dentist")).toBeTruthy();
  for (const hidden of ["Renew passport", "Snoozed chore", "Someday"]) {
    expect(screen.queryByText(hidden)).toBeNull();
  }
  for (const path of ["/v1/status", "/v1/workout", "/v1/tasks"]) {
    expect(calls.find((call) => call.path === path)?.headers["x-chotu-member"]).toBe("alex");
  }
});

it("renders Today when the native runtime lacks Array.toSorted", async () => {
  const toSorted = jest.spyOn(Array.prototype, "toSorted").mockImplementation(() => {
    throw new TypeError("Array.toSorted is unavailable in this runtime");
  });
  try {
    await openToday();
    expect(await screen.findByText("2 due")).toBeTruthy();
    expect(screen.getByText("Call dentist")).toBeTruthy();
    expect(screen.getByText("MON, OCT 26 · Example Member")).toBeTruthy();
  } finally {
    toSorted.mockRestore();
  }
});

it("opens Workout with a planned lift chosen", async () => {
  const router = await openToday();
  await fireEvent.press(await screen.findByRole("link", { name: /^Example squat\./ }));
  await waitFor(() => expect(router.getPathname()).toBe("/workout"));
});

it("opens a due task's actions in Tasks, and Back returns to Today", async () => {
  const router = await openToday();
  await fireEvent.press(await screen.findByRole("link", { name: /^Pay rent\./ }));
  await waitFor(() => expect(router.getPathname()).toBe("/tasks"));
  expect(await screen.findByRole("header", { name: "Task actions" })).toBeTruthy();
  await fireEvent.press(screen.getByRole("button", { name: "Close task actions" }));
  expect(screen.queryByRole("header", { name: "Task actions" })).toBeNull();
  await act(async () => appRouter.back());
  await waitFor(() => expect(router.getPathname()).toBe("/today"));
});

it("summarizes an open workout", async () => {
  workout = () => json(200, WORKOUT_OPEN);
  await openToday();
  expect(
    await screen.findByText(/^Workout in progress · \d+ sets? · now Example squat$/),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Continue workout" })).toBeTruthy();
});

it("keeps other cards when one endpoint fails, and explains an older server", async () => {
  tasks = () => new Response("", { status: 404 });
  await openToday();
  expect(await screen.findByText(/Couldn't load tasks\. Update the Chotu server/)).toBeTruthy();
  expect(screen.getByLabelText("Steps: 5000")).toBeTruthy();
  expect(screen.getByRole("link", { name: /^Example squat\./ })).toBeTruthy();
});

it("keeps loaded data when a refresh fails, saying when it was loaded", async () => {
  await openToday();
  await screen.findByText("2 due");
  status = () => {
    throw new TypeError("Network request failed");
  };
  const scroll = screen.getByTestId("today-scroll");
  await act(async () => {
    await scroll.props.refreshControl.props.onRefresh();
  });
  expect(await screen.findByText(/Showing data loaded at/)).toBeTruthy();
  expect(screen.getByLabelText("Steps: 5000")).toBeTruthy();
});

it("uses the newer household day when one refresh is a day behind", async () => {
  tasks = () => json(200, { date: "2026-10-25", tasks: TASKS });
  await openToday();
  // Status says it's the 26th: tasks due that day count, not just the 25th's.
  expect(await screen.findByText("2 due")).toBeTruthy();
  expect(screen.getByText("Call dentist")).toBeTruthy();
});

it("doesn't offer yesterday's plan after the day changes and the refresh fails", async () => {
  jest.useFakeTimers({ now: new Date("2026-10-26T20:00:00"), doNotFake: ["nextTick"] });
  try {
    const router = await openToday();
    expect(await screen.findByRole("link", { name: /^Example squat\./ })).toBeTruthy();
    workout = () => {
      throw new TypeError("Network request failed");
    };
    jest.setSystemTime(new Date("2026-10-27T07:00:00"));
    const scroll = screen.getByTestId("today-scroll");
    await act(async () => {
      await scroll.props.refreshControl.props.onRefresh();
    });
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /^Example squat\./ })).toBeNull(),
    );
    expect(screen.getByText(/Couldn't load today's workout/)).toBeTruthy();
    expect(router.getPathname()).toBe("/today");
  } finally {
    await cleanup();
    jest.useRealTimers();
  }
});

it("doesn't offer a plan from before the household day another card reports", async () => {
  workout = () => json(200, { ...WORKOUT_BEFORE, date: "2026-10-25" });
  await openToday();
  await screen.findByText("2 due");
  expect(screen.queryByRole("link", { name: /^Example squat\./ })).toBeNull();
  expect(await screen.findByText(/Today's plan hasn't loaded yet/)).toBeTruthy();
});

it("shows the profile's own calendar and the coach tip", async () => {
  await openToday();
  expect(
    await screen.findByLabelText("09:30–10:00, Example appointment, Example clinic"),
  ).toBeTruthy();
  expect(screen.getByLabelText("all day, Example holiday")).toBeTruthy();
  expect(await screen.findByText(TIP.tip)).toBeTruthy();
  for (const path of ["/v1/calendar", "/v1/status/tip"]) {
    expect(calls.find((call) => call.path === path)?.headers["x-chotu-member"]).toBe("alex");
  }
});

it("asks the coach once per day: not on refresh, only on New tip", async () => {
  await openToday();
  await screen.findByText(TIP.tip);
  expect(tipCalls()).toBe(1);
  const scroll = screen.getByTestId("today-scroll");
  await act(async () => {
    await scroll.props.refreshControl.props.onRefresh();
  });
  expect(tipCalls()).toBe(1);
  tip = () => json(200, { ...TIP, tip: "Example tip: walk after dinner." });
  await fireEvent.press(screen.getByRole("button", { name: "Ask the coach for a new tip" }));
  expect(await screen.findByText("Example tip: walk after dinner.")).toBeTruthy();
  expect(tipCalls()).toBe(2);
});

it("keeps the day's tip when leaving Today and coming back", async () => {
  await openToday();
  await screen.findByText(TIP.tip);
  await act(async () => appRouter.push("/tasks"));
  await act(async () => appRouter.push("/today"));
  expect(await screen.findByText(TIP.tip)).toBeTruthy();
  expect(tipCalls()).toBe(1);
});

it("doesn't show yesterday's agenda after the day changes and the refresh fails", async () => {
  jest.useFakeTimers({ now: new Date("2026-10-26T20:00:00"), doNotFake: ["nextTick"] });
  try {
    await openToday();
    expect(await screen.findByLabelText(/Example appointment/)).toBeTruthy();
    calendar = () => {
      throw new TypeError("Network request failed");
    };
    tasks = () => {
      throw new TypeError("Network request failed");
    };
    status = () => {
      throw new TypeError("Network request failed");
    };
    jest.setSystemTime(new Date("2026-10-27T07:00:00"));
    const scroll = screen.getByTestId("today-scroll");
    await act(async () => {
      await scroll.props.refreshControl.props.onRefresh();
    });
    await waitFor(() => expect(screen.queryByLabelText(/Example appointment/)).toBeNull());
    expect(screen.getByText(/Couldn't load your calendar/)).toBeTruthy();
  } finally {
    await cleanup();
    jest.useRealTimers();
  }
});

it("tells not linked, no events and a failed calendar apart", async () => {
  calendar = () => json(200, CALENDAR_NOT_LINKED);
  await openToday();
  expect(await screen.findByText(/Your calendar isn't linked\. Link it in Signal/)).toBeTruthy();
  calendar = () => json(200, { ...CALENDAR, events: [] });
  const scroll = screen.getByTestId("today-scroll");
  await act(async () => {
    await scroll.props.refreshControl.props.onRefresh();
  });
  expect(await screen.findByText("Nothing on your calendar today.")).toBeTruthy();
  calendar = () =>
    json(502, {
      error: "Google Calendar didn't answer. Try again later.",
      code: "calendar_failed",
    });
  await act(async () => {
    await scroll.props.refreshControl.props.onRefresh();
  });
  expect(await screen.findByText(/Google Calendar didn't answer/)).toBeTruthy();
  expect(screen.getByLabelText("Steps: 5000")).toBeTruthy();
});

it("says when there's nothing to coach on, and when the coach is down", async () => {
  tip = () => json(200, TIP_NONE);
  await openToday();
  expect(await screen.findByText("Log food, sleep or a workout to get a tip.")).toBeTruthy();
  tip = () =>
    json(503, { error: "The coach didn't answer. Try again later.", code: "coach_unavailable" });
  await fireEvent.press(screen.getByRole("button", { name: "Ask the coach for a new tip" }));
  expect(await screen.findByText(/The coach didn't answer/)).toBeTruthy();
  expect(screen.getByLabelText("Steps: 5000")).toBeTruthy();
});

describe("due tasks", () => {
  it("uses household dates, not the phone's clock", () => {
    expect(dueTasks(TASKS, TODAY).map((item) => item.id)).toEqual(["Pay rent", "Call dentist"]);
    expect(dueTasks(TASKS, "2026-10-23")).toEqual([]);
    expect(taskDueText(TASKS[0]!, TODAY)).toBe("Overdue · Sat, Oct 24");
    expect(taskDueText(task("x", {}), TODAY)).toBe("Due today");
  });
});
