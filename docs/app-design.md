# App design

The Chotu app's screens, states and design tokens. The source of truth is the Figma file [Chotu · Phase 2 app designs](https://www.figma.com/design/5g9Ahu955WrUnQRYOsztVd/Chotu-%C2%B7-Phase-2-app-designs?node-id=0-1). This page records what the code builds to. The tokens live in `app/src/theme/`.

The look is Material 3 on Android: Roboto, neutral green surfaces, light and dark mode.

## Viewable review artifacts

Open the [repository screen/state atlas](./app-design.html) in a browser (or serve
`docs/` locally). Figma is viewable anonymously, but its overview does not provide
stable individual links for the newer state descriptions below. The supplemental
HTML makes those states directly addressable without a Figma account. It is a
design artifact, not the app: synthetic examples, no API, no token storage and no
claim that the displayed set was saved. Wireframes are deliberately schematic;
only the workout is high fidelity.

| Flow / implementation issue | Viewable frames |
| --- | --- |
| First run · [#118](https://github.com/Prajaktcs/chotu/issues/118) | [Setup](./app-design.html#setup), [profile picker](./app-design.html#profile), [settings](./app-design.html#settings) |
| Full gym session · [#119](https://github.com/Prajaktcs/chotu/issues/119) | [Ready](./app-design.html#ready) → [workout](./app-design.html#workout) → [change exercise](./app-design.html#change) → [undo](./app-design.html#undo) → [Done](./app-design.html#done) |
| Offline logging · #119 | [Offline](./app-design.html#offline), [unsent](./app-design.html#unsent), [failed set](./app-design.html#failed) |
| Task actions · [#122](https://github.com/Prajaktcs/chotu/issues/122) | [Task list/swipes](./app-design.html#tasks), [accessible actions, saving/rollback](./app-design.html#task-actions) |
| Read surfaces · [#124](https://github.com/Prajaktcs/chotu/issues/124) | [Status](./app-design.html#status), [empty](./app-design.html#status-empty), [loading/error](./app-design.html#status-error), [plan](./app-design.html#plan), [no goals](./app-design.html#plan-empty), [no week](./app-design.html#plan-missing), [loading](./app-design.html#plan-loading), [unreadable/error](./app-design.html#plan-error) |
| Media · [#125](https://github.com/Prajaktcs/chotu/issues/125) | [Poster](./app-design.html#demo), [lazy loading](./app-design.html#demo-loading), [playing/paused](./app-design.html#demo-playing), [unavailable](./app-design.html#demo-error) |
| Recovery · #118 | [Tailscale](./app-design.html#tailscale), [401](./app-design.html#token), [403](./app-design.html#permission), [server down](./app-design.html#server), [update required](./app-design.html#update) |

### Review evidence and signoff boundary

On 2026-10-26 an automated Chromium visual review opened Figma and the local atlas,
then reviewed the workout at 390 × 844 in light and dark modes. One click on
**Log set** changed the example row to **Pending** with the unchanged 135 lb × 8
target. Log measured 64 CSS px high, steppers 56, and every high-fidelity link
target at least 48 × 48 CSS px after review corrections. The compact review frame
measured 675 px high at 390 × 844, with Log in the bottom half. The 390 px viewport
had no horizontal overflow. All 36 frame anchors resolved; desktop review at
1280 × 900 also showed no horizontal overflow, and the browser reported no page
errors. This is layout and
design-interaction evidence, not production API, Android dp or device testing.

On 2026-10-26 the product owner selected **“Keep the existing design”**, accepting
the existing green light/dark tokens and reviewed one-tap workout design in
[#153](https://github.com/Prajaktcs/chotu/pull/153). The tokens below match
`app/src/theme/` and remain the agreed implementation baseline.
Arm's-length readability, sweaty-hand one-handed use, Android touch targets and
TalkBack still require a physical-device review. The frame table above is the
link guide for #133 and its five implementation issues; each fragment opens the
corresponding review artifact.

## Gym-friendly rules

- Logging a set at the pre-filled target takes **one tap** (Log set).
- Tap targets are at least 48 dp. Primary buttons are 64 dp tall, secondary 56 dp, text buttons 48 dp.
- Primary actions sit in the bottom half, reachable one-handed.
- Text contrast is at least 4.5:1 in both modes.
- Nothing is conveyed by colour alone. A set's state is always shown as text with a symbol: `✓ Saved`, `◷ Pending`, `! Failed`.
- Every control has an accessibility label. Swipe and long-press actions are also reachable through an accessible menu.

## Design tokens

### Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#F8FAF8` | `#111512` | Screen background |
| `surface` | `#FFFFFF` | `#1A201B` | Cards and list rows |
| `container` | `#EAF0EA` | `#242D26` | Secondary buttons, steppers, selected tab |
| `text` | `#17221A` | `#E2EAE1` | Body and headings |
| `muted` | `#4D5D51` | `#B8C6B9` | Supporting text, labels |
| `outline` | `#B8C5B9` | `#536256` | Dividers, text field borders |
| `primary` | `#28633C` | `#9DD5A8` | Primary buttons, text buttons, links |
| `onPrimary` | `#FFFFFF` | `#003915` | Text on primary |
| `pending` | `#705200` | `#F0C048` | Pending text |
| `pendingContainer` | `#FFF3CE` | `#3A2C00` | Offline banner |
| `error` | `#A52B26` | `#FFB4AB` | Failed text, danger buttons |
| `errorContainer` | `#FCEBE8` | `#5C1612` | Failure banner, danger buttons |

Figma defines `surface` only as white cards in light mode, and has no dark `pending` or `error` values. The dark values above fill those gaps. A unit test checks every text and container pair for 4.5:1.

### Type

Roboto (the Android system font). Sizes: 14, 16, 22, 30, 40.

| Role | Size | Weight | Use |
| --- | --- | --- | --- |
| `display` | 40 | Regular | Stepper values |
| `headline` | 30 | Regular | Screen titles, the current exercise |
| `title` | 22 | Regular | Section titles, the app bar |
| `body` | 16 | Regular | Rows, buttons (Medium on buttons) |
| `label` | 14 | Regular | Supporting text, overlines (uppercase, Medium) |

### Spacing, radii, sizes

- Spacing: 4, 8, 12, 16, 24, 32. Screen side padding is 24.
- Radii: 12 (cards, text fields), 20 (stepper panels, buttons), full (the selected tab pill).
- Button heights: 48 (text), 56 (secondary), 64 (primary).

### Buttons

| Variant | Background | Text |
| --- | --- | --- |
| Primary | `primary` | `onPrimary` |
| Secondary | `container` | `primary` |
| Text | none | `primary` |
| Danger | `errorContainer` | `error` |

## Screens

### Workout (high fidelity)

From top to bottom:

1. App bar: the menu button, "Fitness", and a "Profile" text button on the right that opens Settings. Under it, the Fitness tabs with **Workout** selected (see [Section navigation](#section-navigation)).
2. Overline: the date and the plan day, such as `SAT, OCT 24 · UPPER BODY`.
3. The current exercise as a headline.
4. Secondary button `Exercise 1 of 4 · Change`, which opens Change exercise.
5. Text button `View exercise demo` (phase "later", #125; hidden until then).
6. A status banner when needed:
   - Offline: `Offline · 2 sets pending` / `Saved on this phone. Sends when connected.` (pending colours).
   - Failed: `1 set needs attention` / `Not saved: <reason>` (error colours).
7. "Today's sets": numbered rows `1   135 lb × 8` with a state on the right: `✓ Saved`, `◷ Pending` or `! Failed`. Swipe or long-press a row opens Set actions.
8. Below the list, when needed: secondary button `Review 2 pending sets` (opens Unsent sets) or danger button `Review failed set` (opens Set wasn't saved).
9. Overline `NEXT SET · PRE-FILLED TARGET`.
10. Two stepper panels side by side: Weight (`135 lb`, − / +) and Reps (`8 reps`, − / +). Pre-filled from the exercise's next target.
11. Primary button `Log set`.
12. Text button `Done`.

Interaction notes:

- Log at the target: 1 tap.
- Undo: swipe a set or long-press it, then Undo.
- Pending sets keep their original time. Undo removes an unsent set from the queue.
- The demo loads only on view. Log and Done stay usable while it loads.

### First run and session

- **Connect to Chotu** (setup): "Use the server address and device token provided for this phone." Fields: Server address (`https://mini.ts.net:8787`), Device token. Note: "The token is hidden after saving." Primary `Connect`. Footer: "Connect to Tailscale before continuing." and text button `Connection help`.
- **Choose your profile**: "Only profiles allowed for this device appear here." One secondary button per profile, `Alex · lb`. Footer: "You can switch profiles from settings. Your token stays hidden."
- **Ready to train**: overline with date and plan day, a card per exercise (`Bench press` / `3 sets · next target 135 lb × 8`), primary `Start workout`. Shown when no set has been logged today. After Start workout and before any set is logged, logging shows text `Back to Ready to train` instead of `Done` (no workout is open yet, so there is nothing to finish). A plan loaded on an earlier day is never shown: offline the next morning, the app asks to connect to load the workout. After Done, the server stops sending the plan for the rest of the day, so Ready to train does not come back.
- **Settings**: "Device connection and profile". Cards: Server (the URL), Device token (`Saved · hidden`). Secondary `Switch profile`, text `Replace device token`. Cards: Weight unit (`lb · set by your profile`), Appearance (`Use device setting`).

### Session actions and offline

- **Change exercise**: overline `TODAY'S WORKOUT`, one secondary button per exercise (`Bench press · 2 of 3 sets`), text `Back to workout`. Choosing one returns to logging with its next target pre-filled.
- **Set actions**: a card `Bench press · Set 2` / `135 lb × 8 · Saved at 9:32`, danger `Undo this set`, text `Keep set`. A pending set is removed from the queue at once. If its send had already started, the server may have it: the row goes at once, and the queue replays the send with its request id to learn the set's id, then deletes it, keeping that undo until the server answers; if the server refuses, the workout screen says why and the set shows again. A saved set is removed on the server; the row comes back if that fails.
- **Workout complete**: `Upper body · Today`, cards `12 sets logged` / `4 exercises` and `All sets saved` / `Your plan reflects today's progress.` Primary `Back to today`, text `View plan`. With sets still pending: "Workout finished · 2 sets waiting to send". Done never clears the queue.
- **Done with sets still on this phone**: Done first sends the queue (up to 10 seconds). While any set is still waiting or failed, it does not close the workout, because a set sent after Done would open a second workout the same day. It stays on logging with `2 sets waiting to send. Done when they're sent.` and `Review 2 pending sets`, or `1 set not saved. Retry or remove it before Done.` and `Review failed set`.
- **Unsent sets**: `2 pending · kept on this phone until delivered`, a card per set (`◷ Pending · Bench press` / `135 lb × 8 · 9:32`) with text `Undo pending set`. Footer: "Sends automatically when connected. Original times stay attached; retries never create duplicate sets." Secondary `Back to workout`.

### Connection and update recovery

- **Connect to Tailscale**: "Chotu's private server can't be reached." Steps `1 · Open Tailscale` and `2 · Check the server address`. Primary `Try again`, text `Edit server address`. "Any sets already waiting on this phone are kept."
- **Token not accepted** (401): "The server is reachable, but this device token is invalid or has been revoked." Field `New device token`. Primary `Save and reconnect`, text `Back`. "Saved tokens stay hidden and are never included in error details."
- **Server unavailable** (5xx, or the health check fails behind Tailscale): card `2 sets waiting to send`. Primary `Try again`, secondary `Keep logging offline`. If no workout was loaded before the connection was lost, show a connection-required state rather than empty targets.
- **Update Chotu** (426): cards Installed version, Required version (`1.1.0 or later`), sets waiting to send. Primary `How to update`, text `Check again`. "Install the latest signed APK over this app, then reopen Chotu. Do not uninstall or clear storage."

### Edge states

- **Choose another profile** (403): "This device doesn't have permission to use that profile." Primary `Choose allowed profile`, text `Connection settings`. Only profiles returned for this device are shown.
- **Set wasn't saved**: `Bench press · 135 lb × 8 · 9:35`, card Reason (the server's error), card "Original set stays visible / Rejected sets are never silently dropped." Secondary `Retry unchanged`, danger `Remove failed set`, text `Back to logging`. A permanent rejection is never retried with a changed time. Retry unchanged sends the same set and time with a new request id: the server stored the rejection under the old id, so that id would only replay it. Transient failures (no connection, `5xx`, `408`, `429`, `409` while the first attempt is in flight) never mark a set failed; the set stays pending and resends with its id.
- **No workout today**: card `You're up to date`, secondary `View weekly plan`. Loading shows progress with a label; a load failure shows Retry; a first launch while offline shows "Connect to load your workout".

### Tasks ([#122](https://github.com/Prajaktcs/chotu/issues/122), [#174](https://github.com/Prajaktcs/chotu/issues/174))

Four tabs, from the household day in `GET /v1/tasks` (older servers: the phone's day):

- **Today:** **Add task**, then sections **Overdue**, **Today** and **No due date** (undated open tasks stay reachable here). Empty: `You're up to date`.
- **Upcoming:** **Scheduled** (open, due later) and **Snoozed**. Empty: `Nothing upcoming`.
- **Completed:** completed tasks newest first, `Completed Oct 25, 2026, 9:00 AM` and `Was due …`, with **Reopen**; **Load older tasks** pages. A reopened task leaves the list at once.
- **Trends:** 7 / 28 / 90 days radio; **Now** `4 open tasks · 1 overdue`; **Activity** `3 added · 2 completed` and one row per week. Empty range says so.
- **Task actions** adds a **Snooze for days** field (1–90, invalid values disable its button), **Unsnooze** for snoozed tasks and **Assign to me** for unassigned ones. Unassigned rows show `Household · unassigned`.
- **Add task** modal: Title, Due (optional, Signal's phrases, household time), Details (optional), **Save task**. Saved: the stored title and due, any model details/note and the calendar result (`Added to your calendar.`, not linked, or failed while the task is saved). Rejected: the server's message, fields kept. Unconfirmed: **Retry unchanged** (same request id and body) or **Discard**; the modal cannot be closed otherwise.

The list behaviour below applies to Today and Upcoming.

- Tasks › Today opens the selected profile's open and snoozed tasks, including unassigned household tasks. Fitness remains reachable from every Tasks state, and Tasks from every Workout home state. Full IDs stay inside the API; there is no ID field to type.
- Separate **Open** and **Snoozed** sections show title, due date (and time only when the task has one), and source email subject when available. Date-only deadlines stay calendar dates rather than shifting through UTC.
- A **rightward swipe completes immediately**, removing that row optimistically. A **leftward swipe snoozes immediately** for the selected **1, 3 or 7 days**; the duration selector is always visible above the list and defaults to 1 day. Changing that selector configures subsequent swipes; a swipe itself performs the write, not merely opening a menu.
- Tapping or long-pressing a row opens **Task actions**, with labelled **Complete task**, **Snooze 1 day**, **Snooze 3 days**, **Snooze 7 days**, and **Keep task** buttons. Screen-reader custom actions also execute completion or any snooze duration directly. All controls retain at least 48 dp targets.
- Snooze moves the row to Snoozed immediately and predicts the calendar date using the phone's current day; the server's household-timezone date replaces that prediction when saved. Snooze resets a timed task to a date-only deadline, matching Signal.
- Loading has a labelled progress indicator; an empty list says **You're up to date**. Load failures offer **Retry loading** and keep the last loaded list when available. Pull to refresh and foreground refetch bring in changes made in Signal.
- Pending writes show **Saving … tasks**. A failed write rolls back only its own optimistic overlay, never another task's successful change. An ambiguous network/server failure offers **Retry unchanged**, retaining its original request ID, task, operation and snooze days; that task cannot receive a different write until resolved. Permanent rejection offers **Keep task**. State is isolated by connection/profile and retained across tab navigation, not a new durable offline queue; keep the app open to resolve ambiguous writes.
- A successful snooze with a calendar warning remains saved and shows a dismissible warning that its calendar event may still have the old date. It is not treated as a task-write failure or rolled back.

### Section navigation

[Expanded navigation wireframes](https://www.figma.com/design/5g9Ahu955WrUnQRYOsztVd/Chotu?node-id=24-1249) ([#170](https://github.com/Prajaktcs/chotu/issues/170)). The section and tab map, with the phase that builds each tab, is in [App and Signal parity](app-parity.md#navigation-map).

- **Sections.** Today (the landing page), Fitness, Nutrition, Wellbeing and Tasks under **Your sections**; Finance and Memory under **Coming later**; then Settings. Today and Settings have no tabs.
- **Phones** (narrower than 840 dp): the app bar starts with a menu button, **Open section navigation**, that opens a drawer from the left. The drawer shows the profile name and the section list. **Close**, Android Back, Escape on the web, or a tap outside closes it; choosing a destination closes it too.
- **Expanded layouts** (840 dp and wider): the same list stays visible in a 280 dp sidebar, and there is no menu button.
- **Tabs.** Every section except Today has exactly four tabs under the app bar. Each shares the width equally, is at least 48 dp tall, and the selected one is a filled pill announced as selected. A tab whose screen is not built yet is disabled, reads **Soon** under its label, and tells screen readers "Not available yet".
- **Unavailable sections.** A section with no built tab (Wellbeing until #175, Finance, Memory) is a disabled row with **Coming soon** or **Coming later**; there are no empty placeholder screens.
- **App bar.** The section name is the title. **Profile** opens Settings; **Done** in Settings goes back.
- **Back.** Leaving Today pushes the section, so Back returns to Today. Switching tabs or sections replaces the screen, so Back never walks through every tab. Choosing Today returns to it.
- **State.** Returning to a section reopens its last tab. The workout session, unsent sets, unresolved undos, task retries and plan generation live above the screens, so navigation never drops them.

**Wellbeing rename verification ([#186](https://github.com/Prajaktcs/chotu/issues/186)).** Chromium at 390 × 844 (dark) and 1280 × 900 (light) rendered **Wellbeing / Coming soon** as a disabled button named **Wellbeing, coming soon**. Clicking it neither navigated nor closed the phone drawer. Fitness still opened `/workout`; Plan opened `/plan`, and Back returned to Today. This is a responsive web check with synthetic API responses, not an Android device or TalkBack check.

### Today ([#171](https://github.com/Prajaktcs/chotu/issues/171); Status [#124](https://github.com/Prajaktcs/chotu/issues/124))

The landing page for the selected profile: today's workout and plan, due tasks, and the numbers Signal's `/status` prints for that day. Read-only, from `GET /v1/workout`, `GET /v1/tasks` and `GET /v1/status`. Each card loads, fails and retries on its own.

From top to bottom:

1. App bar: the menu button, "Today", and the "Profile" text button. Today has no tabs.
2. Overline: the household day and the profile, `MON, OCT 26 · Alex`.
3. **Fitness** card, subtitle the plan day (`Strength · full body`). An open workout reads `Workout in progress · 3 sets · now Bench press` with **Continue workout**. Before a workout, each planned lift is a link row (`Example squat`, `3 × 8-10 · Next: …`, `Log ›`) that opens Workout with that lift chosen, as Plan does. Without lifts left: `No lifts planned for the rest of today.` and **Open Fitness**. Unsent sets on this phone show `2 sets waiting on this phone` in pending colours.
4. **Tasks** card, subtitle `2 due`: open tasks whose household `due_date` is today or earlier, oldest first, up to five (`Overdue · Sat, Oct 24`, `Due today · 3:00 PM`, `Due today`), then `3 more due`. Each row opens Tasks with that task's **Task actions**; Back returns to Today. Pending task writes from Tasks apply here too. Empty: `Nothing due today.` Then **Open Tasks**.
5. When nothing is logged or synced yet, a card `Nothing logged yet today` / "Log food in Nutrition or in Signal with /food. Steps, sleep and exercise arrive with the health sync. Pull down to refresh."
6. **Activity** card: rows `Steps 8432`, `Active energy 415 kcal`, `Sleep 7.2 h` (or `Not synced`), `Energy 7/10` (or `Not reported`).
7. **Exercise · 2** card, when any exercise synced: one line per exercise as Google Health describes it, `Running (32 min, 310 kcal)`. Signal shows the first six; the app shows all.
8. **Goals** card, for configured goals only: per goal the label and `1840 / 2200 kcal · 84%` as text, with a progress bar under it. The bar only reinforces the text; it is capped at 100% while the text shows the real percentage.
9. **Nutrition** card, once calories or a macro is logged: rows `Calories 1840 kcal`, `Protein 121.2 g`, then each other nutrient above zero in Signal's order. Fat's breakdown (saturated, cholesterol and so on) is indented under Fat in muted text, and screen readers hear "Of fat, Saturated: 18.5 g".
10. **Fitness goal** card, with fitness goals: `Outcome Run a 10k`, the countdown (`36 days to target (2026-12-01)`, `Target day is today`, or `Target date … was 3 days ago`), `Focus endurance`.
11. A note that the coach's tip and the household spending summary stay in Signal's `/status`.
12. **Open Nutrition**.

Rules:

- No Markdown: Signal's bold markers, bullets and the monospace table become cards and rows. Each row is one accessible element, `Protein: 121.2 g`.
- Numbers come from the server already rounded the way Signal prints them, so the digits always match the Signal reply (Signal rounds `121.25` to `121.2`; `toFixed` alone would show `121.3`).
- States: a labelled progress indicator per card while loading; a load failure shows a Connection card with **Retry loading** in that card. A failed refresh keeps the last loaded data with `Showing data loaded at 9:05 AM.`; a server without an endpoint says "Update the Chotu server to see this."; `401`, `403` and `426` open their recovery screens. Pull to refresh refetches every card; foreground refetch picks up a new sync, `/food` entry or task change.
- Dates: "due" uses the server's household day (`date` in `GET /v1/tasks`, else the status day), never the phone's. Data is keyed by server and profile and dropped on a switch.
- Not on Today yet: the calendar agenda and the coach tip ([#180](https://github.com/Prajaktcs/chotu/issues/180)); bills and spending stay with Finance; `/reflect` stays in Signal.

### Plan ([#124](https://github.com/Prajaktcs/chotu/issues/124))

This week's training plan, today's targets and the week's progress: the same data as Signal's `/plan`. `GET /v1/plan` and refresh are read-only; explicit app actions generate or replace a plan using the local model.

From top to bottom:

1. App bar: the menu button, "Fitness", and the "Profile" text button, then the Fitness tabs with **Plan** selected.
2. Overline `WEEK OF MON, OCT 26`, then the week's theme as a headline (`Build the base`).
3. **This week so far** card: `2 of 3 planned sessions done`, `30 min cardio logged`, `30 min on planned cardio or mixed days`. Signal's line `2/3 sessions matched · …`, one fact per line.
4. One card per day, Monday to Sunday. Header `Wednesday · Strength · Today` (the word "Today" marks today, not only the styling); under it the date and the day's notes, `Wed, Oct 28 · full body, RPE 7`. Rest days say `Rest day`.
5. Each exercise is a link row (at least 48 dp, `container` background): the name with `Log ›` on the right, then sets and reps as the plan writes them (`3 × 10-12`, `30 min easy`). Today's rows add the next target from the set log, as on the workout screen: `Next: 190 lb · aim 10/10/10 · +10 lb`, or the first-time note. Weights use the profile's unit.

Rules:

- Tapping an exercise opens **Workout** with that exercise chosen and its target pre-filled, the same as choosing it on Change exercise. Another day's exercise opens it too, to log it today as an extra lift. Screen readers hear the row as a link, `Leg press. 3 × 10-12. Next: 190 lb · aim 10/10/10 · +10 lb`, with the hint "Opens the workout screen to log it".
- Each mapped row has a separate **Watch demo** action. It opens the row's own media in a closeable modal without choosing an exercise or starting a workout, including another day's exercises. Unknown exercises say **No demo available**. YouTube loads only after the action, retains its own controls, and stops on close/blur/background; hosted media retains its existing player.
- Without goals, show configuration guidance. Without a saved week, offer **Generate plan**. Existing or unreadable weeks offer **Regenerate plan**, followed by **Replace plan** / **Keep current plan** confirmation and the explanation that logged workouts are kept. Keep the old week visible while generating or on failure; explicit retry retains the same request identity.
- No Markdown or Signal symbols (`📌`, `📊`, `◦`): days and exercises are cards and rows.
- Loading, failure with **Retry loading**, recovery routing and refresh behave as on Status.

### Fitness History and Trends ([#172](https://github.com/Prajaktcs/chotu/issues/172))

**History** (`GET /v1/workout/history`): one card per recorded workout, newest first. Header `Mon, Oct 26` (plus `· In progress` for today's open workout), subtitle `2 exercises · 7 sets`. Each exercise lists numbered sets `1. 135 lb × 8` with the time on the right (phone clock). Screen readers hear `Bench press set 1: 135 lb × 8 at 9:05 AM`. **Load older workouts** fetches the next ten workout days; the last page says "That's every logged workout." Empty: `No workouts logged yet` with where sets come from.

**Trends** (`GET /v1/workout/trends`): a **7 / 28 / 90 days** radio group (default 28), then the range overline `Oct 5 – Nov 1 · last 28 days`. **Volume** card: workout days and sets for the range, then one row per week. One card per exercise, most-trained first: the first-to-latest top-load change (`+10 lb top load`, `Same top load (135 lb)`), then the latest five days as `135 lb × 8/8/7`. One session says "One session in this range. Log it again to see a trend."; bodyweight-only exercises compare reps. No range has training: `No training in the last 28 days`. Only synced sessions: a note that there are no sets to compare. No derived scores or estimates.

Both: labelled progress while loading; load failure with **Retry loading**, keeping loaded data; a server without these endpoints says "Update the Chotu server to see this."; pull to refresh and foreground refetch; data is scoped to the profile and dropped on a profile switch.

### Nutrition ([#173](https://github.com/Prajaktcs/chotu/issues/173))

- **Today:** the household's today from `GET /v1/food` without a date. **Today's totals** card from `GET /v1/status` (main nutrients and non-step goals with their bars), then **Add a meal** and the meal list, then **Day tools**: **Clear today's meals** (disabled with no meals) and **Set today's totals**. Each opens a confirmation screen: clear names the meal count and what stays; set takes calories, protein, carbs and fat and is disabled until all four are valid (whole kcal 0–20000, grams 0–2000).
- **Food log:** the previous single Food screen: day header with **‹ / ›** (never past today) and **Back to today**, add, edit and delete.
- **Goals:** `Today against your goals` with each configured nutrition goal (text plus bar, as on Today), then a note that targets come from `config.yaml` and can't be changed in the app. None: `No goals set`.
- **Trends:** 7 / 28 / 90 days radio; overline `Oct 21 – Oct 27 · 2 of 7 days with a summary`; **Daily average** rows (`Calories 2075 kcal / 2200`) over days with a summary; **By day** for the latest 14 days. None: `No nutrition summaries in the last 28 days`.
- One food write at a time per profile (`FoodActions`): progress while saving; failures show the server's message, **Retry** with the same request id, and **Dismiss** only when nothing may have been saved.

### Later phases

The Figma file also has an Exercise demo screen. It is built in #125.

## Weight units

`family.members[].weight_unit` in server `config.yaml` sets `lb` (default) or `kg` for Signal and the app. Settings shows the server value read-only; no phone-local preference overrides it. `/v1/me` refreshes the chosen profile's unit. Loads stay in pounds in storage; API responses retain `weight_lb` for v1 clients and add `weight` plus `unit` for display. A 60 kg × 8 set stores about 132.277 lb and displays 60 kg in both clients. Steppers and progression targets use 5 lb or 2.5 kg increments (lower-body progression adds two increments). Requests always include the entered load and its unit; queued sets retain their original unit even if the member's configuration changes.

Legacy saved profiles without a server unit remain unknown until metadata or a workout response supplies it; they do not silently become lb. A kg workout response drives kg controls even while `/v1/me` is delayed. Without either authority, logging asks to retry the profile; a known cached server unit continues to work offline. Connection refreshes and user changes share one serialized persistence path, so delayed metadata cannot restore an old server, token or profile on restart.
