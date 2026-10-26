set dotenv-load := true

# Display available commands
default:
    @just --list

# Create config.yaml and template .env file if they do not exist
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        if ! git config --local core.hooksPath .githooks; then
            echo "Failed to install git hooks." >&2
            exit 1
        fi
        echo "Git hooks: .githooks (pre-commit lints and pre-push tests what changed)"
    else
        echo "Skipping git hooks install (not inside a git worktree)."
    fi
    if [ ! -f config.yaml ]; then
        echo "Creating config.yaml from config.yaml.example..."
        cp config.yaml.example config.yaml
    else
        echo "config.yaml already exists."
    fi
    if [ ! -f .env ]; then
        echo "Creating template .env file..."
        echo "# Project Chotu Environment Secrets" > .env
        echo "SIGNAL_ACCOUNT=" >> .env
        echo "SIGNAL_CLI_DATA_DIR=" >> .env
        echo "SIGNAL_CLI_SOCKET=" >> .env
        echo "SIGNAL_GROUP_ID=" >> .env
        echo "GEMINI_API_KEY=" >> .env
        echo "" >> .env
        echo "# Ollama Configuration" >> .env
        echo "OLLAMA_HOST=http://localhost" >> .env
        echo "OLLAMA_PORT=11434" >> .env
        echo "OLLAMA_MODEL=qwen3.5:4b" >> .env
        echo "OLLAMA_DECISION_MODEL=tev1:0.8b" >> .env
        echo "" >> .env
        echo "# App Configuration" >> .env
        echo "CHOTU_CONFIG_PATH=config.yaml" >> .env
        echo "CHOTU_BRAIN_DIR=~/chotu_brain" >> .env
        echo "DATABASE_PATH=chotu.db" >> .env
        echo "" >> .env
        echo "# Android release signing (just app-keystore, just app-apk; see docs/app.md)" >> .env
        echo "CHOTU_ANDROID_KEYSTORE_PATH=" >> .env
        echo "CHOTU_ANDROID_KEYSTORE_PASSWORD=" >> .env
        echo "CHOTU_ANDROID_KEY_ALIAS=chotu" >> .env
        echo "CHOTU_ANDROID_KEY_PASSWORD=" >> .env
        echo "Please fill in your API keys in the .env file."
    else
        echo ".env file already exists."
    fi
    missing_runtime_helper=false
    for command in nc plutil; do
        if ! command -v "$command" >/dev/null 2>&1; then
            echo "Missing runtime prerequisite: $command (required by just run)." >&2
            missing_runtime_helper=true
        fi
    done
    if [ "$missing_runtime_helper" = true ]; then
        echo "nc and plutil ship with macOS; restore them with a macOS update or reinstall, then rerun just setup." >&2
        exit 1
    fi
    plutil_probe='{"jsonrpc":"2.0","id":1,"result":[]}'
    plutil_probe_jsonrpc="$(printf '%s\n' "$plutil_probe" \
        | plutil -extract jsonrpc xml1 -o - - 2>/dev/null || true)"
    plutil_probe_id="$(printf '%s\n' "$plutil_probe" \
        | plutil -extract id xml1 -o - - 2>/dev/null || true)"
    plutil_probe_result="$(printf '%s\n' "$plutil_probe" \
        | plutil -extract result xml1 -o - - 2>/dev/null || true)"
    plist_root=$'<plist version="1.0">\n'
    if [[ "$plutil_probe_jsonrpc" != *"$plist_root<string>2.0</string>"* ]] \
        || [[ "$plutil_probe_id" != *"$plist_root<integer>1</integer>"* ]] \
        || [[ "$plutil_probe_result" != *"$plist_root<array/>"* ]]; then
        echo "Installed plutil lacks the JSON support required by just run." >&2
        echo "Update macOS, then rerun just setup." >&2
        exit 1
    fi

# Pull required local Ollama models
prereqs:
    @echo "Pulling Ollama models..."
    ollama pull llama3.2:3b
    ollama pull deepseek-r1:8b
    ollama pull qwen3.5:4b
    ollama pull tev1:0.8b

