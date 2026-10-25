// Replay is strictly sequential by design: each set is sent, and its answer
// handled, before the next one goes.
/* oxlint-disable no-await-in-loop */

import { type ApiClient, ApiError, type LogSetRequest, type SetLoggedResponse } from "@/api";
import type { KeyValueStore } from "@/connection";

/**
 * A set waiting on this phone. Its request id and time are fixed at the tap
 * and never change, so a replay is the same write and the server dedupes it.
 */
export type QueuedSet = {
  /** UUIDv4, sent as `Idempotency-Key`. */
  requestId: string;
  exercise: string;
  /** In `unit`; null is bodyweight. */
  weight: number | null;
  unit: LogSetRequest["unit"];
  reps: number;
  /** RFC 3339 with the phone's offset at the tap. */
  performedAt: string;
  /**
   * Pending sends automatically. Failed is a definitive rejection (the server
   * stored it, so a resend with this id gets the same answer): it stays until
   * removed.
   */
  status: "pending" | "failed";
  /** The server's reason, for a failed set. */
  reason?: string;
};

export type NewSet = Omit<QueuedSet, "status" | "reason">;

export type QueueSnapshot = {
  /** Oldest first. */
  items: readonly QueuedSet[];
  /** False until the stored queue has been read (and while that read keeps failing). */
  loaded: boolean;
  /** The request id being sent right now. */
  sending: string | null;
  /** True after a transient failure (network, 5xx, 408, 429, 409 in flight): waiting to retry. */
  waiting: boolean;
  /** A 401, 403 or 426 stopped replay; the queue is kept. Cleared on the next attempt. */
  blocked: ApiError | null;
};

export type SetQueueOptions = {
  store: KeyValueStore;
  /** The server and profile; each has its own queue. */
  scope: string;
  /** The client for this scope; replaced with `setClient` when the token changes. */
  client?: ApiClient | null;
  /**
   * A set reached the server. Called before it leaves the queue; a returned
   * promise keeps it in the queue (and on screen) until it settles.
   */
  onDelivered?: (item: QueuedSet, response: SetLoggedResponse) => void | Promise<unknown>;
  /**
   * A replay run ended having changed the server's workout, or having lost
   * the answer to a set undone in flight (it may have landed): refresh it.
   */
  onSettled?: () => void;
  /** A set undone while in flight reached the server and was deleted (or not). */
  onUndoDelivered?: (deleted: boolean) => void;
  /** A fresh id for a follow-up DELETE. */
  newRequestId: () => string;
  /** Milliseconds before retry `attempt` (1, 2, …). Default: 2 s doubling to 60 s. */
  retryDelay?: (attempt: number) => number;
};

export const QUEUE_KEY_PREFIX = "chotu.set_queue.v1:";

export function queueKey(scope: string): string {
  return `${QUEUE_KEY_PREFIX}${scope}`;
}

const defaultRetryDelay = (attempt: number) => Math.min(60_000, 2_000 * 2 ** (attempt - 1));

/** Tries for the DELETE of a set undone while in flight. */
const DELETE_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The offline set queue for one scope. Every set write goes through it, online
 * or not, so there is one path:
 *
 * - `enqueue` saves the set to storage, then starts replay.
 * - Replay sends pending sets strictly in order, one at a time.
 * - 2xx: the set leaves the queue. Network error, 5xx, 408, 429 or 409 (in
 *   flight): it stays pending; replay stops and retries later with the same
 *   request id. 401/403/426: replay stops until the next attempt; the queue
 *   is kept. Any other 4xx: the set is marked failed with the server's reason
 *   (a definitive answer, stored under its id), and replay continues.
 *
 * Nothing is written to storage until the stored queue has been read, so a
 * failed read never overwrites sets saved earlier; replay retries the read.
 */
export class SetQueue {
  private readonly options: SetQueueOptions;
  private readonly key: string;
  private items: QueuedSet[] = [];
  private snapshot: QueueSnapshot;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private loaded = false;
  private running: Promise<void> | null = null;
  private sending: string | null = null;
  private blocked: ApiError | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = true;
  /** Request ids undone while in flight: deleted on the server if they land. */
  private undone = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private client: ApiClient | null;

