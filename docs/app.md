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
