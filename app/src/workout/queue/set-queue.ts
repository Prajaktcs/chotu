// Replay is strictly sequential by design: each set is sent, and its answer
// handled, before the next one goes.
/* oxlint-disable no-await-in-loop */

import {
  type ApiClient,
  ApiError,
  type ApiErrorDetail,
  type LogSetRequest,
  type SetDeletedResponse,
  type SetLoggedResponse,
} from "@/api";
import { type KeyValueStore, needsRecovery } from "@/connection";

/**
 * A set waiting on this phone. Its request id and time are fixed at the tap,
 * so a replay is the same write and the server dedupes it. Only "Retry
 * unchanged" after a definitive rejection gives it a new request id (same
 * body and time), because the server stored that rejection under the old one.
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
  /** Pending sends automatically; failed waits for Retry unchanged or Remove. */
  status: "pending" | "failed";
  /** The server's reason, for a failed set. */
  reason?: string;
  /** A send was started: the server may have the set even without an answer. */
  sent?: boolean;
  /**
   * The server's id for the set, once a send succeeded. Set while
   * `onDelivered` settles, so an Undo then knows which set to delete (and
   * hides its saved row at once).
   */
  setId?: string;
  /**
   * Undone after a send was started. Kept (hidden) until the server confirms:
   * the POST is replayed with its request id to learn the set id, then the
   * set is deleted with `deleteKey`.
   */
  undo?: { deleteKey: string; setId?: string };
};

export type NewSet = Pick<
  QueuedSet,
  "requestId" | "exercise" | "weight" | "unit" | "reps" | "performedAt"
>;

/** An undone set the server didn't confirm as deleted: it may still be saved. */
export type UndoProblem = {
  set: NewSet;
  /**
   * `refused`: the server refused the DELETE (for example a 404 for a set more
   * than 7 days old), so the set may still be saved. `unknown`: the replayed
   * send was refused as more than 7 days old, which is what a send gets once
   * the server has forgotten the original request, so whether it landed is
   * unknown.
   */
  kind: "refused" | "unknown";
  /** Why, in words for the notice (usually the server's reason). */
  reason: string;
};

export type QueueSnapshot = {
  /** Sets to show, oldest first (undone ones being reconciled are left out). */
  items: readonly QueuedSet[];
  /** Undone sets still being removed from the server. */
  undoing: number;
  /** False until the stored queue has been read (and while that read keeps failing). */
  loaded: boolean;
  /**
   * False when the queue isn't on this phone's storage yet (a read or write
   * failed): the sets live only in memory until a retry succeeds.
   */
  saved: boolean;
  /** The request id being sent right now. */
  sending: string | null;
  /** True after a transient failure (network, 5xx, 408, 429, 409 in flight): waiting to retry. */
  waiting: boolean;
  /** A 401, 403 or 426 stopped replay; the queue is kept. Cleared on the next attempt. */
  blocked: ApiError | null;
  /** Undos the server didn't confirm, oldest first, until `clearUndoProblems`. Not stored. */
  undoProblems: readonly UndoProblem[];
  /**
   * Server ids of sets being undone. A saved row with one of these ids is
   * hidden: the set reached the server (and maybe the workout on screen)
   * just before or while it was undone, and is about to be deleted.
   */
  undoingSetIds: ReadonlySet<string>;
};

export type SetQueueOptions = {
  store: KeyValueStore;
  /** The server and profile; each has its own queue. */
  scope: string;
  /** The client for this scope; replaced with `setClient` when the token changes. */
  client?: ApiClient | null;
  /**
   * A set reached the server. Called before it leaves the queue. A returned
   * promise keeps it in the queue (and on screen) until it settles, and
   * stands in for `onSettled`'s refresh for that set.
   */
  onDelivered?: (item: QueuedSet, response: SetLoggedResponse) => void | Promise<unknown>;
  /**
   * A replay run ended having changed the server's workout (a set delivered
   * or undone, or an undo refused): refresh it. The one refresh per run.
   */
  onSettled?: () => void;
  /**
   * An undone set is off the server: deleted (with the server's answer), or
   * already gone (`null`). Called before it stops being hidden, so the
   * workout on screen can drop it first and it never shows again as saved.
   */
  onUndone?: (setId: string, response: SetDeletedResponse | null) => void;
  /** A fresh id for a DELETE or a retried set. */
  newRequestId: () => string;
  /** Milliseconds before retry `attempt` (1, 2, …). Default: 2 s doubling to 60 s. */
  retryDelay?: (attempt: number) => number;
  /** The phone's clock; injectable for tests. */
  now?: () => Date;
};

export const QUEUE_KEY_PREFIX = "chotu.set_queue.v1:";

