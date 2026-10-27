# Sourced by the hooks. Reads changed paths on stdin and prints the check
# groups they touch, one per line: markdown, rust, signal, app.
change_groups() {
  awk '
    /\.md$/ { md = 1 }
    /\.(rs|sql)$|(^|\/)Cargo\.(toml|lock)$|(^|\/)rust-toolchain(\.toml)?$|^\.cargo\// { rust = 1 }
    /^prompts\// { rust = 1 }
    /^app\/src\/api\/fixtures\// { rust = 1 }
    /^tests\/|^justfile$/ { signal = 1 }
    /^app\// { app = 1 }
    END {
      if (md) print "markdown"
      if (rust) print "rust"
      if (signal) print "signal"
      if (app) print "app"
    }
  '
}

require_just() {
  if ! command -v just >/dev/null 2>&1; then
    echo "$1: just is required (https://github.com/casey/just)" >&2
    exit 1
  fi
}
