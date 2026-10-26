# App API

The coordinator can serve an HTTP API for the Chotu app. It is off unless `api.bind` is set in `config.yaml`. The API listens on loopback only, and `tailscale serve` puts HTTPS in front of it. The API is never reachable from the LAN or the internet.

## Why `tailscale serve`

- **Certificates renew themselves.** A `tailscale cert` certificate expires after 90 days and does not renew on its own. `tailscale serve` renews it for you.
- **Only tailnet devices can connect.** The port is exposed on the tailnet only.
- **It identifies the caller.** Each request carries the caller's Tailscale login in the `Tailscale-User-Login` header.

## Setup

1. Enable the API in `config.yaml`:

   ```yaml
   api:
     bind: 127.0.0.1:8787
   ```

   Startup refuses any address that is not loopback (`127.0.0.0/8` or `::1`). That includes `0.0.0.0`, LAN addresses and Tailscale `100.x` addresses. The only way in is through `tailscale serve`.

2. Restart Chotu (`just run`). The log shows:

   ```text
   API server listening on http://127.0.0.1:8787 (expose with `tailscale serve`)
   ```

3. Put HTTPS in front of it, once, on the Mac mini:

   ```sh
   tailscale serve --bg --https=8787 http://127.0.0.1:8787
   ```

   `--bg` keeps the setting across reboots. Check it with `tailscale serve status`. Remove it with `tailscale serve --https=8787 off`.

4. From a phone on the tailnet, open `https://<mini>.<tailnet>.ts.net:8787/v1/health`. The response looks like:

   ```json
   {"status":"ok","server_version":"0.1.0+87dd739","min_app_version":"0.1.0"}
   ```

   `<mini>.<tailnet>.ts.net` is the mini's MagicDNS name. `tailscale status` shows it. The app uses this same URL as its server address.

## Check that only the tailnet can reach it

- From a device on the tailnet, the health check URL above should answer.
- From a LAN device that is not on the tailnet, `curl http://<mini-lan-ip>:8787/v1/health` should fail to connect.

