import { createApiClient } from "@/api";
import { browserStore, type KeyValueStore } from "@/connection";

import { type NewSet, parseQueue, queueKey, SetQueue } from "./set-queue";

const SCOPE = "https://mini.ts.net:8787#alex";

type Sent = {
  method: string;
  path: string;
  key: string | undefined;
  body: Record<string, unknown> | null;
};

type Reply = Response | "offline";

/**
 * A fake server: `reply` answers each request. Records what was sent, even
 * for requests whose answer is lost.
 */
function fakeServer(reply: (sent: Sent, index: number) => Reply) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = Object.fromEntries(new Headers(init.headers));
    const request: Sent = {
      method: init.method ?? "GET",
      path: url.pathname,
      key: headers["idempotency-key"],
      body: typeof init.body === "string" ? record(JSON.parse(init.body)) : null,
    };
    sent.push(request);
    const response = reply(request, sent.length - 1);
    if (response === "offline") return Promise.reject(new TypeError("Network request failed"));
    return Promise.resolve(response);
  };
  const client = createApiClient({
    serverUrl: "https://mini.ts.net:8787",
    token: "alex_phone.secret",
    memberId: "alex",
    appVersion: "0.1.0",
    fetch: fetchImpl,
  });
  return { sent, client, posts: () => sent.filter((s) => s.method === "POST") };
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const workout = {
  session_id: "s1",
  current_exercise: "Bench press",
  plan_day: null,
  exercises: [],
  sets: [],
};

function logged(sent: Sent, id = `set-${sent.key}`): Response {
  return json(201, {
    set: { id, exercise: sent.body?.exercise, weight_lb: sent.body?.weight, reps: sent.body?.reps },
    workout,
  });
}

function memoryStore(): KeyValueStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    ...browserStore({
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value);
      },
      removeItem: (key) => {
        items.delete(key);
      },
    }),
  };
}

let ids = 0;
const newRequestId = () => `delete-${(ids += 1)}`;

function set(n: number): NewSet {
  return {
    requestId: `00000000-0000-4000-8000-00000000000${n}`,
    exercise: "Bench press",
    weight: 60,
    unit: "kg",
    reps: n,
    performedAt: `2026-10-24T09:3${n}:00-04:00`,
  };
}

/** Polls `done` across macrotasks (for work the queue does in the background). */
async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !done(); i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one macrotask per check, in order
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** A promise resolved from outside, to hold a request open. */
function deferred<T>() {
  const holder: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((done) => {
    holder.resolve = done;
  });
  return { promise, resolve: (value: T) => holder.resolve?.(value) };
}

const queues: SetQueue[] = [];

function makeQueue(store: KeyValueStore, client: ReturnType<typeof fakeServer>["client"]) {
  const queue = new SetQueue({
    store,
    scope: SCOPE,
    client,
    newRequestId,
    // Never retry on a timer in tests; each test kicks replay itself.
    retryDelay: () => 60 * 60 * 1000,
  });
  queues.push(queue);
  return queue;
}

afterEach(() => {
  for (const queue of queues.splice(0)) queue.stop();
});

