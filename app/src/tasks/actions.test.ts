import { QueryClient } from "@tanstack/react-query";

import { createApiClient, type Task, type TasksResponse } from "@/api";

import { taskActions, tasksQueryKey, visibleTasks } from "./actions";

const first: Task = {
  id: "first-full-id", title: "Pay bill", status: "open", due_date: "2026-10-25",
  due_at: null, due_has_time: false, assigned_to: "alex", email_subject: null,
};
const second: Task = { ...first, id: "second-full-id", title: "Book dentist" };

function setup(fetchImpl: typeof fetch) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const client = createApiClient({ serverUrl: "https://mini.test", token: "test", memberId: "alex", fetch: fetchImpl });
  const scope = "https://mini.test#alex";
  query.setQueryData<TasksResponse>(tasksQueryKey(scope), { tasks: [first, second] });
  const actions = taskActions(query, scope, client);
  const rows = () => visibleTasks(query.getQueryData<TasksResponse>(tasksQueryKey(scope))?.tasks ?? [], actions.getSnapshot());
  return { query, client, scope, actions, rows };
}

function response(task: Task): Response {
  return new Response(JSON.stringify({ task }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("task optimistic actions", () => {
  it("rolls back only the failed row, retaining a concurrent successful completion", async () => {
    const slow = Promise.withResolvers<Response>();
    const fetchImpl: typeof fetch = (input) => String(input).includes(first.id)
      ? slow.promise : Promise.resolve(response({ ...second, status: "done" }));
    const state = setup(fetchImpl);
    const pending = state.actions.perform(first, { kind: "complete" });
    expect(state.rows().map((task) => task.id)).toEqual([second.id]);
    await state.actions.perform(second, { kind: "complete" });
    expect(state.rows()).toEqual([]);
    slow.reject(new TypeError("connection lost"));
    await pending;
    expect(state.rows().map((task) => task.id)).toEqual([first.id]);
    expect(state.actions.getSnapshot()[0]?.pending).toBe(false);
  });

  it("retries an ambiguous snooze with the same request id, days and optimistic date", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push(init ?? {});
      if (calls.length === 1) throw new TypeError("response lost after server commit");
      return response({ ...first, status: "snoozed", due_date: "2026-10-28" });
    };
    const state = setup(fetchImpl);
    await state.actions.perform(first, { kind: "snooze", days: 3 }, new Date(2026, 9, 25, 12));
    const failed = state.actions.getSnapshot()[0]!;
    expect(state.rows().find((task) => task.id === first.id)?.status).toBe("open");
    // A changed gesture must not replace an unresolved write.
    await state.actions.perform(first, { kind: "snooze", days: 7 });
    expect(calls).toHaveLength(1);
    const retry = state.actions.retry(failed.requestId);
    expect(state.rows().find((task) => task.id === first.id)).toMatchObject({ status: "snoozed", due_date: "2026-10-28" });
    await retry;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(calls[1]?.body).toBe(JSON.stringify({ days: 3 }));
    expect(new Headers(calls[1]?.headers).get("Idempotency-Key")).toBe(failed.requestId);
    expect(new Headers(calls[0]?.headers).get("Idempotency-Key")).toBe(failed.requestId);
    expect(state.actions.getSnapshot()).toEqual([]);
  });

  it("retains pending overlays across a refetch and replaces the prediction with the server date", async () => {
    const slow = Promise.withResolvers<Response>();
    const state = setup(() => slow.promise);
    const pending = state.actions.perform(first, { kind: "snooze", days: 7 }, new Date(2026, 9, 25, 12));
    state.query.setQueryData(tasksQueryKey(state.scope), { tasks: [first, second] });
    expect(state.rows()[0]).toMatchObject({ status: "snoozed", due_date: "2026-11-01" });
    slow.resolve(response({ ...first, status: "snoozed", due_date: "2026-11-02" }));
    await pending;
    expect(state.rows().find((task) => task.id === first.id)?.due_date).toBe("2026-11-02");
  });

  it("keeps action state per scope and discards late answers after connection replacement", async () => {
    const slow = Promise.withResolvers<Response>();
    const state = setup(() => slow.promise);
    const pending = state.actions.perform(first, { kind: "complete" });
    expect(taskActions(state.query, "https://other.test#alex", state.client).getSnapshot()).toEqual([]);
    expect(taskActions(state.query, "https://mini.test#sam", state.client).getSnapshot()).toEqual([]);
    expect(taskActions(state.query, state.scope, state.client)).toBe(state.actions);
    state.query.clear();
    const replacement = taskActions(state.query, state.scope, state.client);
    expect(replacement).not.toBe(state.actions);
    slow.resolve(response({ ...first, status: "done" }));
    await pending;
    expect(state.query.getQueryData(tasksQueryKey(state.scope))).toBeUndefined();
  });

  it("keeps a successful snooze saved when its calendar update warns", async () => {
    const state = setup(async () => new Response(JSON.stringify({
      task: { ...first, status: "snoozed", due_date: "2026-10-28" },
      calendar_warning: "calendar update failed",
    }), { status: 200 }));
    await state.actions.perform(first, { kind: "snooze", days: 3 });
    expect(state.rows().find((task) => task.id === first.id)).toMatchObject({
      status: "snoozed", due_date: "2026-10-28",
    });
    const notice = state.actions.getSnapshot()[0]!;
    expect(notice).toMatchObject({ pending: false, error: null, warning: "calendar update failed" });
    state.actions.dismiss(notice.requestId);
    expect(state.actions.getSnapshot()).toEqual([]);
    expect(state.rows().find((task) => task.id === first.id)?.status).toBe("snoozed");
  });
});