export function queueKey(scope: string): string {
  return `${QUEUE_KEY_PREFIX}${scope}`;
}

const defaultRetryDelay = (attempt: number) => Math.min(60_000, 2_000 * 2 ** (attempt - 1));

/**
 * The server deletes any of a member's sets done within the last 7 days, so a
 * 404 for a set done within this window means it is already gone. A day short
 * of 7, for clock and timezone differences.
 */
const SURE_DELETABLE_MS = 6 * 24 * 60 * 60 * 1000;

/**
 * The `code` on the server's 422 for a set more than 7 days old. A replayed
 * send gets it once the server has forgotten the original request (ids are
 * kept 7 days), even if that request landed. Any other 422 is a stored
 * rejection.
 */
const TOO_OLD_CODE = "too_old";

/** The same 422's message, without a code, from servers older than the code. */
const LEGACY_TOO_OLD_MESSAGE = "performed_at is more than 7 days old";

function isTooOld(error: Rejection): boolean {
  if (error.detail.status !== 422) return false;
  if (error.detail.code !== undefined) return error.detail.code === TOO_OLD_CODE;
  // A coordinator deployed before the code existed: its message is all there is.
  return error.detail.message === LEGACY_TOO_OLD_MESSAGE;
}

/** After one request: carry on (`refresh`: and refresh the workout at the end), retry later, or stop. */
type Step = "next" | "refresh" | "wait" | "stop";

type Outcome<T> = { ok: true; response: T } | { ok: false; error: unknown };