describe("SetQueue", () => {
  it("sends a set with its request id and tap time, then forgets it", async () => {
    const server = fakeServer((sent) => logged(sent));
    const store = memoryStore();
    const onDelivered = jest.fn();
    const queue = new SetQueue({
      store,
      scope: SCOPE,
      client: server.client,
      newRequestId,
      onDelivered,
    });
    queues.push(queue);

    await queue.enqueue(set(1));
    await queue.drain();

    expect(server.posts()).toEqual([
      {
        method: "POST",
        path: "/v1/workout/sets",
        key: set(1).requestId,
        body: {
          exercise: "Bench press",
          weight: 60,
          unit: "kg",
          reps: 1,
          performed_at: "2026-10-24T09:31:00-04:00",
        },
      },
    ]);
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().items).toEqual([]);
    expect(store.items.size).toBe(0);
  });

  it("keeps 5 offline sets through a restart and sends exactly those 5, in order", async () => {
    let online = false;
    const server = fakeServer((sent) => (online ? logged(sent) : "offline"));
    const store = memoryStore();

    const before = makeQueue(store, server.client);
    await [1, 2, 3, 4, 5].reduce(
      (previous, n) => previous.then(() => before.enqueue(set(n))).then(() => undefined),
      Promise.resolve(),
    );
    await before.drain();
    expect(before.getSnapshot().items.map((item) => item.status)).toEqual(Array(5).fill("pending"));
    expect(before.getSnapshot().waiting).toBe(true);
    // Strict order: replay stops at the first unsent set instead of skipping it.
    expect(new Set(server.posts().map((post) => post.key))).toEqual(new Set([set(1).requestId]));

    // The app is killed: a new queue reads the same storage.
    before.stop();
    server.sent.length = 0;
    online = true;
    const after = makeQueue(store, server.client);
    after.start();
    await after.drain();

    expect(server.posts().map((post) => [post.key, post.body?.performed_at])).toEqual(
      [1, 2, 3, 4, 5].map((n) => [set(n).requestId, set(n).performedAt]),
    );
    expect(after.getSnapshot().items).toEqual([]);
    expect(store.items.size).toBe(0);
  });

  it("replays the same request id when a response is lost", async () => {
    // The server applies the first attempt, but the phone sees a network error.
    const applied = new Map<string, Response>();
    const server = fakeServer((sent, index) => {
      const key = sent.key ?? "";
      if (!applied.has(key)) applied.set(key, logged(sent));
      return index === 0 ? "offline" : (applied.get(key)?.clone() ?? "offline");
    });
    const queue = makeQueue(memoryStore(), server.client);

    await queue.enqueue(set(1));
    await queue.drain();
    expect(queue.getSnapshot().items).toHaveLength(1);

    queue.kick();
    await queue.drain();

    expect(server.posts().map((post) => post.key)).toEqual([set(1).requestId, set(1).requestId]);
    expect(applied.size).toBe(1);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it.each([
    ["a 5xx", () => json(503, { error: "unavailable" })],
    [
      "a 409 while the first attempt is in flight",
      () => json(409, { error: "a request with this Idempotency-Key is still in progress" }),
    ],
    ["a 408 from a proxy", () => json(408, { error: "request timeout" })],
    ["a 429 from a proxy", () => new Response("Too Many Requests", { status: 429 })],
  ])("keeps a set pending after %s", async (_, failure) => {
    const server = fakeServer((sent, index) => (index === 0 ? failure() : logged(sent)));
    const queue = makeQueue(memoryStore(), server.client);

    await queue.enqueue(set(1));
    await queue.drain();
    expect(queue.getSnapshot()).toMatchObject({ waiting: true, items: [{ status: "pending" }] });

    queue.kick();
    await queue.drain();
    expect(server.posts().map((post) => post.key)).toEqual([set(1).requestId, set(1).requestId]);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it("marks a rejected set failed with the server's reason and sends the next", async () => {
    const server = fakeServer((sent) =>
      sent.key === set(1).requestId
        ? json(422, { error: "performed_at is more than 7 days old" })
        : logged(sent),
    );
    const store = memoryStore();
    const queue = makeQueue(store, server.client);

    await queue.enqueue(set(1));
    await queue.enqueue(set(2));
    await queue.drain();

    expect(server.posts().map((post) => post.key)).toEqual([set(1).requestId, set(2).requestId]);
    expect(queue.getSnapshot().items).toEqual([
      { ...set(1), status: "failed", reason: "performed_at is more than 7 days old" },
    ]);
    // Kept on the phone, so it survives a restart too.
    expect(parseQueue(store.items.get(queueKey(SCOPE)) ?? null)).toHaveLength(1);
  });

  it("retries a rejected set unchanged with a fresh request id", async () => {
    // Like the server: every non-5xx answer is stored under its key and replayed.
    let clockCaughtUp = false;
    const stored = new Map<string, Response>();
    const server = fakeServer((sent) => {
      const key = sent.key ?? "";
      if (!stored.has(key)) {
        stored.set(
          key,
          clockCaughtUp
            ? logged(sent)
            : json(422, { error: "performed_at is more than 5 minutes in the future" }),
        );
      }
      return stored.get(key)?.clone() ?? "offline";
    });
    let n = 0;
    const queue = new SetQueue({
      store: memoryStore(),
      scope: SCOPE,
      client: server.client,
      newRequestId: () => `retry-${(n += 1)}`,
    });
    queues.push(queue);
    await queue.enqueue(set(1));
    await queue.drain();
    expect(queue.getSnapshot().items[0]?.status).toBe("failed");

    clockCaughtUp = true;
    await queue.retry(set(1).requestId);
    await queue.drain();

    expect(server.posts().map((post) => [post.key, post.body?.performed_at])).toEqual([
      [set(1).requestId, set(1).performedAt],
      ["retry-1", set(1).performedAt],
    ]);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it.each([
    [401, "unauthorized", { error: "missing or invalid device token" }],
    [403, "forbidden", { error: "member not allowed for this device" }],
    [426, "updateRequired", { error: "app update required", min_app_version: "0.2.0" }],
  ])("stops replay on a %i and keeps the queue", async (status, kind, body) => {
    const server = fakeServer(() => json(status, body));
    const store = memoryStore();
    const queue = makeQueue(store, server.client);

    await queue.enqueue(set(1));
    await queue.enqueue(set(2));
    await queue.drain();

    expect(server.posts()).toHaveLength(1);
    expect(queue.getSnapshot().blocked?.kind).toBe(kind);
    expect(queue.getSnapshot().items.map((item) => item.status)).toEqual(["pending", "pending"]);
    expect(parseQueue(store.items.get(queueKey(SCOPE)) ?? null)).toHaveLength(2);
  });

  it("undoes a pending set with no server call", async () => {
    const server = fakeServer(() => "offline");
    const store = memoryStore();
    const queue = makeQueue(store, server.client);
    await queue.enqueue(set(1));
    await queue.enqueue(set(2));
    await queue.drain();
    server.sent.length = 0;

    await queue.remove(set(2).requestId);

    expect(server.sent).toEqual([]);
    expect(queue.getSnapshot().items.map((item) => item.requestId)).toEqual([set(1).requestId]);
    expect(parseQueue(store.items.get(queueKey(SCOPE)) ?? null)).toHaveLength(1);
  });

  it("deletes a set undone while in flight once it lands, with a fresh key", async () => {
    const reply = deferred<void>();
    const server = fakeServer((sent) => {
      if (sent.method === "DELETE") return json(200, { set: {}, workout });
      return "offline";
    });
    // Hold the POST open so the undo happens mid-flight.
    const client = {
      ...server.client,
      logSet: jest.fn(() =>
        reply.promise.then(() => ({
          set: { id: "landed", exercise: "Bench press", weight_lb: 132.3, reps: 1 },
          workout,
        })),
      ),
    };
    const onUndoDelivered = jest.fn();
    const queue = new SetQueue({
      store: memoryStore(),
      scope: SCOPE,
      client,
      newRequestId: () => "fresh-key",
      onUndoDelivered,
    });
    queues.push(queue);

    await queue.enqueue(set(1));
    await waitUntil(() => queue.getSnapshot().sending !== null);
    expect(queue.getSnapshot().sending).toBe(set(1).requestId);
    await queue.remove(set(1).requestId);
    expect(queue.getSnapshot().items).toEqual([]);

    reply.resolve();
    await queue.drain();

    expect(server.sent).toEqual([
      { method: "DELETE", path: "/v1/workout/sets/landed", key: "fresh-key", body: null },
    ]);
    expect(onUndoDelivered.mock.calls[0]?.[0]).toBe(true);
    expect(queue.getSnapshot()).toMatchObject({ items: [], undoing: 0 });
  });

  it("never overwrites stored sets when reading storage fails", async () => {
    const server = fakeServer(() => "offline");
    const store = memoryStore();
    store.items.set(
      queueKey(SCOPE),
      JSON.stringify({ version: 1, items: [{ ...set(1), status: "pending" }] }),
    );
    let readable = false;
    const flaky: KeyValueStore = {
      ...store,
      getItem: (key) => (readable ? store.getItem(key) : Promise.reject(new Error("disk busy"))),
    };
    const queue = makeQueue(flaky, server.client);

    queue.start();
    await queue.enqueue(set(2));
    await queue.drain();

    // Not read yet: nothing written, nothing sent, the new set kept in memory.
    expect(queue.getSnapshot().loaded).toBe(false);
    expect(parseQueue(store.items.get(queueKey(SCOPE)) ?? null)).toEqual([
      { ...set(1), status: "pending" },
    ]);
    expect(server.posts()).toEqual([]);
    expect(queue.getSnapshot().items.map((item) => item.requestId)).toEqual([set(2).requestId]);

    readable = true;
    queue.kick();
    await queue.drain();

    expect(queue.getSnapshot().loaded).toBe(true);
    expect(parseQueue(store.items.get(queueKey(SCOPE)) ?? null).map((i) => i.requestId)).toEqual([
      set(1).requestId,
      set(2).requestId,
    ]);
    // Stored sets go first.
    expect(server.posts().map((post) => post.key)).toEqual([set(1).requestId]);
  });

  it("keeps a delivered set queued until onDelivered settles", async () => {
    const server = fakeServer((sent) => logged(sent));
    const refetch = deferred<void>();
    const queue = new SetQueue({
      store: memoryStore(),
      scope: SCOPE,
      client: server.client,
      newRequestId,
      onDelivered: () => refetch.promise,
    });
    queues.push(queue);

    await queue.enqueue(set(1));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(server.posts()).toHaveLength(1);
    expect(queue.getSnapshot().items.map((item) => item.requestId)).toEqual([set(1).requestId]);

    refetch.resolve();
    await queue.drain();
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it("backs off between retries of the DELETE for a set undone in flight", async () => {
    const reply = deferred<void>();
    let deletes = 0;
    const server = fakeServer((sent) => {
      if (sent.method !== "DELETE") return "offline";
      deletes += 1;
      return deletes < 3 ? json(503, { error: "unavailable" }) : json(200, { set: {}, workout });
    });
    const client = {
      ...server.client,
      logSet: jest.fn(() =>
        reply.promise.then(() => ({
          set: { id: "landed", exercise: "Bench press", weight_lb: 132.3, reps: 1 },
          workout,
        })),
      ),
    };
    const retryDelay = jest.fn(() => 0);
    const onUndoDelivered = jest.fn();
    const queue = new SetQueue({
      store: memoryStore(),
      scope: SCOPE,
      client,
      newRequestId: () => "fresh-key",
      retryDelay,
      onUndoDelivered,
    });
    queues.push(queue);

    await queue.enqueue(set(1));
    await waitUntil(() => queue.getSnapshot().sending !== null);
    expect(queue.getSnapshot().sending).toBe(set(1).requestId);
    await queue.remove(set(1).requestId);
    reply.resolve();
    await queue.drain();
    await waitUntil(() => onUndoDelivered.mock.calls.length > 0);

    expect(server.sent.map((s) => [s.method, s.key])).toEqual(
      Array.from({ length: 3 }, () => ["DELETE", "fresh-key"]),
    );
    expect(retryDelay.mock.calls).toEqual([[1], [2]]);
    expect(onUndoDelivered.mock.calls[0]?.[0]).toBe(true);
  });

  it("deletes a set whose answer was lost and was then undone", async () => {
    // The POST commits but the phone sees a network error; the server keeps
    // the 201 under the request id, as the real one does.
    const stored = new Map<string, Response>();
    const onServer = new Set<string>();
    let lose = true;
    const server = fakeServer((sent) => {
      if (sent.method === "DELETE") {
        const id = sent.path.split("/").pop() ?? "";
        if (!onServer.delete(id)) return json(404, { error: "set not found" });
        return json(200, { set: { id }, workout });
      }
      const key = sent.key ?? "";
      if (!stored.has(key)) {
        stored.set(key, logged(sent));
        onServer.add(`set-${key}`);
      }
      if (lose) {
        lose = false;
        return "offline";
      }
      return stored.get(key)?.clone() ?? "offline";
    });
    const store = memoryStore();
    const onUndoDelivered = jest.fn();
    const queue = new SetQueue({
      store,
      scope: SCOPE,
      client: server.client,
      newRequestId: () => "delete-key",
      onUndoDelivered,
      retryDelay: () => 60 * 60 * 1000,
    });
    queues.push(queue);
    await queue.enqueue(set(1));
    await queue.drain();
    expect(onServer.size).toBe(1);

    await queue.remove(set(1).requestId);
    // Gone from the screen at once, but the undo is kept on the phone.
    expect(queue.getSnapshot()).toMatchObject({ items: [], undoing: 1 });
    expect(parseQueue(store.items.get(queueKey(SCOPE)) ?? null)).toEqual([
      expect.objectContaining({ requestId: set(1).requestId, undo: { deleteKey: "delete-key" } }),
    ]);

    queue.kick();
    await queue.drain();

    expect(server.sent.map((s) => [s.method, s.key])).toEqual([
      ["POST", set(1).requestId],
      ["POST", set(1).requestId],
      ["DELETE", "delete-key"],
    ]);
    expect(onServer.size).toBe(0);
    expect(onUndoDelivered.mock.calls[0]?.[0]).toBe(true);
    expect(queue.getSnapshot()).toMatchObject({ items: [], undoing: 0 });
    expect(store.items.size).toBe(0);
  });

  it("says a set isn't saved on the phone when storage refuses the write, and retries", async () => {
    const server = fakeServer(() => "offline");
    const store = memoryStore();
    let writable = false;
    const flaky: KeyValueStore = {
      ...store,
      setItem: (key, value) =>
        writable ? store.setItem(key, value) : Promise.reject(new Error("disk full")),
    };
    const queue = new SetQueue({
      store: flaky,
      scope: SCOPE,
      client: server.client,
      newRequestId,
      retryDelay: () => 0,
    });
    queues.push(queue);

    await queue.enqueue(set(1));
    expect(queue.getSnapshot()).toMatchObject({ saved: false, items: [{ status: "pending" }] });
    expect(store.items.size).toBe(0);

    writable = true;
    await waitUntil(() => queue.getSnapshot().saved);
    expect(queue.getSnapshot().saved).toBe(true);
    expect(parseQueue(store.items.get(queueKey(SCOPE)) ?? null)).toEqual([
      expect.objectContaining({ requestId: set(1).requestId, status: "pending" }),
    ]);
  });

  it("drops unreadable stored data instead of crashing", () => {
    expect(parseQueue("{")).toEqual([]);
    expect(parseQueue(JSON.stringify({ version: 2, items: [] }))).toEqual([]);
    expect(
      parseQueue(
        JSON.stringify({ version: 1, items: [{ ...set(1), status: "pending" }, { bad: 1 }] }),
      ),
    ).toEqual([{ ...set(1), status: "pending" }]);
  });

  it("keeps each server and profile's queue separate", () => {
    expect(queueKey("https://a#alex")).not.toBe(queueKey("https://a#jordan"));
    expect(queueKey("https://a#alex")).not.toBe(queueKey("https://b#alex"));
  });
});
