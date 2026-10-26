import { APP_VERSION } from "./app-version";
import { ApiError } from "./errors";
import type {
  ErrorBody,
  Health,
  LogSetRequest,
  Me,
  SetDeletedResponse,
  SetLoggedResponse,
  TaskResponse,
  TasksResponse,
  WorkoutDoneResponse,
  WorkoutResponse,
} from "./types";

export type ApiClientConfig = {
  /** e.g. `https://mini.tailnet.ts.net:8787`; a trailing slash is fine. */
  serverUrl: string;
  /** The device token. Sent only as `Authorization: Bearer`. */
  token: string;
  /** The chosen profile, sent as `X-Chotu-Member`. Null before one is chosen. */
  memberId?: string | null;
  /** Defaults to this build's version. */
  appVersion?: string;
  /** Defaults to the global fetch; injectable for tests. */
  fetch?: typeof fetch;
};

type RequestOptions = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  /** Unauthenticated endpoints (health) send no token or member. */
  auth: boolean;
  body?: unknown;
  /** Required on writes. The caller keeps it so a retry reuses the same id. */
  idempotencyKey?: string;
};

/** Typed access to the coordinator's `/v1` API. */
export type ApiClient = {
  health(): Promise<Health>;
  me(): Promise<Me>;
  workout(): Promise<WorkoutResponse>;
  logSet(set: LogSetRequest, idempotencyKey: string): Promise<SetLoggedResponse>;
  finishWorkout(idempotencyKey: string): Promise<WorkoutDoneResponse>;
  deleteSet(setId: string, idempotencyKey: string): Promise<SetDeletedResponse>;
  tasks(): Promise<TasksResponse>;
  completeTask(taskId: string, requestId: string): Promise<TaskResponse>;
  snoozeTask(taskId: string, days: number, requestId: string): Promise<TaskResponse>;
};

export function createApiClient(config: ApiClientConfig): ApiClient {
  const request = <T>(options: RequestOptions) => send<T>(config, options);
  return {
    health: () => request({ method: "GET", path: "/v1/health", auth: false }),
    me: () => request({ method: "GET", path: "/v1/me", auth: true }),
    workout: () => request({ method: "GET", path: "/v1/workout", auth: true }),
    tasks: () => request({ method: "GET", path: "/v1/tasks", auth: true }),
    completeTask: (taskId, idempotencyKey) =>
      request({
        method: "POST",
        path: `/v1/tasks/${encodeURIComponent(taskId)}/complete`,
        auth: true,
        idempotencyKey,
      }),
    snoozeTask: (taskId, days, idempotencyKey) =>
      request({
        method: "POST",
        path: `/v1/tasks/${encodeURIComponent(taskId)}/snooze`,
        auth: true,
        body: { days },
        idempotencyKey,
      }),
    logSet: (set, idempotencyKey) =>
      request({ method: "POST", path: "/v1/workout/sets", auth: true, body: set, idempotencyKey }),
    finishWorkout: (idempotencyKey) =>
      request({ method: "POST", path: "/v1/workout/done", auth: true, idempotencyKey }),
    deleteSet: (setId, idempotencyKey) =>
      request({
        method: "DELETE",
        path: `/v1/workout/sets/${encodeURIComponent(setId)}`,
        auth: true,
        idempotencyKey,
      }),
  };
}

async function send<T>(config: ApiClientConfig, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Chotu-App-Version": config.appVersion ?? APP_VERSION,
  };
  if (options.auth) {
    headers.Authorization = `Bearer ${config.token}`;
    if (config.memberId) {
      headers["X-Chotu-Member"] = config.memberId;
    }
  }
  if (options.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const fetchImpl = config.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${config.serverUrl.replace(/\/+$/, "")}${options.path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (cause) {
    throw new ApiError({ kind: "network" }, { cause });
  }

  const body = await readJson(response);
  if (response.ok) {
    if (body === undefined) {
      throw new ApiError({ kind: "server", status: response.status });
    }
    // The JSON boundary: bodies are trusted to match types.ts, which mirrors
    // the server's serde structs.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return body as T;
  }
  throw errorFor(response.status, body);
}

/** The parsed JSON body, or undefined when there is none or it is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function errorFor(status: number, body: unknown): ApiError {
  const error = isErrorBody(body) ? body : undefined;
  if (status === 401) return new ApiError({ kind: "unauthorized", status: 401 });
  if (status === 403) return new ApiError({ kind: "forbidden", status: 403 });
  if (status === 426) {
    return new ApiError({
      kind: "updateRequired",
      status: 426,
      minAppVersion: error?.min_app_version ?? null,
    });
  }
  if (status >= 400 && status < 500) {
    return new ApiError({ kind: "rejected", status, message: error?.error ?? `HTTP ${status}` });
  }
  return new ApiError({ kind: "server", status });
}

function isErrorBody(body: unknown): body is ErrorBody {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
  );
}