# Run signal-cli when needed, then start the supervisor coordinator
run: setup
    #!/usr/bin/env bash
    set -e

    if [ -z "$SIGNAL_CLI_SOCKET" ] || [ -z "$GEMINI_API_KEY" ]; then
        echo "WARNING: SIGNAL_CLI_SOCKET and GEMINI_API_KEY must be configured in your environment or .env file."
        echo "Please edit the .env file and add your credentials first."
        exit 1
    fi
    for command in nc plutil; do
        if ! command -v "$command" >/dev/null 2>&1; then
            echo "just run requires $command to probe SIGNAL_CLI_SOCKET." >&2
            echo "$command ships with macOS; restore it with a macOS update or reinstall, then retry." >&2
            exit 1
        fi
    done

    # Keep the Mac awake for the Signal websocket while Chotu runs.
    # Display may still sleep (-d intentionally omitted). No-op if caffeinate is absent.
    if [ -z "${CHOTU_CAFFEINATE:-}" ] && command -v caffeinate >/dev/null 2>&1; then
        export CHOTU_CAFFEINATE=1
        echo "Preventing idle/system sleep for this session (caffeinate -ims); display may still sleep."
        exec caffeinate -ims -- "$0"
    fi
    signal_cli_pid=""
    run_lock="${SIGNAL_CLI_SOCKET}.run.lock"
    lock_held=false
    lock_owner() {
        if [ -d "$run_lock" ] && [ ! -L "$run_lock" ]; then
            cat "$run_lock/pid" 2>/dev/null || true
        fi
    }
    cleanup() {
        if [ -n "$signal_cli_pid" ]; then
            kill "$signal_cli_pid" 2>/dev/null || true
            wait "$signal_cli_pid" 2>/dev/null || true
        fi
        if [ "$lock_held" = true ] && [ "$(lock_owner)" = "$$" ]; then
            rm -f "$run_lock/pid"
            rmdir "$run_lock" 2>/dev/null || true
        fi
    }
    socket_ready() {
        [ -S "$SIGNAL_CLI_SOCKET" ] || return 1
        local response jsonrpc_xml response_id_xml result_xml plist_root
        response="$(printf '%s\n' '{"jsonrpc":"2.0","method":"getUserStatus","params":{},"id":1}' \
            | nc -U -w 1 "$SIGNAL_CLI_SOCKET" 2>/dev/null || true)"
        [ -n "$response" ] || return 1
        jsonrpc_xml="$(printf '%s\n' "$response" \
            | plutil -extract jsonrpc xml1 -o - - 2>/dev/null || true)"
        response_id_xml="$(printf '%s\n' "$response" \
            | plutil -extract id xml1 -o - - 2>/dev/null || true)"
        result_xml="$(printf '%s\n' "$response" \
            | plutil -extract result xml1 -o - - 2>/dev/null || true)"
        plist_root=$'<plist version="1.0">\n'
        [[ "$jsonrpc_xml" == *"$plist_root<string>2.0</string>"* ]] \
            && [[ "$response_id_xml" == *"$plist_root<integer>1</integer>"* ]] \
            && { [[ "$result_xml" == *"$plist_root<array/>"* ]] \
                || [[ "$result_xml" == *"$plist_root<array>"* ]]; }
    }
    acquire_run_lock() {
        local lock_pid=""
        if mkdir "$run_lock" 2>/dev/null; then
            if ! printf '%s\n' "$$" > "$run_lock/pid"; then
                rm -f "$run_lock/pid"
                rmdir "$run_lock" 2>/dev/null || true
                echo "Cannot write run lock owner: $run_lock/pid" >&2
                exit 1
            fi
            lock_held=true
            return
        fi
        if [ -L "$run_lock" ] || { [ -e "$run_lock" ] && [ ! -d "$run_lock" ]; }; then
            echo "Cannot use run lock: $run_lock" >&2
            echo "Remove it if no just run process is active, then retry." >&2
            exit 1
        fi
        if [ ! -e "$run_lock" ]; then
            echo "Cannot create run lock: $run_lock" >&2
            echo "Ensure its parent directory exists and is writable, then retry." >&2
            exit 1
        fi
        for _ in 1 2 3 4; do
            lock_pid="$(lock_owner)"
            [ -n "$lock_pid" ] && break
            sleep 0.1
        done
        case "$lock_pid" in
            '')
                echo "Run lock has no owner PID: $run_lock" >&2
                echo "Remove it if no just run process is active, then retry." >&2
                exit 1
                ;;
            *[!0-9]*)
                echo "Cannot read the owner PID from run lock: $run_lock" >&2
                echo "Remove it if no just run process is active, then retry." >&2
                exit 1
                ;;
        esac
        if kill -0 "$lock_pid" 2>/dev/null; then
            echo "Another just run process is already using $SIGNAL_CLI_SOCKET"
            exit 1
        fi
        echo "Stale run lock: $run_lock (owner PID $lock_pid is not running)." >&2
        echo "Remove the lock directory, then retry." >&2
        exit 1
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    acquire_run_lock
    if ! socket_ready; then
        if [ -e "$SIGNAL_CLI_SOCKET" ] && [ ! -S "$SIGNAL_CLI_SOCKET" ]; then
            echo "SIGNAL_CLI_SOCKET exists but is not a Unix socket: $SIGNAL_CLI_SOCKET"
            exit 1
        fi
        if [ -S "$SIGNAL_CLI_SOCKET" ]; then
            echo "Existing signal-cli socket did not pass its health check: $SIGNAL_CLI_SOCKET" >&2
            echo "Leaving the socket intact because its daemon ownership is unknown." >&2
            echo "Check the external daemon and retry; remove the socket only after confirming no daemon is running." >&2
            exit 1
        fi
        if [ -z "$SIGNAL_CLI_DATA_DIR" ] || [ -z "$SIGNAL_ACCOUNT" ]; then
            echo "SIGNAL_CLI_DATA_DIR and SIGNAL_ACCOUNT are required to start signal-cli."
            exit 1
        fi
        if ! command -v signal-cli >/dev/null 2>&1; then
            echo "signal-cli is not installed. Install it with: brew install signal-cli"
            exit 1
        fi

        echo "Starting signal-cli daemon on $SIGNAL_CLI_SOCKET..."
        signal-cli --data-dir "$SIGNAL_CLI_DATA_DIR" --account "$SIGNAL_ACCOUNT" daemon \
            --receive-mode=manual --socket "$SIGNAL_CLI_SOCKET" &
        signal_cli_pid=$!

        for _ in {1..100}; do
            socket_ready && break
            if ! kill -0 "$signal_cli_pid" 2>/dev/null; then
                signal_cli_status=0
                wait "$signal_cli_pid" || signal_cli_status=$?
                signal_cli_pid=""
                echo "signal-cli exited before becoming ready (status $signal_cli_status)." >&2
                exit 1
            fi
            sleep 0.1
        done

        if ! socket_ready; then
            echo "signal-cli did not become ready on: $SIGNAL_CLI_SOCKET"
            exit 1
        fi
    fi

    cargo run -p coordinator