  constructor(options: SetQueueOptions) {
    this.options = options;
    this.client = options.client ?? null;
    this.key = queueKey(options.scope);
    this.snapshot = this.buildSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): QueueSnapshot => this.snapshot;

  /**
   * Reads the stored queue once. Rejects when the read fails, and the next
   * call reads again. Sets enqueued before it succeeds go after the stored
   * ones, and are written then.
   */
  load(): Promise<void> {
    this.loading ??= this.options.store.getItem(this.key).then(
      (raw) => {
        const stored = parseQueue(raw);
        const ids = new Set(stored.map((item) => item.requestId));
        const unsaved = this.items.filter((item) => !ids.has(item.requestId));
        this.items = [...stored, ...unsaved];
        this.loaded = true;
        this.emit();
        if (unsaved.length > 0) void this.persist();
      },
      (error: unknown) => {
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  /** Resumes after `stop`, e.g. when the screen remounts. */
  start(): void {
    this.active = true;
    this.kick();
  }

  /** Stops replay and timers. The stored queue is untouched. */
  stop(): void {
    this.active = false;
    this.clearTimer();
  }

  /** Uses a new client (a replaced token) from the next request on. */
  setClient(client: ApiClient | null): void {
    this.client = client;
  }

  /**
   * Saves a set, then tries to send it (and anything before it). If the
   * stored queue can't be read yet, the set is kept in memory and written
   * once a read succeeds.
   */
  async enqueue(set: NewSet): Promise<QueuedSet> {
    await this.tryLoad();
    const item: QueuedSet = { ...set, status: "pending" };
    this.items = [...this.items, item];
    this.emit();
    await this.persist();
    this.kick();
    return item;
  }

  /**
   * Removes a set from the queue with no server call. If it is being sent
   * right now and that send succeeds, the delivered set is deleted.
   */
  async remove(requestId: string): Promise<void> {
    await this.tryLoad();
    if (this.sending === requestId) this.undone.add(requestId);
    this.drop(requestId);
    await this.persist();
  }

  /** Starts replay now (connection back, app foregrounded, set added). */
  kick(): void {
    void this.drain();
  }

  /** Replays until the queue is empty or replay has to wait or stop. */
  drain(): Promise<void> {
    if (this.running) return this.running;
    // Cleared at once, so a screen doesn't act on a stale 401 while replay starts.
    if (this.blocked) {
      this.blocked = null;
      this.emit();
    }
    this.running = this.replay().finally(() => {
      this.running = null;
      this.emit();
    });
    return this.running;
  }

  private async replay(): Promise<void> {
    if (!(await this.tryLoad())) {
      // Storage unreadable: send nothing (order unknown) and read again later.
      if (this.active) this.scheduleRetry();
      return;
    }
    if (!this.active) return;
    this.clearTimer();
    this.emit();
    let refresh = false;

    while (this.active) {
      const item = this.items.find((candidate) => candidate.status === "pending");
      const client = this.client;
      if (!item || !client) break;

      this.sending = item.requestId;
      this.emit();
      let outcome: { ok: true; response: SetLoggedResponse } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, response: await client.logSet(requestBody(item), item.requestId) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      this.sending = null;
      const undone = this.undone.delete(item.requestId);

      if (outcome.ok) {
        refresh = true;
        this.attempt = 0;
        if (undone) {
          void this.deleteDelivered(client, outcome.response.set.id);
        } else {
          await this.options.onDelivered?.(item, outcome.response);
        }
        this.drop(item.requestId);
        await this.persist();
        continue;
      }

      const error = outcome.error;
      if (isBlocking(error)) {
        this.blocked = error;
        this.emit();
        break;
      }
      if (undone) {
        // Already removed. If the server did get it (the answer was lost), it
        // shows up as a saved set once the workout is refreshed, and can be
        // undone there.
        if (isTransient(error)) refresh = true;
        continue;
      }
      if (isRejection(error)) {
        this.items = this.items.map((candidate) =>
          candidate.requestId === item.requestId
            ? { ...candidate, status: "failed", reason: error.detail.message }
            : candidate,
        );
        this.emit();
        await this.persist();
        continue;
      }
      // Transient (network, 5xx, 408, 429, 409 in flight): keep it, retry later.
      this.scheduleRetry();
      break;
    }

    if (refresh) this.options.onSettled?.();
  }

  /** Deletes a set undone in flight that landed: one key, up to 3 tries with backoff. */
  private async deleteDelivered(client: ApiClient, setId: string): Promise<void> {
    const key = this.options.newRequestId();
    for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
      try {
        await client.deleteSet(setId, key);
        this.options.onUndoDelivered?.(true);
        return;
      } catch (error) {
        if (!isTransient(error) || attempt === DELETE_ATTEMPTS) break;
        await sleep(this.retryDelay(attempt));
      }
    }
    this.options.onUndoDelivered?.(false);
  }

  /** Reads the stored queue; false (and nothing written) while that fails. */
  private tryLoad(): Promise<boolean> {
    return this.load().then(
      () => true,
      () => false,
    );
  }

  private retryDelay(attempt: number): number {
    return (this.options.retryDelay ?? defaultRetryDelay)(attempt);
  }

  private scheduleRetry(): void {
    this.attempt += 1;
    const delay = this.retryDelay(this.attempt);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, delay);
    this.emit();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private drop(requestId: string): void {
    this.items = this.items.filter((item) => item.requestId !== requestId);
    this.emit();
  }

  /**
   * Writes the queue; writes run in order so the last one wins. Skipped until
   * the stored queue has been read, so it is never overwritten unread.
   */
  private persist(): Promise<void> {
    if (!this.loaded) return this.writes;
    const raw = this.items.length > 0 ? JSON.stringify({ version: 1, items: this.items }) : null;
    this.writes = this.writes
      .then(() =>
        raw === null
          ? this.options.store.removeItem(this.key)
          : this.options.store.setItem(this.key, raw),
      )
      .catch(() => undefined);
    return this.writes;
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): QueueSnapshot {
    return {
      items: this.items,
      loaded: this.loaded,
      sending: this.sending,
      waiting: this.timer !== null,
      blocked: this.blocked,
    };
  }
}

function requestBody(item: QueuedSet): LogSetRequest {
  return {
    exercise: item.exercise,
    weight: item.weight,
    unit: item.unit,
    reps: item.reps,
    performed_at: item.performedAt,
  };
}

/** 401, 403, 426: nothing to retry until the user fixes the connection. */
function isBlocking(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    (error.kind === "unauthorized" || error.kind === "forbidden" || error.kind === "updateRequired")
  );
}

/** A 4xx the server stored: retrying the same request returns the same answer. */
function isRejection(
  error: unknown,
): error is ApiError & { detail: { kind: "rejected"; status: number; message: string } } {
  return error instanceof ApiError && error.detail.kind === "rejected" && !isTransient(error);
}

/**
 * 408 and 429 come from something in front of the server (a proxy), never
 * from a stored answer, so the same request id is still unused.
 */
const TRANSIENT_STATUSES = new Set([408, 429]);

/** 409 for an id whose first attempt is still running (not a stored answer). */
export function isInFlight(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.detail.kind === "rejected" &&
    error.detail.status === 409 &&
    /idempotency-key/i.test(error.detail.message)
  );
}

/** Safe to retry with the same id: no connection, 5xx, 408, 429, or 409 in flight. */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.kind === "network" || error.kind === "server" || isInFlight(error)) return true;
  return error.detail.kind === "rejected" && TRANSIENT_STATUSES.has(error.detail.status);
}

/** Reads a stored queue; anything unreadable is dropped item by item. */
export function parseQueue(raw: string | null): QueuedSet[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item): QueuedSet[] => {
    if (!isRecord(item)) return [];
    const { requestId, exercise, weight, unit, reps, performedAt, status, reason } = item;
    if (
      typeof requestId !== "string" ||
      typeof exercise !== "string" ||
      !(weight === null || typeof weight === "number") ||
      !(unit === "lb" || unit === "kg") ||
      typeof reps !== "number" ||
      typeof performedAt !== "string" ||
      !(status === "pending" || status === "failed")
    ) {
      return [];
    }
    const parsed: QueuedSet = { requestId, exercise, weight, unit, reps, performedAt, status };
    if (typeof reason === "string") parsed.reason = reason;
    return [parsed];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
