# App

How to build the Chotu Android app, sign it, install it on a family phone and keep it updated. The app is sideloaded: there is no Play Store listing and no EAS Update. The phone talks only to the [App API](./app-api.md) on the Mac mini, over the tailnet.

## Before you start

On the Mac that builds the APK:

- Node.js (24 or newer) and the app's dependencies: `(cd app && npm ci)`.
- A JDK, 17 or newer. `keytool` ships with it.
- The Android SDK. Android Studio installs it in `~/Library/Android/sdk`. `just app-apk` uses that path when `ANDROID_HOME` is unset.
- `adb`, from the SDK's `platform-tools`, to install over USB.

On the Mac mini, the [App API](./app-api.md) is enabled and exposed with `tailscale serve`. Each phone is on the tailnet.

## Signing key

Every APK is signed with one release keystore. Android installs an update only when it carries the same signature as the installed app. Generate the keystore once, keep it out of git, and back it up.

> ⚠️ **If the keystore or its password is lost, no new build can update the installed app.** Each phone must uninstall Chotu and install a build signed with a new key. The server keeps all data, but the phone loses its saved token and any sets still queued offline.

The keystore path and passwords live in the root `.env`, which is gitignored. `just setup` adds the names with empty values:

| Variable | Value |
| --- | --- |
| `CHOTU_ANDROID_KEYSTORE_PATH` | The keystore file. Absolute, `~/...`, or relative to the repo root. Keep it outside the repo, for example `~/.config/chotu/chotu-release.keystore`. |
| `CHOTU_ANDROID_KEYSTORE_PASSWORD` | The keystore password. |
| `CHOTU_ANDROID_KEY_ALIAS` | The key's alias inside the keystore. `chotu` by default. |
| `CHOTU_ANDROID_KEY_PASSWORD` | The key password. The same value as the keystore password (PKCS12 keystores use one password). |

### Create the keystore (once)

1. Pick a long random password:

   ```sh
   openssl rand -base64 24
   ```

2. Fill the four variables in `.env`. Use the password for both `CHOTU_ANDROID_KEYSTORE_PASSWORD` and `CHOTU_ANDROID_KEY_PASSWORD`.

3. Create the keystore:

   ```sh
   just app-keystore
   ```

   It writes a PKCS12 keystore with a 4096-bit RSA key, valid for about 27 years, readable only by you (`chmod 600`). It refuses to run when the file already exists, so it cannot replace the key your phones trust.

