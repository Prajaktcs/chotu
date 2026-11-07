# App and Signal parity

The capability matrix for the expanded app ([#169](https://github.com/Prajaktcs/chotu/issues/169)). It lists every Signal workflow, what the app and `/v1` API already support, where it lives in the app, and which phase delivers the rest. Phase 5 ([#176](https://github.com/Prajaktcs/chotu/issues/176)) verifies against this list.

Audited on 2026-11-01 against `coordinator/src/signal.rs` (`parse_command`), `coordinator/src/api.rs` (routes) and `docs/commands/*.md`. Where the docs and code disagreed, the code won.

## Status key

- **Shipped**: the app does it today through `/v1`.
- **Partial**: some of it ships; the gap is named.
- **Phase N**: planned in that phase's issue.
- **Signal only**: stays in Signal for this release, with the reason.
- **Deferred**: belongs to a future app section (Finance, Memory).

## Health and fitness (`docs/commands/health.md`)

| Signal | App today | App destination | Status | Missing work |
| --- | --- | --- | --- | --- |
| `/log` workout, sets, done, undo set | `GET /v1/workout`, `POST /v1/workout/sets`, `POST /v1/workout/done`, `DELETE /v1/workout/sets/{id}`; offline queue | Fitness › Workout | Shipped | — |
| `/plan` | `GET /v1/plan` | Fitness › Plan | Shipped | — |
| `/plan new` (generate, regenerate) | `POST /v1/plan`, `POST /v1/plan/regenerate` | Fitness › Plan | Shipped | — |
| Workout history (past workouts and sets) | `GET /v1/workout/history` | Fitness › History | Shipped ([#172](https://github.com/Prajaktcs/chotu/issues/172)) | — |
| Training trends (volume, working sets per exercise) | `GET /v1/workout/trends` | Fitness › Trends | Shipped ([#172](https://github.com/Prajaktcs/chotu/issues/172)) | Signal's `/trends` has no training section; both read the same set log |
| `/food <description>` | `POST /v1/food` | Nutrition › Today | Shipped | — |
| Food photos, new meal (plate, package, barcode) | `POST /v1/food` with a photo ([#163](https://github.com/Prajaktcs/chotu/pull/163)) | Nutrition › Today | Shipped | — |
| Photo that updates a logged meal; new-or-update choice | `POST /v1/food/{id}/correct` with a photo | Nutrition › Today, Food log (Edit meal › Correct it) | Shipped ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | The app picks the meal first, so Signal's "update or new?" question isn't needed; a new meal from a photo is **Add a meal** |
| `/correctfood`, reply corrections | `POST /v1/food/{id}/correct`; `PATCH /v1/food/{id}` rewrites the whole description | Nutrition › Today, Food log (Edit meal › Correct it) | Shipped ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | Same `health_coach::meal_updates` prompt, facts and tag reconciliation as Signal; an ambiguous correction asks and writes nothing |
| `/undofood` | `DELETE /v1/food/{id}` (a chosen meal, not "the latest") | Nutrition › Today | Shipped | — |
| `/clearfood` | `POST /v1/food/clear` (today) | Nutrition › Today › Day tools | Shipped ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | Same `health_coach::clear_food_day` as Signal |
| `/adjustfood` | `POST /v1/food/adjust` (today) | Nutrition › Today › Day tools | Shipped ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | Same `health_coach::replace_food_day_totals` as Signal |
| Past days' meals | `GET /v1/food?date=` | Nutrition › Food log | Shipped ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | — |
| Nutrition goals | `GET /v1/status` goals, `GET /v1/food/trends` goals | Nutrition › Goals | Shipped, read-only | Editing stays in `config.yaml`; no app editor |
| `/trends` nutrition part | `GET /v1/food/trends` | Nutrition › Trends | Shipped ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | The trend-average coach tip stays in Signal; Today has the day's tip |
| `/status` health part | `GET /v1/status`, `GET /v1/status/tip` | Today | Shipped ([#180](https://github.com/Prajaktcs/chotu/issues/180)) | Tip loads apart, once per household day and on **New tip**; same `status::coach_context` as Signal |
| `/sync` | none | Settings | Signal only | Pulls every linked member's Google Health account; not a per-profile action. Revisit after Phase 5. |
| `/tags` | `GET /v1/health/conditions` (`tags`) | Wellbeing › Conditions | Shipped ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | — |
| `/watch`, `/watch add`, `/watch remove` | `GET /v1/health/conditions`, `PUT`/`DELETE /v1/health/conditions/{id}/watchlist/{tag}` | Wellbeing › Conditions | Shipped ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Same `health_coach::conditions` as Signal; the chosen profile only |
| Condition check-ins (evening `/reflect` reply) | `GET /v1/health/checkins`, `PUT`/`DELETE /v1/health/checkins/{date}/{condition_id}` | Wellbeing › Overview, Check-ins | Shipped ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Same upsert as the evening check-in; today or 7 days back; a cleared day is skipped, never 0 |
| `/trends` condition timelines | `GET /v1/health/trends` | Wellbeing › Trends | Shipped ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Same `condition_trends` timeline, lag windows, sleep matching and thresholds; descriptive wording |
| Food-tag watchlist flags after logging | `watchlist_flags` on `POST /v1/food` and `POST /v1/food/{id}/correct` | Nutrition › Today, Food log | Shipped ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Same `pending_food_flags`, once per tag and day; the chosen profile only, never in household views |

## Day loop (`docs/commands/day-loop.md`)

| Signal | App today | App destination | Status | Missing work |
| --- | --- | --- | --- | --- |
| `/tasks`, `/tasks open`, `/tasks snoozed` | `GET /v1/tasks` | Tasks › Today (overdue, due today, undated), Tasks › Upcoming (later, snoozed) | Shipped ([#174](https://github.com/Prajaktcs/chotu/issues/174)) | — |
| `/tasks completed` | `GET /v1/tasks/completed` | Tasks › Completed | Shipped ([#174](https://github.com/Prajaktcs/chotu/issues/174)) | — |
| `/tasks complete <id>` | `POST /v1/tasks/{id}/complete` | Tasks › Today | Shipped | — |
| `/tasks complete all` | none | — | Signal only | Bulk completion needs Signal's household confirmation step; excluded from this release |
| `/tasks snooze <id> [days]` | `POST /v1/tasks/{id}/snooze` (1–90 days) | Tasks › Today, Upcoming | Shipped | — |
| `/task …`, `/tasks add …` | `POST /v1/tasks` | Tasks › Today (Add task) | Shipped ([#174](https://github.com/Prajaktcs/chotu/issues/174)) | Same service as Signal (`crate::tasks::create_manual_task`) |
| `/tasks open <id>` (unsnooze) | `POST /v1/tasks/{id}/reopen` | Tasks › Upcoming, Completed | Shipped ([#174](https://github.com/Prajaktcs/chotu/issues/174)) | — |
| `/tasks reassign <id> <member>` | `POST /v1/tasks/{id}/assign` (to yourself) | Task actions › Assign to me | Partial | A linked DM can only assign to itself; assigning to another member stays in the household chat |
| Timed task reminders | Signal DM, unchanged | — | Signal only | The app never sends Signal messages; reminders keep their current behavior |
| `unactionable` reply to a task reminder (ignore the task, train email filtering) | none | — | Signal only | It answers a Signal reminder, which the app never sends; the app's equivalent is Complete |
| Tasks › Trends | `GET /v1/tasks/trends` | Tasks › Trends | Shipped ([#174](https://github.com/Prajaktcs/chotu/issues/174)) | — |
| `/brief` | `GET /v1/calendar`, `GET /v1/workout`, `GET /v1/tasks`, `GET /v1/status` | Today | Shipped ([#171](https://github.com/Prajaktcs/chotu/issues/171), [#180](https://github.com/Prajaktcs/chotu/issues/180)) | Today shows the profile's calendar, training, due tasks and nutrition. Bills: deferred with Finance. |
| `/cal` (today) | `GET /v1/calendar` | Today › Calendar | Shipped ([#180](https://github.com/Prajaktcs/chotu/issues/180)) | The chosen profile's calendar only, like a linked DM; Signal's household `/cal` merges every member. `/cal tomorrow`, `/cal week` and conflicts stay in Signal. |
| `/reflect` journaling | none | — | Signal only | Journal text goes to the local brain directory. Only the condition score moves to the app (Phase 4). |

## Setup (`docs/commands/setup.md`)

| Signal | App | Status |
| --- | --- | --- |
| `/chat`, `/whoami` | Settings shows the device and profile | Signal only: diagnostics for Signal conversations |
| `/login health`, `/login calendar`, `/login gmail` | none | Signal only: OAuth writes refresh tokens to the server's `.env` |
| `/help` | none | Signal only |
| Free text intents (`morning brief`, `remind me to …`) | none | Signal only: the app uses explicit actions |

## Deferred app sections

| Section | Signal | Status |
| --- | --- | --- |
| Finance | `/status` spending part, `/monthly`, `/budget`, `/networth`, `/research` | Deferred. The section is reserved in navigation and shown as **Coming later**. Planned separately. |
| Memory | `/memory <question>`, `/memory reindex` | Deferred. Reserved and shown as **Coming later**. Planned separately. |

## Contracts for new workflows

Every new endpoint follows the existing `/v1` rules ([App API](app-api.md)). Shipped workflows' contracts (method, path, body, validation, responses and error codes) are in App API: [workout history and trends](app-api.md#workout-history-and-trends), [tasks](app-api.md#tasks), [food](app-api.md#food), [wellbeing](app-api.md#wellbeing).

- **Additive only.** New paths or new optional fields. Existing responses keep their shape; the minimum app version only rises for a breaking server change.
- **Authorization.** Device token plus `X-Chotu-Member`. The server checks the device may act as that member and reads or writes only that member's rows, with one shipped exception: tasks also include **unassigned household tasks**, as in a linked Signal DM (list, complete, snooze, reopen, take). Health data (check-ins, conditions, watchlists) has no such exception: the chosen profile only, never a household view.
- **Dates.** Every day is a household-timezone calendar date, `YYYY-MM-DD`, as in `GET /v1/food`. Ranges are inclusive `from`/`to` dates, at most 90 days, matching `/trends`. Timed values are RFC 3339 instants.
- **Idempotency.** Every write sends `Idempotency-Key` and goes through `Idempotency::run`. Check-ins upsert by member, condition and day, so a retry or a second check-in that day replaces the score.
- **Shared services.** The handler calls the same service Signal uses (task creation, food clear/adjust, watchlists, trends). No second business-logic path.
- **No Signal echo.** An app write never sends a Signal confirmation. Scheduled reminders keep their current behavior.
- **Retry.** No new offline write queue. New writes follow the task pattern: optimistic where safe, **Retry unchanged** with the original request id after an ambiguous failure, rollback of only that write on rejection. The workout set queue is unchanged.
- **States.** Every new screen has a labelled loading indicator, an empty state that says what to do next, a load failure with **Retry loading** that keeps the last loaded data, and `401`/`403`/`426` recovery routing.

## Pending contracts

None: every contract from Phase 0 has shipped and is documented in App API.

## Navigation map

Today is the landing page. Settings is a utility destination. Each main section has four tabs. A tab that has no working screen yet is shown as unavailable, never as an empty screen.

Wellbeing is the condition/symptom section formerly labelled Health ([#186](https://github.com/Prajaktcs/chotu/issues/186)). Only the app-facing name changes: the internal `health` section ID and `/v1/health/...` API paths stay unchanged, as do Google Health, Health Connect and Health Coach terminology. Its four tabs shipped in Phase 4 ([#175](https://github.com/Prajaktcs/chotu/issues/175)).

| Section | Tabs (route, or the phase that adds it) |
| --- | --- |
| Today | `/today` |
| Fitness | Workout `/workout` · Plan `/plan` · History `/fitness/history` · Trends `/fitness/trends` |
| Nutrition | Today `/food` · Food log `/food/log` · Goals `/food/goals` · Trends `/food/trends` |
| Wellbeing | Overview `/wellbeing` · Check-ins `/wellbeing/check-ins` · Conditions `/wellbeing/conditions` · Trends `/wellbeing/trends` |
| Tasks | Today `/tasks` · Upcoming `/tasks/upcoming` · Completed `/tasks/completed` · Trends `/tasks/trends` |
| Finance | Overview · Transactions · Budgets · Trends (future) |
| Memory | Overview · Memories · Topics · Activity (future) |
| Settings | `/settings` |