async function settle<T>(send: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, response: await send() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * The offline set queue for one scope. Every set write goes through it, online
 * or not, so there is one path:
 *
 * - `enqueue` saves the set to storage, then starts replay.
 * - Replay sends sets strictly in order, one at a time.
 * - 2xx: the set leaves the queue. Network error, 5xx, 408, 429 or 409 (in
 *   flight): it stays pending; replay stops and retries later with the same
 *   request id. 401/403/426: replay stops until the next attempt; the queue
 *   is kept. Any other 4xx: the set is marked failed with the server's reason
 *   (stored under its id), and replay continues.
 * - Undo of a set that was never sent drops it. Undo after a send started
 *   keeps an undo record until the server answers the DELETE. An undo the
 *   server didn't confirm is reported in `undoProblems`.
 *
 * Nothing is written until the stored queue has been read, so a failed read
 * never overwrites sets saved earlier. A failed read or write shows as
 * `saved: false` and is retried.
 */
export class SetQueue {
  private readonly options: SetQueueOptions;
  private readonly key: string;
  private items: QueuedSet[] = [];
  private snapshot: QueueSnapshot;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private loaded = false;
  private writeFailed = false;
  private running: Promise<void> | null = null;
  private sending: string | null = null;
  private blocked: ApiError | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writeAttempt = 0;
  private active = true;
  private writes: Promise<void> = Promise.resolve();
  private undoProblems: readonly UndoProblem[] = [];
  private undoingSetIds: ReadonlySet<string> = new Set();
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

  /**
   * Resumes after `stop`, e.g. when the screen remounts. A write that failed
   * is tried again: `stop` cancelled its retry, and replay may have nothing
   * to send (and so nothing to write).
   */
  start(): void {
    this.active = true;
    if (this.writeFailed) void this.persist();
    this.kick();
  }

  /** Stops replay and timers. The stored queue is untouched. */
  stop(): void {
    this.active = false;
    this.clearTimer();
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
  }

  /**
   * Forgets undo problems once they have been shown: those in `shown`, by
   * identity, so one reported since stays until it is shown too.
   */
  clearUndoProblems(shown: readonly UndoProblem[]): void {
    const kept = this.undoProblems.filter((problem) => !shown.includes(problem));
    if (kept.length === this.undoProblems.length) return;
    this.undoProblems = kept;
    this.emit();
  }

  /** Uses a new client (a replaced token) from the next request on. */
  setClient(client: ApiClient | null): void {
    this.client = client;
  }

  /**
   * Adds a set, writes the queue, then tries to send it (and anything before
   * it). If storage fails, the set is kept in memory and the snapshot says
   * `saved: false` until a retried write succeeds.
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
   * Undoes a set on this phone. One that was never sent, or that the server
   * rejected, is dropped with no server call. One whose send started may be
   * on the server: it stays as an undo record until replay deletes it there.
   */
  async remove(requestId: string): Promise<void> {
    await this.tryLoad();
    const item = this.items.find((candidate) => candidate.requestId === requestId);
    if (!item) return;
    const mayBeOnServer =
      item.status === "pending" && (item.sent === true || this.sending === requestId);
    if (mayBeOnServer) {
      // Delivered already (onDelivered is settling): its id is known, so its
      // saved row is hidden at once.
      const { setId } = item;
      const deleteKey = this.options.newRequestId();
      this.update(requestId, { undo: setId ? { deleteKey, setId } : { deleteKey } });
    } else {
      this.drop(requestId);
    }
    await this.persist();
    if (mayBeOnServer) this.kick();
  }

  /**
   * Sends a failed set again: same body and time, new request id. The server
   * stored its rejection under the old id, so only a new one can succeed (for
   * example a set whose time was ahead of the server's clock).
   */
  async retry(requestId: string): Promise<void> {
    await this.tryLoad();
    this.items = this.items.map((item): QueuedSet =>
      item.requestId === requestId && item.status === "failed"
        ? { ...fieldsOf(item), requestId: this.options.newRequestId(), status: "pending" }
        : item,
    );
    this.emit();
    await this.persist();
    this.kick();
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
      const item = this.items.find(
        (candidate) => candidate.status === "pending" || candidate.undo !== undefined,
      );
      const client = this.client;
      if (!item || !client) break;

      const step = item.undo?.setId
        ? await this.deleteUndone(client, item)
        : await this.send(client, item);
      if (step === "refresh") refresh = true;
      if (step === "wait") {
        this.scheduleRetry();
        break;
      }
      if (step === "stop") break;
    }

    if (refresh) this.options.onSettled?.();
  }

  /** POSTs a set (or replays it, for an undo record, to learn its id). */
  private async send(client: ApiClient, item: QueuedSet): Promise<Step> {
    const { requestId } = item;
    if (!item.sent) {
      // Recorded first: after this, Undo must reconcile with the server.
      this.update(requestId, { sent: true });
      await this.persist();
    }
    this.sending = requestId;
    this.emit();
    const outcome = await settle(() => client.logSet(requestBody(item), requestId));
    this.sending = null;
    // Re-read: Undo may have marked it while the request was out.
    const current = this.find(requestId);
    if (!current) return "next";

    if (outcome.ok) {
      this.attempt = 0;
      this.update(requestId, { setId: outcome.response.set.id });
      const shown = current.undo
        ? undefined
        : this.options.onDelivered?.(current, outcome.response);
      // A promise means the callback refreshed the workout itself.
      const refreshed = shown !== undefined;
      await shown;
      // Re-read again: Undo may have come while that was awaited.
      const latest = this.find(requestId);
      if (!latest) return "next";
      if (latest.undo) {
        // The set is on the server: keep the undo, now with the set's id, and
        // delete it next.
        this.update(requestId, { undo: { ...latest.undo, setId: outcome.response.set.id } });
        await this.persist();
        return "next";
      }
      this.drop(requestId);
      await this.persist();
      return refreshed ? "next" : "refresh";
    }
    const { error } = outcome;
    if (needsRecovery(error)) {
      this.blocked = error;
      this.emit();
      return "stop";
    }
    if (isRejection(error)) {
      if (current.undo) {
        // A stored rejection means the set never landed: nothing to delete.
        // "Too old" is also what a send gets once the server has forgotten its
        // request, even if it landed then: say so.
        if (isTooOld(error)) {
          this.reportUndoProblem(current, "unknown", error.detail.message);
        }
        this.drop(requestId);
      } else {
        this.replace(requestId, {
          ...fieldsOf(current),
          status: "failed",
          reason: error.detail.message,
        });
      }
      await this.persist();
      return "next";
    }
    return "wait";
  }

  /** Deletes an undone set whose id is known; forgets it once the server answers. */
  private async deleteUndone(client: ApiClient, item: QueuedSet): Promise<Step> {
    const undo = item.undo;
    if (!undo?.setId) return "next";
    const setId = undo.setId;
    this.sending = item.requestId;
    this.emit();
    const outcome = await settle(() => client.deleteSet(setId, undo.deleteKey));
    this.sending = null;
    if (outcome.ok) {
      this.attempt = 0;
      this.options.onUndone?.(setId, outcome.response);
      this.drop(item.requestId);
      await this.persist();
      return "refresh";
    }
    const { error } = outcome;
    if (needsRecovery(error)) {
      this.blocked = error;
      this.emit();
      return "stop";
    }
    if (isRejection(error)) {
      // The server's final answer. A 404 is a set it can't find. The id came
      // from this member's own POST to this server (so it isn't another
      // member's or a typo), and server and app ship from the same repo with
      // the 7-day delete, so a set done recently enough to always be
      // deletable is already gone (deleted elsewhere): the undo is done. An older one is too old to
      // delete. Anything else: the set may still be saved. Say why, and
      // refresh so a set still saved shows again.
      if (error.detail.status !== 404) {
        this.reportUndoProblem(item, "refused", error.detail.message);
      } else if (this.surelyDeletable(item)) {
        this.options.onUndone?.(setId, null);
      } else {
        this.reportUndoProblem(item, "refused", "it's more than 7 days old");
      }
      this.drop(item.requestId);
      await this.persist();
      return "refresh";
    }
    return "wait";
  }

  private find(requestId: string): QueuedSet | undefined {
    return this.items.find((candidate) => candidate.requestId === requestId);
  }

  private reportUndoProblem(item: QueuedSet, kind: UndoProblem["kind"], reason: string): void {
    this.undoProblems = [...this.undoProblems, { set: fieldsOf(item), kind, reason }];
    this.emit();
  }

  /** Done recently enough that the server always deletes it (see SURE_DELETABLE_MS). */
  private surelyDeletable(item: QueuedSet): boolean {
    const done = Date.parse(item.performedAt);
    const now = (this.options.now?.() ?? new Date()).getTime();
    return Number.isFinite(done) && now - done < SURE_DELETABLE_MS;
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

  private update(requestId: string, changes: Partial<QueuedSet>): void {
    this.items = this.items.map((item) =>
      item.requestId === requestId ? { ...item, ...changes } : item,
    );
    this.emit();
  }

  private replace(requestId: string, next: QueuedSet): void {
    this.items = this.items.map((item) => (item.requestId === requestId ? next : item));
    this.emit();
  }

  private drop(requestId: string): void {
    this.items = this.items.filter((item) => item.requestId !== requestId);
    this.emit();
  }

  /**
   * Writes the queue; writes run in order so the last one wins. Skipped until
   * the stored queue has been read, so it is never overwritten unread. A
   * failed write marks the queue unsaved and is retried with backoff.
   */
  private persist(): Promise<void> {
    if (!this.loaded) return this.writes;
    this.writes = this.writes.then(async () => {
      const items = this.items;
      try {
        if (items.length === 0) {
          await this.options.store.removeItem(this.key);
        } else {
          await this.options.store.setItem(this.key, JSON.stringify({ version: 1, items }));
        }
        this.writeAttempt = 0;
        if (this.writeFailed) {
          this.writeFailed = false;
          this.emit();
        }
      } catch {
        this.writeFailed = true;
        this.emit();
        this.scheduleWrite();
      }
    });
    return this.writes;
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null || !this.active) return;
    this.writeAttempt += 1;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      if (this.writeFailed) void this.persist();
    }, this.retryDelay(this.writeAttempt));
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): QueueSnapshot {
    const visible = this.items.filter((item) => item.undo === undefined);
    const ids = this.items.flatMap((item) => (item.undo?.setId ? [item.undo.setId] : []));
    // The same set while its ids don't change, so screens don't re-render for it.
    if (!sameIds(this.undoingSetIds, ids)) this.undoingSetIds = new Set(ids);
    return {
      items: visible.length === this.items.length ? this.items : visible,
      undoing: this.items.length - visible.length,
      loaded: this.loaded,
      // An empty queue whose write failed isn't saved either: the sets it
      // removed would come back after a restart.
      saved: !this.writeFailed && (this.loaded || this.items.length === 0),
      sending: this.sending,
      waiting: this.timer !== null,
      blocked: this.blocked,
      undoProblems: this.undoProblems,
      undoingSetIds: this.undoingSetIds,
    };
  }
}

function sameIds(current: ReadonlySet<string>, ids: readonly string[]): boolean {
  return current.size === ids.length && ids.every((id) => current.has(id));
}

/** The set as tapped, without its send state. */
function fieldsOf(item: QueuedSet): NewSet {
  return {
    requestId: item.requestId,
    exercise: item.exercise,
    weight: item.weight,
    unit: item.unit,
    reps: item.reps,
    performedAt: item.performedAt,
  };
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

type Rejection = ApiError & { detail: Extract<ApiErrorDetail, { kind: "rejected" }> };

/** A 4xx the server stored: retrying the same request returns the same answer. */
function isRejection(error: unknown): error is Rejection {
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
    const { requestId, exercise, weight, unit, reps, performedAt, status, reason, sent, undo } =
      item;
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
    if (sent === true) parsed.sent = true;
    if (typeof item.setId === "string") parsed.setId = item.setId;
    if (isRecord(undo) && typeof undo.deleteKey === "string") {
      parsed.undo = { deleteKey: undo.deleteKey };
      if (typeof undo.setId === "string") parsed.undo.setId = undo.setId;
    }
    return [parsed];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
