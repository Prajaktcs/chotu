import { QueryClient } from "@tanstack/react-query";

import { createApiClient, type PlanResponse } from "@/api";
import { workoutQueryKey } from "@/workout/queries";

import { planGeneration } from "./actions";
import { planQueryKey } from "./format";

const saved: PlanResponse = {
  date: "2026-10-28",
  week_start: "2026-10-26",
  plan: null,
  reason: "unreadable",
};
const response = () => new Response(JSON.stringify(saved), { status: 200 });

function setup(fetchImpl: typeof fetch) {
  const query = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const client = createApiClient({
    serverUrl: "https://mini.test",
    token: "test",
    memberId: "alex",
    fetch: fetchImpl,
  });
  const scope = "https://mini.test#alex";
  return { query, client, scope, actions: planGeneration(query, scope, client) };
}

it("retries a lost replacement response with the same key and mode, blocking new writes", async () => {
  const calls: { input: unknown; init: RequestInit | undefined }[] = [];
  const state = setup(async (input, init) => {
    calls.push({ input, init });
    if (calls.length === 1) throw new TypeError("response lost after commit");
    return response();
  });
  await state.actions.start(true);
  const operation = state.actions.getSnapshot();
  state.actions.dismiss();
  await state.actions.start(false);
  expect(calls).toHaveLength(1);
  expect(state.actions.getSnapshot()).toBe(operation);
  await state.actions.retry();
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.input)).toEqual([
    "https://mini.test/v1/plan/regenerate",
    "https://mini.test/v1/plan/regenerate",
  ]);
  for (const call of calls) {
    expect(new Headers(call.init?.headers).get("Idempotency-Key")).toBe(operation?.requestId);
    expect(call.init?.body).toBeUndefined();
  }
  expect(state.actions.getSnapshot()).toBeNull();
});

it("publishes the returned plan and invalidates workout after cancelling stale reads", async () => {
  const state = setup(async () => response());
  state.query.setQueryData(workoutQueryKey(state.scope), { workout: null });
  const cancel = jest.spyOn(state.query, "cancelQueries");
  await state.actions.start(false);
  expect(cancel).toHaveBeenCalledWith({ queryKey: planQueryKey(state.scope) });
  expect(state.query.getQueryData(planQueryKey(state.scope))).toEqual(saved);
  expect(state.query.getQueryState(workoutQueryKey(state.scope))?.isInvalidated).toBe(true);
});

it("retains an operation across tab owners and discards a late answer after connection clear", async () => {
  const slow = Promise.withResolvers<Response>();
  const state = setup(() => slow.promise);
  const pending = state.actions.start(true);
  expect(planGeneration(state.query, state.scope, state.client)).toBe(state.actions);
  expect(planGeneration(state.query, "other-profile", state.client).getSnapshot()).toBeNull();
  await state.actions.start(false);
  state.actions.dismiss();
  expect(state.actions.getSnapshot()?.pending).toBe(true);
  state.query.clear();
  const replacement = planGeneration(state.query, state.scope, state.client);
  slow.resolve(response());
  await pending;
  expect(state.query.getQueryData(planQueryKey(state.scope))).toBeUndefined();
  expect(state.query.getQueryData(workoutQueryKey(state.scope))).toBeUndefined();
  expect(replacement.getSnapshot()).toBeNull();
});

it("checks cache ownership again after cancelling plan reads", async () => {
  const state = setup(async () => response());
  const cancellation = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  jest.spyOn(state.query, "cancelQueries").mockImplementation(() => {
    cancelling.resolve();
    return cancellation.promise;
  });
  const pending = state.actions.start(false);
  await cancelling.promise;
  state.query.clear();
  cancellation.resolve();
  await pending;
  expect(state.query.getQueryData(planQueryKey(state.scope))).toBeUndefined();
});

it("allows dismissing a definitive refusal and refreshes the retained owner's client", async () => {
  const state = setup(
    async () =>
      new Response(JSON.stringify({ error: "Add goals", code: "no_fitness_goals" }), {
        status: 422,
      }),
  );
  await state.actions.start(false);
  expect(state.actions.getSnapshot()?.pending).toBe(false);
  state.actions.dismiss();
  expect(state.actions.getSnapshot()).toBeNull();
  const fetchImpl = jest.fn(async () => response());
  const client = createApiClient({
    serverUrl: "https://mini.test",
    token: "new",
    fetch: fetchImpl,
  });
  expect(planGeneration(state.query, state.scope, client)).toBe(state.actions);
  await state.actions.start(false);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([408, 409, 429, 502])("retains ambiguous HTTP %s for same-key retry", async (status) => {
  const fetchImpl = jest.fn(
    async () => new Response(JSON.stringify({ error: "Try again" }), { status }),
  );
  const state = setup(fetchImpl);
  await state.actions.start(true);
  const operation = state.actions.getSnapshot();
  state.actions.dismiss();
  await state.actions.start(false);
  expect(state.actions.getSnapshot()).toBe(operation);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
