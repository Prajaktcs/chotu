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
| Food photos | `POST /v1/food` with a photo ([#163](https://github.com/Prajaktcs/chotu/pull/163)) | Nutrition › Today | Shipped | — |
| `/correctfood`, reply corrections | `PATCH /v1/food/{id}` replaces the description and re-estimates | Nutrition › Today | Partial | Signal's correction keeps unaffected ingredients and exclusions; the app re-estimates the whole description. Phase 3 decides whether the app calls the correction service. |
| `/undofood` | `DELETE /v1/food/{id}` (a chosen meal, not "the latest") | Nutrition › Today | Shipped | — |
| `/clearfood` | none | Nutrition › Food log | Phase 3 ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | Clear-day endpoint over the existing clear service, with its deletion ledger |
| `/adjustfood` | none | Nutrition › Food log | Phase 3 ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | Adjust endpoint over the existing adjustment audit |
| Past days' meals | `GET /v1/food?date=` | Nutrition › Food log | Partial | The endpoint exists; the Food log tab (date browsing) ships in Phase 3 |
| Nutrition goals | Goals are in `GET /v1/status` (read-only, from `config.yaml`) | Nutrition › Goals | Phase 3 ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | Show goals; editing stays in `config.yaml` unless Phase 3 adds a server-side store |
| `/trends` nutrition part | none | Nutrition › Trends | Phase 3 ([#173](https://github.com/Prajaktcs/chotu/issues/173)) | Shared trends endpoint |
| `/status` health part | `GET /v1/status` | Today | Shipped (coach tip excluded) | Coach tip: [#180](https://github.com/Prajaktcs/chotu/issues/180) |
| `/sync` | none | Settings | Signal only | Pulls every linked member's Google Health account; not a per-profile action. Revisit after Phase 5. |
| `/tags` | none | Health › Conditions | Phase 4 ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Tag vocabulary endpoint |
| `/watch`, `/watch add`, `/watch remove` | none | Health › Conditions | Phase 4 ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Watchlist read/write endpoints; linked-DM privacy rules apply to the chosen profile |
| Condition check-ins (evening `/reflect` reply) | none | Health › Check-ins | Phase 4 ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Check-in endpoint writing `condition_checkin`, upsert per member/condition/day |
| `/trends` condition timelines | none | Health › Trends | Phase 4 ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Descriptive only, same thresholds as Signal |
| Food-tag watchlist flags after logging | none | Nutrition › Today | Phase 4 ([#175](https://github.com/Prajaktcs/chotu/issues/175)) | Show flags for the chosen profile only; never in household views |

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
| Tasks › Trends | `GET /v1/tasks/trends` | Tasks › Trends | Shipped ([#174](https://github.com/Prajaktcs/chotu/issues/174)) | — |
| `/brief` | `GET /v1/workout`, `GET /v1/tasks`, `GET /v1/status` | Today | Partial ([#171](https://github.com/Prajaktcs/chotu/issues/171)) | Today shows the profile's training, due tasks and nutrition. Calendar: [#180](https://github.com/Prajaktcs/chotu/issues/180). Bills: deferred with Finance. |
| `/cal` | none | Today | Later ([#180](https://github.com/Prajaktcs/chotu/issues/180)) | Signal's agenda is family-merged; Today needs a per-profile contract |
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

Every new endpoint follows the existing `/v1` rules ([App API](app-api.md)). Each phase writes the exact request and response shapes, fixtures and Rust/TypeScript types when it implements them.

- **Additive only.** New paths or new optional fields. Existing responses keep their shape; the minimum app version only rises for a breaking server change.
- **Authorization.** Device token plus `X-Chotu-Member`. The server checks the device may act as that member and reads or writes only that member's rows. Health data (check-ins, conditions, watchlists) follows Signal's linked-DM privacy: the chosen profile only, never a household view.
- **Dates.** Every day is a household-timezone calendar date, `YYYY-MM-DD`, as in `GET /v1/food`. Ranges are inclusive `from`/`to` dates, at most 90 days, matching `/trends`. Timed values are RFC 3339 instants.
- **Idempotency.** Every write sends `Idempotency-Key` and goes through `Idempotency::run`. Check-ins upsert by member, condition and day, so a retry or a second check-in that day replaces the score.
- **Shared services.** The handler calls the same service Signal uses (task creation, food clear/adjust, watchlists, trends). No second business-logic path.
- **No Signal echo.** An app write never sends a Signal confirmation. Scheduled reminders keep their current behavior.
- **Retry.** No new offline write queue. New writes follow the task pattern: optimistic where safe, **Retry unchanged** with the original request id after an ambiguous failure, rollback of only that write on rejection. The workout set queue is unchanged.
- **States.** Every new screen has a labelled loading indicator, an empty state that says what to do next, a load failure with **Retry loading** that keeps the last loaded data, and `401`/`403`/`426` recovery routing.

## Navigation map

Today is the landing page. Settings is a utility destination. Each main section has four tabs. A tab that has no working screen yet is shown as unavailable, never as an empty screen.

| Section | Tabs (route, or the phase that adds it) |
| --- | --- |
| Today | `/today` |
| Fitness | Workout `/workout` · Plan `/plan` · History `/fitness/history` · Trends `/fitness/trends` |
| Nutrition | Today `/food` · Food log (Phase 3) · Goals (Phase 3) · Trends (Phase 3) |
| Health | Overview · Check-ins · Conditions · Trends (all Phase 4) |
| Tasks | Today `/tasks` · Upcoming `/tasks/upcoming` · Completed `/tasks/completed` · Trends `/tasks/trends` |
| Finance | Overview · Transactions · Budgets · Trends (future) |
| Memory | Overview · Memories · Topics · Activity (future) |
| Settings | `/settings` |