# Build the full workspace
build:
    cargo build --workspace

# Lint Markdown with the same markdownlint-cli2 version used by CI.
markdownlint:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! command -v npx >/dev/null 2>&1; then
        echo "markdownlint: npx is required (install Node.js)" >&2
        exit 1
    fi
    npx --yes markdownlint-cli2@0.23.2 "*.md" "docs/**/*.md" "evals/**/*.md" "!evals/research/results/**"

# Markdown, format, and clippy checks.
lint: markdownlint rust-lint

# Rust format and clippy checks. Used by pre-commit when Rust files change.
rust-lint:
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --locked

# Run Signal startup and workspace tests (matches CI).
test: signal-test rust-test

# Signal daemon startup tests. Used by pre-push when tests/ or the justfile change.
signal-test:
    python3 -m unittest discover -s tests -p 'test_*.py'

# Workspace tests. Used by pre-push when Rust files change.
rust-test:
    cargo test --workspace --locked --all-targets

# Lint the Expo app: oxlint (type-aware, warnings fail), oxfmt --check, tsc --noEmit
[working-directory: 'app']
app-lint: _app-deps
    npm run --silent lint

# Format the Expo app with oxfmt
[working-directory: 'app']
app-fmt: _app-deps
    npm run --silent fmt

# Run the Expo app's Jest tests
[working-directory: 'app']
app-test: _app-deps
    npm test --silent