4. Back it up now. See [Back up the keystore](#back-up-the-keystore).

Passwords are passed to `keytool` and Gradle through the environment. They are never written to a file in the repo or in the generated `app/android/`.

### Back up the keystore

Treat the keystore like `.env`: it is a secret, and it cannot be recreated.

- Store the keystore file **and** the four `.env` values together, in a password manager (as an attached file) or an encrypted backup.
- Keep at least one copy off the Mac mini, so a lost or wiped disk does not take the only copy with it.
- Never commit it, email it, or put it in an unencrypted cloud folder. `.gitignore` ignores `*.jks` and `*.keystore` as a safety net, not as permission to keep it in the repo.

### Restore the keystore

On a fresh clone or a new Mac:

1. Run `just setup`.
2. Copy the keystore file from your backup to the path you chose, then run `chmod 600` on it.
3. Fill the four `CHOTU_ANDROID_*` values in `.env` from the same backup.
4. Build with `just app-apk`. It prints the signing certificate's SHA-256 digest. Compare it with the digest from an earlier build to confirm it is the same key.

Do not run `just app-keystore` to replace a lost keystore unless you accept that every phone must uninstall Chotu first.

## Build the APK

```sh
just app-apk
```

It:

1. Checks that the four signing variables are set and that the keystore file exists, and stops with a message naming what is missing.
2. Regenerates `app/android/` with `expo prebuild --clean`. The folder is generated from `app/app.config.ts` and is gitignored. Do not edit it by hand.
3. Runs `./gradlew assembleRelease`, which signs the APK with the keystore.
4. Prints the signing certificate and the APK path:

   ```text
   V2 Signer: certificate DN: CN=Chotu
   V2 Signer: certificate SHA-256 digest: 3b9f...
   APK: /path/to/chotu/app/android/app/build/outputs/apk/release/app-release.apk
   ```

The first build downloads Gradle and the Android dependencies and can take several minutes. Later builds reuse the Gradle cache in `~/.gradle`.

A release build never falls back to the debug key. When a signing variable is missing, Gradle stops with `Release signing is not configured. Set ...`, and the build produces no APK. Debug builds (`npm run android` in `app/`) need no keystore.

How it works: the config plugin `app/plugins/with-release-signing.js` adds a `release` signing config to the generated `android/app/build.gradle`. That config reads the four variables with `System.getenv(...)` at build time. Running prebuild again leaves the file unchanged.

After a build, `git status` shows nothing new: the keystore lives outside the repo, and `app/android/` is ignored.

## Install on a phone

1. On the phone, enable **Developer options**, then **USB debugging**.
2. Connect it over USB and accept the prompt to trust this computer.
3. Check that `adb` sees it:

   ```sh
   adb devices
   ```

4. Install:

   ```sh
   adb install app/android/app/build/outputs/apk/release/app-release.apk
   ```

Without USB, copy the APK to the phone (for example through a file share on the tailnet) and open it. Android asks you to allow installs from that app once.

The Android package id is `io.github.prajaktcs.chotu`. It is permanent: a build with a different id installs as a separate app, with its own token and settings.

## Update the app

Build a new APK with the same keystore, then install it over the old one:

```sh
adb install -r app/android/app/build/outputs/apk/release/app-release.apk
```

`-r` replaces the app and keeps its data, including the saved token and any queued sets. Opening the APK on the phone does the same.

- **Never uninstall to update.** Uninstalling deletes the saved token and any sets still waiting to send.
- If Android refuses with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the APK was signed with a different key. Find the original keystore (see [Restore the keystore](#restore-the-keystore)) rather than uninstalling.
- There is no over-the-air update. EAS Update would route the app's code through Expo's servers.

The server tells an outdated app to update: below the server's `min_app_version`, the app shows **Update Chotu** (see [Versions](./app-api.md#versions)). Install the new APK over it, then reopen Chotu.

## Add a phone

Each phone (or shared tablet) is a device with its own token. On the Mac mini:

1. Mint a token. The device name uses ASCII letters, digits and `_`:

   ```sh
   just api-token alex_phone
   ```

   It prints the token once, then a line like `API_TOKEN_ALEX_PHONE='$argon2id$v=19$...'`.

2. Add that line to `.env`, single quotes included.

3. List the device and the profiles it may use in `config.yaml`:

   ```yaml
   api:
     bind: 127.0.0.1:8787
     devices:
       - name: alex_phone
         members: [alex]
   ```

4. Restart Chotu (`just run`).

Send the token to the phone's owner over a private channel, such as a Signal DM. Only its hash is stored on the server. If it is lost, mint a new one.

Details, including shared devices with several profiles, are in [Devices and profiles](./app-api.md#devices-and-profiles).

## First run on the phone

1. Connect the phone to Tailscale.
2. Open Chotu. On **Connect to Chotu**, enter:
   - **Server address:** `https://<mini>.<tailnet>.ts.net:8787`, the mini's MagicDNS name (`tailscale status` shows it) and the `tailscale serve` port.
   - **Device token:** the token from `just api-token`.
3. Tap **Connect**, then choose your profile.

The token is stored in the phone's secure storage and is not shown again. To check the address first, open `https://<mini>.<tailnet>.ts.net:8787/v1/health` in the phone's browser.

## Log sets offline

Every set goes through a queue on the phone, online or not. A set is saved on the phone first, then sent in the order it was tapped. Each keeps the request ID and time from its tap, so a resend is the same write and the server never records it twice. Sets wait through no signal, server errors and app restarts. The queue is per server and profile, and lives in the app's local storage, so uninstalling deletes it (see [Update the app](#update-the-app)).

- **Not saved on this phone yet:** the phone's storage refused the write. The sets are kept in memory and the write is retried, also after switching profiles. Keep Chotu open until the banner goes away.
- **Failed:** the server refused the set, for example because it is more than 7 days old. Use **Retry unchanged** or **Remove failed set**.
- **Undo** of a queued set removes it at once. If its send had started, the server may have it: the queue keeps the undo, learns the set's ID by resending with the same request ID, then deletes it. This also holds when Undo is tapped while a delivered set is still on screen: it stays hidden until the delete is answered.
- A `404` to that delete for a set done in the last 6 days means it is already gone (for example removed in Signal), so the undo is done. For an older set it means the server can no longer reach it: the workout screen says **Couldn't undo ...: it's more than 7 days old** and the set shows again. Any other refusal says **Couldn't undo ...** with the server's reason.
- These messages stay until you tap **Dismiss**.

### Sets queued for more than 7 days

The server keeps each write's response for 7 days (see [Writes are idempotent](./app-api.md#writes-are-idempotent)). After that, a resend is a new write, and the server refuses a set more than 7 days old with `422`. So for a set whose answer was lost and that waited longer than that:

- A plain queued set shows as **Failed**, even if the first send was saved. Check that day's workout before **Retry unchanged**, or the set may be recorded twice.
- An undone set can't learn its ID, so the queue can't delete it. The workout screen says **Couldn't confirm ... was undone** and the queue forgets the undo. The set may still be saved on the server, and the app can't remove a set that old.

Only the server's "more than 7 days old" refusal is reported this way, because the app can't tell a stored one from an expired request. Any other `422` to a resend of an undone set is a stored refusal: the set never landed, so the undo is done.

## Manage tasks on the phone

Open **Tasks** in the bottom navigation; **Workout** returns to logging without changing the workout session. The list includes your profile's open and snoozed tasks plus unassigned household tasks, with separate Open and Snoozed sections.

- **Complete:** swipe a task right. It disappears immediately.
- **Snooze:** choose **1 day**, **3 days** or **7 days** above the list, then swipe a task left. That swipe sends the snooze immediately and moves it to Snoozed. The saved date follows the household's timezone, just like Signal.
- **Without swiping:** tap or long-press the task to open **Task actions**, then choose **Complete task** or the desired snooze duration. Screen readers also expose these actions directly. No task ID entry is needed.
- Pull down to refresh changes made in Signal. The app also refreshes when brought to the foreground.

If a write fails, its optimistic list change is rolled back without discarding other successful actions. **Retry unchanged** reuses the original request ID and snooze duration when the server may already have saved it; resolve this before changing that task again. Task actions are not an offline queue: keep the app open until an ambiguous write is resolved. A permanent rejection can be dismissed with **Keep task**. If a snooze saves but its calendar update fails, the app shows a warning while keeping the task's new date.

## Check today's status and this week's plan

**Status** in the bottom navigation shows today's steps, active energy, sleep, energy, synced exercises, goals and nutrition for your profile: the same numbers as Signal's `/status` for that day. The coach's tip and the household spending summary stay in Signal.

**Plan** shows this week's training plan, today's targets from your set log, and how many planned sessions you have done. Tap any exercise to open **Workout** with it chosen and its target pre-filled. The app never builds a plan: send `/plan` in Signal first, then pull down to refresh.

Both screens refresh when pulled down and when the app comes to the foreground.

## Exercise demos and verification

Optional demos are configured by normalized exercise name using hand-picked public URLs and pinned hashes; see [API source, privacy, and configuration](./app-api.md#exercise-demos). There are no bundled production videos or tracking/iframe embeds. Without configured media the existing workout flow is unchanged.

**Ready to train** uses FlashList: only onscreen posters load, and tapping a poster selects the single muted looping player. Another visible poster replaces it. Scrolling the player offscreen, navigating away, changing exercises (including recycled cells sharing a URL), or backgrounding Chotu pauses and releases it. On the logging screen the current exercise has the same tap-to-play demo. Log/Done and the offline queue never wait for images, video, or the media proxy. A media failure shows **Demo unavailable. You can still log this exercise.**

Posters use memory-and-disk caching; native videos use Expo's device cache and web videos use normal immutable HTTP caching. Caches can be evicted by the OS/browser. Native caching requires a native build containing the new `expo-video`/`expo-image` modules; rebuild the APK after updating these dependencies. Background playback and picture-in-picture are disabled.

### Functional checks

From the repository root:

```sh
cargo test -p coordinator api:: -- --test-threads=2
cargo test -p chotu-common family:: -- --test-threads=2
(cd app && npm run lint)
(cd app && npm test -- --runInBand src/workout/exercise-media.test.tsx \
  src/workout/workout.test.tsx src/api/client.test.ts src/plan/plan-screen.test.tsx)
(cd app && npx expo export --platform web)
```

For a real-browser smoke without licensed assets, generate **temporary synthetic test media**, never production demo substitutes:

```sh
SMOKE="$(mktemp -d /tmp/chotu-media-smoke.XXXXXX)"
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=30 -t 2 \
  -c:v libx264 -pix_fmt yuv420p -an -movflags +faststart "$SMOKE/video.mp4"
ffmpeg -i "$SMOKE/video.mp4" -frames:v 1 -q:v 6 "$SMOKE/poster.jpg"
CHOTU_MEDIA_SMOKE_DIR="$SMOKE" cargo test -p coordinator \
  media_browser_smoke_server -- --ignored --nocapture
```

The opt-in test starts the real API on a random loopback port with a temporary synthetic-member database, a full exercise plan, and an isolated media cache under `$SMOKE`. `connection.json` there gives its base URL and test-only token. It preloads the synthetic bytes into the verified cache; **this proves cached delivery, not a successful cold download from a real public media host**. Serve the exported `app/dist` and proxy `/v1/*` to that API on one loopback origin, connect the web app to that origin, and exercise:

- no video request/player before tapping; only visible posters load;
- one decoded, muted, looping H.264 player; another visible demo replaces it;
- scrolling through the plan releases the old player, including recycled rows sharing the same URL;
- hold a video response pending in browser network interception, then Log a set and confirm it saves before releasing the media response;
- Log and Done also work during playback; navigation releases the player;
- range `bytes=0-15` returns 16 bytes with `206`; matching ETag returns `304`; replay uses the browser cache without fetching the video again.

Stop the API with Ctrl-C and delete the temporary fixture directory after testing. No household database, media, config, or token is needed.

### Device performance acceptance is separate

Before closing [#125](https://github.com/Prajaktcs/chotu/issues/125), use licensed, operator-validated public assets on the real hosting path and record:

1. Device model, Android version, app build, media hash/size, Wi-Fi conditions, and first-frame timings: at most **3 s** on first load over Wi-Fi and **1 s** from device cache. Use a fresh asset hash or a dedicated test install for the cold run; do not clear a household app's storage/unsent sets. Fully view the video, restart the app, and verify cached replay with the media endpoint unavailable and no new video transfer.
2. Log/Done responses during a deliberately slow first load and normal playback; neither may wait for media.
3. Approximately **60 fps** on a mid-range Android phone using the React Native performance monitor while scrolling the entire plan repeatedly; record memory before/after repeated full-plan scrolls (for example with `adb shell dumpsys meminfo io.github.prajaktcs.chotu`) and check it plateaus rather than grows per exercise.
4. A web-export browser pass for lazy posters, one player, release, cache replay, and logging, plus a successful cold fetch from the configured public host through the safe API proxy.

**Observed on 2026-10-26:** 45 scoped coordinator API tests and 26 common configuration tests passed; app lint/types, 95 focused app tests, and web export passed. A real Chromium browser against the real API decoded a generated 2 s, 640×360 H.264 MP4 (197,599 bytes; no audio) and a 14,205-byte JPEG poster. It verified one player, paused/disconnected offscreen playback, cached replay (`transferSize: 0`), `206`/`304`, and no token/member headers on media. A set saved while its video request was held (`readyState: 0`, 72 ms); logging during decoded playback took 32 ms and Done 53 ms on localhost. These are functional smoke observations, **not device/Wi-Fi performance measurements**.

No Android device was attached (`adb devices -l` was empty), and no licensed production URLs were supplied. Actual device FPS/memory, first-load/cache timing targets, persistent native-cache replay, and a cold fetch of the selected licensed public assets remain unverified. Keep #125 open until those results are recorded.

## Revoke a device

For a lost phone, or a token that leaked:

1. Remove its `API_TOKEN_<DEVICE>` line from `.env`.
2. Restart Chotu.

The device gets `401` on its next request. Remove its entry from `config.yaml` too, or keep it and mint a new token to re-enable it later. A configured device with no token line logs a warning at startup.

To rotate a token, mint a new one with `just api-token <device>`, replace the line in `.env`, restart, and enter the new token in the app (**Settings → Replace device token**).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Android signing is not configured. Set in .env: ...` | Fill the named variables in `.env`. |
| `keystore not found` | Restore the keystore from your backup, or create the first one with `just app-keystore`. |
| `Keystore was tampered with, or password was incorrect` | The password in `.env` does not match the keystore. Restore both from the same backup. |
| `set ANDROID_HOME` | Install the Android SDK, or point `ANDROID_HOME` at it. |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | The APK has a different signature than the installed app. Build with the original keystore. |
| The app cannot reach the server | Check that the phone is on Tailscale and that `/v1/health` loads in its browser. |
| **Token not accepted** in the app | The token was revoked or mistyped. Mint a new one and enter it. |