## Endpoints

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| GET | `/v1/health` | none | `status`, `server_version` and `min_app_version`. Holds no household data. |
| GET | `/v1/me` | device token; `X-Chotu-Member` optional | The device, the chosen profile (or `null`), and the profiles it may use. |
| GET | `/v1/workout` | device token + `X-Chotu-Member` | The member's open workout today, or `null`. See [Workout](#workout). |
| POST | `/v1/workout/sets` | device token + `X-Chotu-Member` + `Idempotency-Key` | Logs one set. |
| POST | `/v1/workout/done` | device token + `X-Chotu-Member` + `Idempotency-Key` | Closes today's workout and summarizes it. |
| DELETE | `/v1/workout/sets/{id}` | device token + `X-Chotu-Member` + `Idempotency-Key` | Removes one of the member's sets (open workout, or the last 7 days). |
| GET | `/v1/tasks` | device token + `X-Chotu-Member` | All open and snoozed tasks assigned to the member, plus unassigned tasks. |
| POST | `/v1/tasks/{id}/complete` | device token + `X-Chotu-Member` + `Idempotency-Key` | Completes one task by its full id. |
| POST | `/v1/tasks/{id}/snooze` | device token + `X-Chotu-Member` + `Idempotency-Key` | Snoozes one task by its full id. |
| GET | `/v1/status` | device token + `X-Chotu-Member` | Today's activity, exercises, nutrition and goals. See [Status](#status). |
| GET | `/v1/plan` | device token + `X-Chotu-Member` | This week's training plan, today's targets and progress. See [Plan](#plan). |

`/v1/me` for a shared iPad that picked Jordan:

```json
{
  "device": "kitchen_ipad",
  "member": {"id": "jordan", "name": "Jordan"},
  "profiles": [{"id": "alex", "name": "Alex"}, {"id": "jordan", "name": "Jordan"}]
}
```

Without `X-Chotu-Member`, `member` is `null`. The app calls it that way to fill its profile picker.

## Versions

`/v1/health` reports two versions:

- `server_version` is the coordinator crate version plus the git commit it was built from, such as `0.1.0+87dd739`. The commit is `unknown` when the build had no git checkout.
- `min_app_version` is the oldest app the server supports. It is the `MIN_APP_VERSION` constant in `coordinator/src/api.rs`.

The app sends its own version on every request:

```text
X-Chotu-App-Version: 1.4.2
```

The version is `major.minor.patch`, compared numerically. A pre-release or build suffix (`1.4.2-beta`, `1.4.2+7`) is ignored.

| `X-Chotu-App-Version` | Result |
| --- | --- |
| Below `min_app_version` | `426`, with `{"error":"app update required","min_app_version":"0.1.0"}` |
| At or above `min_app_version` | The normal response |
| Not `major.minor.patch` | `400` |
| Missing | The normal response. The app always sends it; curl and scripts need not. |

The version is checked before the device token, so an outdated app is told to update even if its token is wrong. `/v1/health` skips the check. An outdated app can always read the minimum it needs.

### API compatibility rule

Sideloaded app builds lag the server, so the server must keep serving older apps:

- **Within `/v1`, changes are additive only.** New endpoints and new optional fields are fine. Removing or renaming a field, changing its type or meaning, or making a request field required is a breaking change.
- **A breaking change goes under `/v2`,** or it bumps `MIN_APP_VERSION` to the first app release that handles it. Apps below the new minimum then get `426` and an update prompt instead of a broken screen.
- Bump `MIN_APP_VERSION` only when the server drops something an older app needs.

## Devices and profiles

Each app install is a **device** with its own bearer token. A device lists the household members (profiles) it may act as. The app's profile picker chooses one of them, and the app sends it on every request.

1. Mint a token on the Mac mini:

   ```sh
   just api-token alex_phone
   ```

   It prints the token once, followed by a line like `API_TOKEN_ALEX_PHONE='$argon2id$v=19$...'`. The token looks like `alex_phone.<64 hex chars>`: the device name, then 256 random bits. Device names use ASCII letters, digits and `_`.

2. Add that line to `.env`, single quotes included (the hash contains `$`). Only the Argon2id hash is stored, using OWASP's recommended parameters (19 MiB, 2 passes). The raw token lives only on the device.

3. List the device in `config.yaml`:

   ```yaml
   api:
     bind: 127.0.0.1:8787
     devices:
       - name: alex_phone
         members: [alex]
       - name: kitchen_ipad
         members: [alex, jordan]
   ```

   Every member must be a `family.members[].id`. Startup fails on an unknown member, an empty list, a duplicate name, or a hash that is not an Argon2id PHC string.

4. Restart Chotu, then enter the token in the app.

Requests send:

```text
Authorization: Bearer <token>
X-Chotu-Member: alex
X-Chotu-App-Version: 1.4.2
```

| Request | Status |
| --- | --- |
| `X-Chotu-App-Version` below `min_app_version` | `426` |
| No token, or a token that matches no device | `401` |
| `X-Chotu-Member` names a member the device may not use | `403` |
| A member-data route without `X-Chotu-Member` | `400` |

Every authenticated request acts for exactly one member, the same way a linked Signal DM does. The app never acts for the household group.

**Revoke a device:** remove its `API_TOKEN_<DEVICE>` line from `.env` and restart. A configured device with no token line logs a warning at startup and cannot sign in. To rotate, mint a new token and replace the line.

## Writes are idempotent

Every `POST` and `DELETE` sends a client-generated `request_id` in the `Idempotency-Key` header. A retry with the same id gets the original response back, and the write is not applied a second time. The app generates a fresh UUIDv4 per write and keeps it when it retries or replays a queued write.

```text
Authorization: Bearer <token>
X-Chotu-Member: alex
Idempotency-Key: 3f2b9c4e-8a1d-4c55-9a8e-2b7f0c1d9e6a
```

- The id is a header rather than a body field, so writes without a body (`DELETE`, `POST /v1/workout/done`) carry it the same way.
- Ids are scoped to the member, not the device. The same id from Alex's phone and the kitchen iPad acting as Alex is one write. Jordan's writes never collide with Alex's.
- A repeat returns the stored status, `Content-Type` and body. Generic responses are kept for 7 days; after that, the same id applies again. Successful `POST /v1/workout/sets` (`201`) and `DELETE /v1/workout/sets/{id}` (`200`) responses are retained beyond this window. Their request-to-set identity and deletion confirmation are needed to recover lost replies, including manually recovered Undo, after a long offline period. Refused set writes and unrelated endpoint responses still expire normally.
- A `5xx` response is not stored, so the client can retry it with the same id.

| Request | Status |
| --- | --- |
| A write without `Idempotency-Key`, or with one that is not 1–128 visible ASCII characters | `400` |
| The same id while its first attempt is still running | `409`; retry shortly |
| The same id on a different method or path | `422` |

Server side, every write handler extracts `Idempotency` and wraps its write in `Idempotency::run` (`coordinator/src/api/idempotency.rs`). Responses are stored in `api_write_requests`, keyed by `(member_id, request_id)`. Two concurrent attempts race on that primary key, and only the winner applies. Ids still in flight when the coordinator stopped are released at the next startup.

## Tasks

Task endpoints use the same typed core as Signal's `/tasks`, with the same member scope: your assigned tasks and unassigned tasks. Tasks assigned to another member look absent (`404`) for both completion and snooze. API paths require the **full id**; Signal's short-prefix lookup and formatted replies are unchanged.

### `GET /v1/tasks`

Returns `{"tasks": [...]}` containing every open or snoozed task in scope, ordered by due date (undated tasks last), then newest creation first. Unlike Signal's 25-row display, the API does not truncate the list. Done and ignored tasks are omitted.

Each task has this shape:

```json
{
  "id": "6c1d4f0e-2b9a-4f7e-9d1c-0a5e3b7c2f18",
  "title": "Call dentist",
  "status": "open",
  "due_date": "2026-10-27",
  "due_at": "2026-10-27T13:00:00+00:00",
  "due_has_time": false,
  "assigned_to": "alex",
  "email_subject": null
}
```

`due_date`, `due_at`, `assigned_to`, and `email_subject` may be `null`. `due_has_time` distinguishes an explicitly timed task from a date-only reminder. Status is `open`, `snoozed`, or `done` (the latter occurs in completion responses).

### `POST /v1/tasks/{id}/complete`

No body. Returns `{"task": {...}}` with status `done`. Completing an already-done task is safe. Completion removes the task from active listings and stops its due-reminder eligibility immediately.

The linked Google Calendar event is deleted using the assigned member's existing calendar credentials. A missing event (`404`) counts as deleted. As in Signal, calendar synchronization and memory reindexing are best effort after the database write: a calendar failure is logged, does not roll back completion, and keeps the stored event id. Complete again with a **new** `Idempotency-Key` to retry deleting a retained link, even for an already-done task. A replay with the same key returns its stored response without retrying any side effect.

### `POST /v1/tasks/{id}/snooze`

Body: `{"days": 2}`. `days` must be an integer from 1 through 90; missing, fractional, or out-of-range values return `422` with `{"error":"..."}`.

Returns `{"task": {...}}` with status `snoozed`. The new date is **today in the household timezone plus `days`**, not the old due date plus `days`. Like Signal, snooze resets the explicit time (`due_has_time: false`), sets the date-only reminder instant, clears `reminded_at`, and starts a new per-recipient reminder-delivery cycle atomically.

Snoozed tasks become eligible for Signal reminders at the new deadline, not before. A successful delivery is recorded once per recipient in that cycle; completed tasks remain ineligible.

An existing calendar event is rescheduled in place with its original duration, never replaced by a new event. A stale event (`404`) clears the stored link. If calendar rescheduling fails, snooze still succeeds, keeps the event id for a later attempt, and includes an optional warning:

```json
{"task": {"id": "...", "status": "snoozed"}, "calendar_warning": "calendar update failed"}
```

The example abbreviates the task; responses always contain all task fields. A warning is not a failed task mutation and must not trigger an optimistic rollback. The same `Idempotency-Key` replays the original result, including any warning, without rescheduling or resetting the reminder cycle again. A new snooze request uses today's date again.

## Workout

The workout endpoints share one workout per member with Signal's `/log`. A workout started in Signal shows up in `GET /v1/workout`, and a set logged in the app shows up in Signal's `/log` status. Both go through the same `health_coach` functions, so "today" is the household timezone's day for both.

Weights in responses are always pounds (`weight_lb`). `null` means bodyweight. Errors are JSON: `{"error": "..."}`. The message is for people and may change. Refusals the app must act on also have a stable `code`: `too_old` for ambiguous upload replay and `set_absent` for a DELETE target not present in the caller's owned sets (below).

### `GET /v1/workout`

Returns the open workout for today, or `{"workout": null}` when none is open (plus today's `plan`, see below). A workout idle for 3 hours, or left open from an earlier day, is closed on read.

Every response also has `date`, the household-timezone day it answers for (`"2026-10-24"`). The app uses it to tell whether a cached plan is for today. Older apps ignore it.

```json
{
  "workout": {
    "session_id": "6c1d4f0e-2b9a-4f7e-9d1c-0a5e3b7c2f18",
    "current_exercise": "Bench press",
    "plan_day": {"weekday": "Tuesday", "kind": "strength", "notes": "Push"},
    "exercises": [
      {
        "name": "Bench press",
        "sets": 3,
        "reps": "8-10",
        "target": {"weight_lb": 135.0, "reps": [9, 9, 8], "note": null}
      }
    ],
    "sets": [
      {"id": "b0a7e5c2-1f3d-4e8a-9b6c-7d2e4f1a3c59", "exercise": "Bench press", "weight_lb": 135.0, "reps": 8}
    ]
  }
}
```

- `current_exercise` can be `null`, for example before any lift is chosen.
- `plan_day` is `null` without a weekly plan covering today. `exercises` is empty on rest days and without a plan.
- `target` is the next prescription for a planned lift, or `null`.
- `sets` are oldest first, including lifts outside the plan.

#### Today's plan before a workout is open

When no workout is open and today's plan has lifts, the response also has a top-level `plan` with the same `plan_day` and `exercises` (with targets) that the workout will carry once it opens:

```json
{
  "workout": null,
  "plan": {
    "plan_day": {"weekday": "Tuesday", "kind": "strength", "notes": "Push"},
    "exercises": [
      {
        "name": "Bench press",
        "sets": 3,
        "reps": "8-10",
        "target": {"weight_lb": 135.0, "reps": [9, 9, 8], "note": null}
      }
    ]
  }
}
```

- Reading the plan never opens a workout. The first `POST /v1/workout/sets` does.
- `plan` is omitted while a workout is open, since `workout` carries the plan then.
- `plan` is also omitted once the member has logged a set today (household-timezone date), in an open or a closed workout: after Done, or after the 3-hour idle close, the response is `{"workout": null}`, so the app doesn't offer to start a second workout. A set logged after that still starts a new one.
- `plan` is also omitted on rest days and without a weekly plan, so those responses are `{"date": ..., "workout": null}`. Apps that only read `workout` see no change. A workout opened with no sets and then idle-closed doesn't count, so the plan stays.

### `POST /v1/workout/sets`

Logs one set and starts today's workout if none is open.

```json
{"exercise": "bench press", "weight": 60, "unit": "kg", "reps": 8, "performed_at": "2026-10-24T18:05:00-04:00"}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `exercise` | yes | A planned lift (matched loosely, so `bench` finds `Bench press`) or any other lift. |
| `weight` | yes, may be `null` | The load in `unit`. `null` is bodyweight. |
| `unit` | yes | `lb` or `kg`. A `kg` weight is converted to pounds before it is stored. |
| `reps` | yes | 1–100. |
| `performed_at` | no | When the set was done, RFC 3339 **with an offset**. Defaults to server time. |

`performed_at` lets a set queued offline land when it was done:

- Within 5 minutes of server time, the set counts as live and joins the open workout, as a Signal set would.
- Earlier, it joins that day's latest workout in the household timezone, even one already closed. If that day has none, a closed one is created.
- More than 5 minutes in the future or more than 7 days old is refused with `422`.

The response is `201` with the stored set and the workout it joined. For an earlier set, that can be a closed workout from that day.

```json
{
  "set": {"id": "b0a7e5c2-1f3d-4e8a-9b6c-7d2e4f1a3c59", "exercise": "Bench press", "weight_lb": 132.277357308, "reps": 8},
  "workout": {"session_id": "6c1d4f0e-2b9a-4f7e-9d1c-0a5e3b7c2f18", "current_exercise": "Bench press", "plan_day": null, "exercises": [], "sets": ["..."]}
}
```

`weight_lb` is the exact conversion, unrounded. Signal shows it to one decimal (`132.3 lb`).

### `POST /v1/workout/done`

Closes today's workout. No body. Returns `200` with what was done per exercise and the next target for planned lifts:

```json
{
  "exercises": [
    {
      "name": "Bench press",
      "sets": [{"weight_lb": 135.0, "reps": 9}, {"weight_lb": 135.0, "reps": 8}],
      "next": {"weight_lb": 135.0, "reps": [10, 9, 9], "note": null}
    }
  ]
}
```

### `DELETE /v1/workout/sets/{id}`

Removes one of the member's sets, for example a mistyped one. No body. Returns `200` with the removed set and the updated workout, in the same shape as `POST /v1/workout/sets`.

- A set in the open workout: that set's lift becomes the current exercise.
- A set in a closed workout or an earlier day's: the workout is returned as it stands and stays closed. Deletion has **no performed-date expiry**: an offline set uploaded at the seven-day limit can still be compensated tomorrow or after a longer outage. The member-scoped lookup and DELETE enforce ownership; knowing another member's set ID grants no access.

### Workout errors

| Request | Status |
| --- | --- |
| Malformed JSON | `400` |
| A body without `Content-Type: application/json` | `415` |
| A missing field, a wrong type, or an unknown `unit` | `422` |
| `reps` or the weight out of range, or a blank `exercise` | `422` |
| `performed_at` without an offset, more than 5 minutes ahead, or more than 7 days old | `422` (more than 7 days old also has `"code": "too_old"`) |
| `POST /v1/workout/done` with no open workout | `409` |
| `DELETE` of another member's set or an unknown id | `404` with `"code": "set_absent"`; the same answer avoids leaking ownership |

`too_old` is also what a resend gets if an older server already pruned its `Idempotency-Key`, even when the first send was saved. Successful uploads are now retained, but previously deleted identities cannot be reconstructed automatically. The app preserves ambiguous compensation and the original request ID; an administrator can locate the verified owned set in history and use its server set ID for authorized deletion. A legacy historical `404` without `set_absent` is not treated as confirmed absence. For manually recovered IDs even `set_absent` remains unresolved (it could be a mistyped ID); only a successful DELETE completes that recovery.

## Status and plan

`GET /v1/status` and `GET /v1/plan` are read-only. They read the same typed functions as Signal's `/status` and `/plan` (`coordinator/src/status.rs` and `health_coach::plan_week`), for the caller's member only, the same way a linked DM sees only its own health. "Today" is the household timezone's day, and every response carries it as `date`.

### Status

`GET /v1/status` returns the member's health day so far:

```json
{
  "date": "2026-10-26",
  "member": {"id": "alex", "name": "Alex"},
  "activity": {"steps": 8432, "active_calories": 415, "sleep_hours": 7.2, "energy": 7},
  "exercises": ["Running (32 min, 310 kcal)", "Walking (20 min)"],
  "fitness": {"intent": "Run a 10k", "target_date": "2026-12-01", "days_to_target": 36, "focus": "endurance"},
  "nutrition": [
    {"key": "calories", "label": "Calories", "amount": 1840.0, "unit": "kcal", "sub": false},
    {"key": "protein", "label": "Protein", "amount": 121.2, "unit": "g", "sub": false},
    {"key": "saturated_fat", "label": "Saturated", "amount": 18.5, "unit": "g", "sub": true}
  ],
  "goals": [
    {"key": "calories", "label": "Calories", "actual": 1840.0, "goal": 2200.0, "percent": 84.0, "unit": "kcal"},
    {"key": "steps", "label": "Steps", "actual": 8432.0, "goal": 10000.0, "percent": 84.0, "unit": ""}
  ]
}
```

- **Numbers come rounded the way Signal prints them:** whole kcal for calories, one decimal for other nutrients and sleep, and whole numbers for goals. Signal rounds a tie to even (`121.25` shows as `121.2`), and JavaScript's `toFixed` would not, so the server rounds. The app prints `amount` with `toFixed(1)` and goal numbers as integers, and shows the same digits as Signal.
- `activity` is always present. `steps` and `active_calories` are `0` until a health sync; `sleep_hours` and `energy` are `null` until reported.
- `exercises` lists every synced exercise. Signal shows the first six.
- `fitness` is `null` without `fitness_goals`. Its fields are `null` when not configured; `target_date` is set only with `days_to_target`, which is negative once the date has passed.
- `nutrition` is empty until calories or a macro is logged. Calories, protein, carbs and fat always appear then; every other nutrient appears only above zero, in Signal's table order. `sub: true` marks a breakdown of fat (saturated, unsaturated, trans fat, cholesterol, triglycerides, omega-3 DHA), indented under it.
- `goals` lists only configured `nutrition_goals`, in the order calories, protein, carbs, fat, fiber, steps.
- Signal's coach tip is not included: it needs the local model. The household finance part of `/status` is not member data and stays in Signal.

### Plan

`GET /v1/plan` returns this week's plan, today's session with a target per exercise, and the week's progress:

```json
{
  "date": "2026-10-28",
  "week_start": "2026-10-26",
  "plan": {
    "theme": "Build the base",
    "days": [
      {
        "date": "2026-10-26",
        "weekday": "Monday",
        "kind": "strength",
        "notes": "lower body",
        "is_today": false,
        "exercises": [{"name": "Leg press", "sets": 3, "reps": "10-12"}]
      }
    ],
    "today": {
      "weekday": "Wednesday",
      "kind": "strength",
      "notes": "full body, RPE 7",
      "exercises": [
        {
          "name": "Leg press",
          "sets": 3,
          "reps": "10-12",
          "target": {"weight_lb": 190.0, "reps": [10, 10, 10], "note": "+10 lb"}
        }
      ]
    },
    "progress": {"sessions_matched": 2, "sessions_planned": 3, "cardio_minutes": 30, "planned_cardio_minutes": 30}
  }
}
```

- `days` always has Monday through Sunday; the example shows one. `kind` is `rest`, `strength`, `cardio` or `mixed`. Rest days have no exercises.
- `today` uses the same exercise and `target` shape as [`GET /v1/workout`](#get-v1workout), so the targets match the workout screen's. It is present on rest days too, with no exercises.
- `progress` matches Signal's `📊 This week so far` line: planned sessions so far that a logged activity matched, cardio minutes logged this week, and cardio minutes on planned cardio or mixed days. It is `null` if the week's logs cannot be read.
- Reading never generates a plan. Without one, `plan` is `null` and `reason` says why:

| `reason` | Meaning |
| --- | --- |
| `no_fitness_goals` | The member has no `fitness_goals` in `config.yaml`. |
| `not_generated` | No plan for this week yet. Send `/plan` in Signal to build one with the local model. |
| `unreadable` | This week's stored plan can't be read (its data no longer parses). Signal's `/plan` still shows it as text. |

`reason` is omitted when `plan` is present.

## Request logs

Every request logs one line:

```text
api_request method=GET route=/v1/me status=200 duration_ms=0 device=kitchen_ipad member_id=jordan tailscale_user="alex@example.com"
```

- `route` is the route pattern, not the raw path. Requests that match no route log `<unmatched>`.
- `device` is `-` when the token is missing or matches no device. A `403` still logs the device that asked.
- `member_id` is `-` when the request names no profile or its profile was rejected.
- `tailscale_user` is the `Tailscale-User-Login` header, or `-` if it is missing. It is logged only and does not affect authorization.
- Tokens and request bodies are never logged.

## Shutdown

On Ctrl-C, or when another coordinator task exits, the API stops accepting connections. It then waits up to 5 seconds for in-flight requests to finish.
