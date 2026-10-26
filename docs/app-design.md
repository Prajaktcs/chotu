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

The tokens below already match `app/src/theme/`; this records the implementation
baseline, **not human agreement**. Product-owner token agreement and a human
high-fidelity review remain explicit signoff items. Arm's-length readability,
sweaty-hand one-handed use, Android touch targets and TalkBack require a physical
device review. The frame table above is the link guide for #133 and its five
implementation issues; each fragment opens the corresponding review artifact.

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

1. App bar: "Workout", with a "Profile" text button on the right that opens Settings.
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
13. Bottom navigation: Workout, Plan, Status and Tasks.

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

### Tasks ([#122](https://github.com/Prajaktcs/chotu/issues/122))

- The Tasks bottom tab opens the selected profile's open and snoozed tasks, including unassigned household tasks. Workout remains reachable from every Tasks state, and Tasks from every Workout home state. Full IDs stay inside the API; there is no ID field to type.
- Separate **Open** and **Snoozed** sections show title, due date (and time only when the task has one), and source email subject when available. Date-only deadlines stay calendar dates rather than shifting through UTC.
- A **rightward swipe completes immediately**, removing that row optimistically. A **leftward swipe snoozes immediately** for the selected **1, 3 or 7 days**; the duration selector is always visible above the list and defaults to 1 day. Changing that selector configures subsequent swipes; a swipe itself performs the write, not merely opening a menu.
- Tapping or long-pressing a row opens **Task actions**, with labelled **Complete task**, **Snooze 1 day**, **Snooze 3 days**, **Snooze 7 days**, and **Keep task** buttons. Screen-reader custom actions also execute completion or any snooze duration directly. All controls retain at least 48 dp targets.
- Snooze moves the row to Snoozed immediately and predicts the calendar date using the phone's current day; the server's household-timezone date replaces that prediction when saved. Snooze resets a timed task to a date-only deadline, matching Signal.
- Loading has a labelled progress indicator; an empty list says **You're up to date**. Load failures offer **Retry loading** and keep the last loaded list when available. Pull to refresh and foreground refetch bring in changes made in Signal.
- Pending writes show **Saving … tasks**. A failed write rolls back only its own optimistic overlay, never another task's successful change. An ambiguous network/server failure offers **Retry unchanged**, retaining its original request ID, task, operation and snooze days; that task cannot receive a different write until resolved. Permanent rejection offers **Keep task**. State is isolated by connection/profile and retained across tab navigation, not a new durable offline queue; keep the app open to resolve ambiguous writes.
- A successful snooze with a calendar warning remains saved and shows a dismissible warning that its calendar event may still have the old date. It is not treated as a task-write failure or rolled back.

### Bottom navigation

Four tabs on every home screen: **Workout**, **Plan**, **Status** and **Tasks**. Each tab shares the width equally and is at least 48 dp tall. The selected tab is a filled pill and is announced as selected; switching tabs keeps the workout session.

### Status ([#124](https://github.com/Prajaktcs/chotu/issues/124))

Today's health numbers for the selected profile, the same ones Signal's `/status` prints for that day. Read-only, from `GET /v1/status`.

From top to bottom:

1. App bar: "Status", with the "Profile" text button.
2. Overline: the household day and the profile, `MON, OCT 26 · Alex`.
3. When nothing is logged or synced yet, a card `Nothing logged yet today` / "Log food in Signal with /food. Steps, sleep and exercise arrive with the health sync. Pull down to refresh."
4. **Activity** card: rows `Steps 8432`, `Active energy 415 kcal`, `Sleep 7.2 h` (or `Not synced`), `Energy 7/10` (or `Not reported`).
5. **Exercise · 2** card, when any exercise synced: one line per exercise as Google Health describes it, `Running (32 min, 310 kcal)`. Signal shows the first six; the app shows all.
6. **Goals** card, for configured goals only: per goal the label and `1840 / 2200 kcal · 84%` as text, with a progress bar under it. The bar only reinforces the text; it is capped at 100% while the text shows the real percentage.
7. **Nutrition** card, once calories or a macro is logged: rows `Calories 1840 kcal`, `Protein 121.2 g`, then each other nutrient above zero in Signal's order. Fat's breakdown (saturated, cholesterol and so on) is indented under Fat in muted text, and screen readers hear "Of fat, Saturated: 18.5 g".
8. **Fitness goal** card, with fitness goals: `Outcome Run a 10k`, the countdown (`36 days to target (2026-12-01)`, `Target day is today`, or `Target date … was 3 days ago`), `Focus endurance`.
9. A note that the coach's tip and the household spending summary stay in Signal's `/status`.

Rules:

- No Markdown: Signal's bold markers, bullets and the monospace table become cards and rows. Each row is one accessible element, `Protein: 121.2 g`.
- Numbers come from the server already rounded the way Signal prints them, so the digits always match the Signal reply (Signal rounds `121.25` to `121.2`; `toFixed` alone would show `121.3`).
- States: a labelled progress indicator while loading; a load failure shows a Connection card with **Retry loading** and keeps the last loaded status; `401`, `403` and `426` open their recovery screens. Pull to refresh and foreground refetch pick up a new sync or `/food` entry.

### Plan ([#124](https://github.com/Prajaktcs/chotu/issues/124))

This week's training plan, today's targets and the week's progress: what Signal's `/plan` shows. Read-only, from `GET /v1/plan`; the app never generates a plan.

From top to bottom:

1. App bar: "Plan", with the "Profile" text button.
2. Overline `WEEK OF MON, OCT 26`, then the week's theme as a headline (`Build the base`).
3. **This week so far** card: `2 of 3 planned sessions done`, `30 min cardio logged`, `30 min on planned cardio or mixed days`. Signal's line `2/3 sessions matched · …`, one fact per line.
4. One card per day, Monday to Sunday. Header `Wednesday · Strength · Today` (the word "Today" marks today, not only the styling); under it the date and the day's notes, `Wed, Oct 28 · full body, RPE 7`. Rest days say `Rest day`.
5. Each exercise is a link row (at least 48 dp, `container` background): the name with `Log ›` on the right, then sets and reps as the plan writes them (`3 × 10-12`, `30 min easy`). Today's rows add the next target from the set log, as on the workout screen: `Next: 190 lb · aim 10/10/10 · +10 lb`, or the first-time note. Weights use the profile's unit.

Rules:

- Tapping an exercise opens **Workout** with that exercise chosen and its target pre-filled, the same as choosing it on Change exercise. Another day's exercise opens it too, to log it today as an extra lift. Screen readers hear the row as a link, `Leg press. 3 × 10-12. Next: 190 lb · aim 10/10/10 · +10 lb`, with the hint "Opens the workout screen to log it".
- Without a plan: `No fitness goals yet` / "Add fitness_goals for Alex in config.yaml, then send /plan in Signal.", `No plan this week yet` / "Send /plan in Signal to build this week's plan, then pull down to refresh.", or, when the saved plan can't be read, `This week's plan can't be shown` / "Chotu couldn't read the saved plan. Send /plan in Signal to see it there."
- No Markdown or Signal symbols (`📌`, `📊`, `◦`): days and exercises are cards and rows.
- Loading, failure with **Retry loading**, recovery routing and refresh behave as on Status.

### Later phases

The Figma file also has an Exercise demo screen. It is built in #125.

## Weight units

The API stores and returns pounds (`weight_lb`). Until per-member units land server-side (#131), the app keeps a per-profile unit on the phone (default `lb`), shows weights in it, steps by 5 lb or 2.5 kg, and sends `unit` with every set.