# Build the signed release APK (keystore and passwords come from .env; see docs/app.md)
app-apk: _app-deps _app-signing-env
    #!/usr/bin/env bash
    set -euo pipefail
    export CHOTU_ANDROID_KEYSTORE_PATH="$({{just_executable()}} --quiet _app-keystore-path)"
    if [ ! -f "$CHOTU_ANDROID_KEYSTORE_PATH" ]; then
        echo "app-apk: keystore not found: $CHOTU_ANDROID_KEYSTORE_PATH" >&2
        echo "Restore it from your backup, or create the first one with: just app-keystore" >&2
        exit 1
    fi
    if [ -z "${ANDROID_HOME:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
        export ANDROID_HOME="$HOME/Library/Android/sdk"
    fi
    if [ -z "${ANDROID_HOME:-}" ]; then
        echo "app-apk: set ANDROID_HOME to your Android SDK (Android Studio installs it in ~/Library/Android/sdk)." >&2
        exit 1
    fi
    cd app
    # android/ is generated (CNG); regenerate it so it always matches app.config.ts.
    CI=1 npx expo prebuild --platform android --clean --no-install
    (cd android && ./gradlew assembleRelease)
    apk="$PWD/android/app/build/outputs/apk/release/app-release.apk"
    if [ ! -f "$apk" ]; then
        echo "app-apk: gradle finished but $apk is missing." >&2
        exit 1
    fi
    apksigner="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -n 1 || true)"
    if [ -n "$apksigner" ]; then
        certs="$("$apksigner" verify --print-certs "$apk")"
        printf '%s\n' "$certs" | grep -E 'certificate (DN|SHA-256)' || true
    fi
    echo "APK: $apk"
    echo "Install: adb install -r \"$apk\""

# Create the one-time release keystore at CHOTU_ANDROID_KEYSTORE_PATH (refuses to overwrite)
app-keystore: _app-signing-env
    #!/usr/bin/env bash
    set -euo pipefail
    keystore="$({{just_executable()}} --quiet _app-keystore-path)"
    if [ -e "$keystore" ]; then
        echo "app-keystore: $keystore already exists; refusing to overwrite it." >&2
        echo "Every update must be signed with the same key. Back it up instead (docs/app.md)." >&2
        exit 1
    fi
    if [ "$CHOTU_ANDROID_KEY_PASSWORD" != "$CHOTU_ANDROID_KEYSTORE_PASSWORD" ]; then
        echo "app-keystore: a PKCS12 keystore uses one password; set CHOTU_ANDROID_KEY_PASSWORD to CHOTU_ANDROID_KEYSTORE_PASSWORD." >&2
        exit 1
    fi
    if ! command -v keytool >/dev/null 2>&1; then
        echo "app-keystore: keytool is missing; install a JDK (17 or newer)." >&2
        exit 1
    fi
    mkdir -p "$(dirname "$keystore")"
    keytool -genkeypair -storetype PKCS12 -keystore "$keystore" \
        -alias "$CHOTU_ANDROID_KEY_ALIAS" -keyalg RSA -keysize 4096 -validity 10000 \
        -dname "CN=Chotu" \
        -storepass:env CHOTU_ANDROID_KEYSTORE_PASSWORD -keypass:env CHOTU_ANDROID_KEY_PASSWORD
    chmod 600 "$keystore"
    echo "Created $keystore. Back it up now (docs/app.md): losing it means no more updates."

# Fail unless the four Android signing variables are set
_app-signing-env:
    #!/usr/bin/env bash
    missing=()
    for name in CHOTU_ANDROID_KEYSTORE_PATH CHOTU_ANDROID_KEYSTORE_PASSWORD CHOTU_ANDROID_KEY_ALIAS CHOTU_ANDROID_KEY_PASSWORD; do
        if [ -z "${!name:-}" ]; then
            missing+=("$name")
        fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        echo "Android signing is not configured. Set in .env: ${missing[*]}" >&2
        echo "See docs/app.md (Signing key)." >&2
        exit 1
    fi

# Print CHOTU_ANDROID_KEYSTORE_PATH as an absolute path (~ expanded, relative to the repo root)
_app-keystore-path:
    #!/usr/bin/env bash
    set -euo pipefail
    path="$CHOTU_ANDROID_KEYSTORE_PATH"
    case "$path" in
        "~") path="$HOME" ;;
        "~/"*) path="$HOME/${path#"~/"}" ;;
        /*) ;;
        *) path="{{justfile_directory()}}/$path" ;;
    esac
    printf '%s\n' "$path"

[working-directory: 'app']
_app-deps:
    #!/usr/bin/env bash
    if [ ! -d node_modules ]; then
        echo "app/node_modules is missing. Install with: (cd app && npm ci)" >&2
        exit 1
    fi

# Point this clone at .githooks/ (pre-commit lints, pre-push tests what changed)
hooks:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "just hooks: not inside a git worktree; cannot install hooks." >&2
        exit 1
    fi
    git config --local core.hooksPath .githooks
    echo "Installed git hooks from .githooks (pre-commit lints and pre-push tests what changed)"

# Example: just backfill-health --from 2026-10-01 --member praj --apply
# Rebuild past daily health summaries from Google Health (dry run unless --apply)
backfill-health *args:
    cargo run -q -p health-coach --bin backfill-health-summary -- {{args}}

# Example: just api-token alex_phone
# Mint an app API token for a device: prints the token once and its hashed .env line
api-token device:
    cargo run -q -p coordinator --bin api-token -- {{device}}

# Clean cargo build artifacts
clean:
    cargo clean
