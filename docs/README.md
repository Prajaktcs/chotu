# Chotu operator docs

Living notes for running the household agent: credentials, services, and how Signal commands behave.

| Page | What’s here |
| :--- | :--- |
| [Services & credentials](./services-and-credentials.md) | APIs, OAuth, env vars, what breaks if something is missing |
| [Setup commands](./commands/setup.md) | Signal identity configuration, `/whoami`, `/chat`, `/login` |
| [App](./app.md) | Build, sign and sideload the Android APK; add a phone, first-run setup, revoke a device, keystore backup |
| [App API](./app-api.md) | Enable the app's HTTP API on loopback and expose it with `tailscale serve` |
| [App design](./app-design.md) | Screen/state links, viewable wireframes, workout high fidelity and implemented tokens |
| [Health commands](./commands/health.md) | Food, sync, status, trends, plan, workout log, tags, watchlists |
| [Day loop](./commands/day-loop.md) | Brief, calendar, tasks, reflection |
| [Memory](./commands/memory.md) | `/memory` RAG |
| [Finance](./commands/finance.md) | Monthly, budget, net worth, research |
| [Condition tracking spec](./condition-tracking-spec.md) | M1–M5 shipped (tags, check-ins, watchlists, meal flags, coaching); M6 trends still open |
| [App technical design](./app-technical-design.md) | Expo app + private HTTPS API over a shared Rust service layer; phased plan starting with gym set logging |
| [Relationship graph spec](./relationship-graph-spec.md) | Product intent only: local people graph, multi-channel ingest, brief/cal/memory leverage |
| [Signal vs Telegram](./signal-vs-telegram.md) | What carried over after the chat transport switch — and what you miss |

**Secrets:** never put real API keys, tokens, or refresh tokens in these files. Values live only in local `.env` (gitignored). Document names and “where to get them,” not the secrets themselves.

The story of the project (why it exists, how it is built, what it is) lives in the root [README](https://github.com/Prajaktcs/chottu/blob/main/README.md). This folder is the operator manual.

## API and app contributor route

Start with [Services & credentials](./services-and-credentials.md#minimum-to-get-signal-talking)
and `just setup`; the API runs inside the coordinator, not a separate server.
Then follow [API setup](./app-api.md#setup) → [add a phone](./app.md#add-a-phone)
→ [build](./app.md#build-the-apk) → [install](./app.md#install-on-a-phone)
→ [first run](./app.md#first-run-on-the-phone). Use synthetic profiles in a local
config, never copy household data into a contribution.

| Config / recipe | Purpose |
| :--- | :--- |
| `api.bind` | Optional loopback socket, e.g. `127.0.0.1:8787`; omitted disables API |
| `api.devices[].name` | Device identity, ASCII letters/digits/underscore |
| `api.devices[].members` | Allowed `family.members[].id` profiles; no household-group access |
| `API_TOKEN_<DEVICE>` | Salted Argon2id hash in `.env`, not a YAML key or raw token |
| `just api-token <device>` | Mint raw token once and print its hash assignment |
| `just app-keystore` | Generate release signing key once; back it up |
| `just app-apk` | Generate Android project and build signed release APK |
| `just app-lint` / `just app-fmt` / `just app-test` | App checks, formatting and tests |

There is no `just app-install`: use `adb install` for first install and
`adb install -r` for updates. Node 24+, JDK 17+, Android SDK and USB debugging
requirements are listed in [Before you start](./app.md#before-you-start).
To inspect recipe commands without minting tokens, building or connecting to live
services, run `just --dry-run api-token demo_phone`, `just --dry-run app-keystore`,
`just --dry-run app-apk` and `just --dry-run run` in a clean checkout without `.env`.
