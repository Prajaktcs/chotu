# App design

The Chotu app's screens, states and design tokens. The source of truth is the Figma file [Chotu · Phase 2 app designs](https://www.figma.com/design/5g9Ahu955WrUnQRYOsztVd/Chotu-%C2%B7-Phase-2-app-designs?node-id=0-1). This page records what the code builds to. The tokens live in `app/src/theme/`.

The look is Material 3 on Android: Roboto, neutral green surfaces, light and dark mode.

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
13. Bottom navigation: Workout, Tasks, Status, Plan. Only Workout exists in phase 2.

Interaction notes:

- Log at the target: 1 tap.
- Undo: swipe a set or long-press it, then Undo.
- Pending sets keep their original time. Undo removes an unsent set from the queue.
- The demo loads only on view. Log and Done stay usable while it loads.

### First run and session

- **Connect to Chotu** (setup): "Use the server address and device token provided for this phone." Fields: Server address (`https://mini.ts.net:8787`), Device token. Note: "The token is hidden after saving." Primary `Connect`. Footer: "Connect to Tailscale before continuing." and text button `Connection help`.
- **Choose your profile**: "Only profiles allowed for this device appear here." One secondary button per profile, `Alex · lb`. Footer: "You can switch profiles from settings. Your token stays hidden."
- **Ready to train**: overline with date and plan day, a card per exercise (`Bench press` / `3 sets · next target 135 lb × 8`), primary `Start workout`. Shown when no set has been logged today.
- **Settings**: "Device connection and profile". Cards: Server (the URL), Device token (`Saved · hidden`). Secondary `Switch profile`, text `Replace device token`. Cards: Weight unit (`lb · set by your profile`), Appearance (`Use device setting`).

### Session actions and offline

- **Change exercise**: overline `TODAY'S WORKOUT`, one secondary button per exercise (`Bench press · 2 of 3 sets`), text `Back to workout`. Choosing one returns to logging with its next target pre-filled.
- **Set actions**: a card `Bench press · Set 2` / `135 lb × 8 · Saved at 9:32`, danger `Undo this set`, text `Keep set`. A pending set is removed from the queue at once. A saved set is removed on the server; the row comes back if that fails.
- **Workout complete**: `Upper body · Today`, cards `12 sets logged` / `4 exercises` and `All sets saved` / `Your plan reflects today's progress.` Primary `Back to today`, text `View plan`. With sets still pending: "Workout finished · 2 sets waiting to send". Done never clears the queue.
- **Unsent sets**: `2 pending · kept on this phone until delivered`, a card per set (`◷ Pending · Bench press` / `135 lb × 8 · 9:32`) with text `Undo pending set`. Footer: "Sends automatically when connected. Original times stay attached; retries never create duplicate sets." Secondary `Back to workout`.

### Connection and update recovery

- **Connect to Tailscale**: "Chotu's private server can't be reached." Steps `1 · Open Tailscale` and `2 · Check the server address`. Primary `Try again`, text `Edit server address`. "Any sets already waiting on this phone are kept."
- **Token not accepted** (401): "The server is reachable, but this device token is invalid or has been revoked." Field `New device token`. Primary `Save and reconnect`, text `Back`. "Saved tokens stay hidden and are never included in error details."
- **Server unavailable** (5xx, or the health check fails behind Tailscale): card `2 sets waiting to send`. Primary `Try again`, secondary `Keep logging offline`. If no workout was loaded before the connection was lost, show a connection-required state rather than empty targets.
- **Update Chotu** (426): cards Installed version, Required version (`1.1.0 or later`), sets waiting to send. Primary `How to update`, text `Check again`. "Install the latest signed APK over this app, then reopen Chotu. Do not uninstall or clear storage."

### Edge states

- **Choose another profile** (403): "This device doesn't have permission to use that profile." Primary `Choose allowed profile`, text `Connection settings`. Only profiles returned for this device are shown.
- **Set wasn't saved**: `Bench press · 135 lb × 8 · 9:35`, card Reason (the server's error), card "Original set stays visible / Rejected sets are never silently dropped." Secondary `Retry unchanged` for transient failures, danger `Remove failed set`, text `Back to logging`. A permanent rejection is never retried with a changed time.
- **No workout today**: card `You're up to date`, secondary `View weekly plan`. Loading shows progress with a label; a load failure shows Retry; a first launch while offline shows "Connect to load your workout".

### Later phases

The Figma file also has Tasks, Snooze, Status, Plan and Exercise demo screens. They are built in #122, #124 and #125.

## Weight units

The API stores and returns pounds (`weight_lb`). Until per-member units land server-side (#131), the app keeps a per-profile unit on the phone (default `lb`), shows weights in it, steps by 5 lb or 2.5 kg, and sends `unit` with every set.
