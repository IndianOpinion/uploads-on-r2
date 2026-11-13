#!/usr/bin/env bats
# T64: the companion sync script, against a fake rclone that records its arguments.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/sync-uploads.sh"
  WORK="$BATS_TEST_TMPDIR"
  mkdir -p "$WORK/uploads/2026/01"
  LOG="$WORK/rclone.log"
  FAKE="$WORK/rclone"
  cat >"$FAKE" <<'FAKE_RCLONE'
#!/usr/bin/env bash
if [[ "$1" == "version" ]]; then
  echo "rclone v${FAKE_VERSION:-1.68.2}"
  exit 0
fi
printf '%s\n' "$*" >>"$FAKE_LOG"
exit "${FAKE_EXIT:-0}"
FAKE_RCLONE
  chmod +x "$FAKE"
  export FAKE_LOG="$LOG"
}

run_sync() {
  run "$SCRIPT" --source "$WORK/uploads" --remote r2:your-bucket --rclone "$FAKE" "$@"
}

@test "dry run copies media only, excludes private folders, never deletes" {
  run_sync --dry-run
  [ "$status" -eq 0 ]
  [ "$(wc -l <"$LOG")" -eq 11 ] # one copy pass per media extension
  grep -q -- '--dry-run' "$LOG"
  if grep -qE '(^| )sync( |$)|--delete|--max-delete|(^| )move( |$)' "$LOG"; then false; fi
  while read -r line; do
    [[ "$line" == copy\ * ]]
    [[ "$line" == *"--ignore-case"* ]]
    [[ "$line" == *"- /wp-personal-data-exports/**"* ]]
    [[ "$line" == *"- /sites/*/wc-logs/**"* ]]
    [[ "$line" == *"- /woocommerce_uploads/**"* ]]
    [[ "$line" == *"- /wpcf7_uploads/**"* ]]
    [[ "$line" == *"--filter - *" || "$line" == *"--filter - * --header-upload"* ]]
  done <"$LOG"
  grep -q -- '+ \*.jpg --filter - \* --header-upload Content-Type: image/jpeg' "$LOG"
  grep -q -- '+ \*.svg --filter - \* --header-upload Content-Type: image/svg+xml' "$LOG"
  grep -q -- '+ \*.pdf --filter - \* --header-upload Content-Type: application/pdf' "$LOG"
  if grep -qE '\+ \*\.(php|css|js|zip|log|html)' "$LOG"; then false; fi
  grep -q "r2:your-bucket/wp-content/uploads " "$LOG"
}

@test "exits 2 on an old rclone and copies nothing" {
  FAKE_VERSION=1.60.1 run_sync
  [ "$status" -eq 2 ]
  [[ "$output" == *"older than"* ]]
  [ ! -e "$LOG" ]
}

@test "exits 2 when rclone is missing" {
  run "$SCRIPT" --source "$WORK/uploads" --remote r2:your-bucket --rclone "$WORK/nope"
  [ "$status" -eq 2 ]
}

@test "exits 1 on usage errors" {
  run "$SCRIPT" --remote r2:your-bucket --rclone "$FAKE"
  [ "$status" -eq 1 ]
  run "$SCRIPT" --source "$WORK/missing" --remote r2:your-bucket --rclone "$FAKE"
  [ "$status" -eq 1 ]
  run_sync --bogus
  [ "$status" -eq 1 ]
  run "$SCRIPT" --source "$WORK/uploads" --remote "no-colon" --rclone "$FAKE"
  [ "$status" -eq 1 ]
  run_sync --key-prefix /abs
  [ "$status" -eq 1 ]
  run_sync --max-age "1; rm -rf /"
  [ "$status" -eq 1 ]
}

@test "exits 3 when a copy fails" {
  FAKE_EXIT=1 run_sync
  [ "$status" -eq 3 ]
}

@test "max-age, key prefix, extensions and extra deny prefixes are passed through" {
  run_sync --max-age 2h --key-prefix "" --extensions "JPG,heic" --deny private-stuff --min-version 1.68
  [ "$status" -eq 0 ]
  [ "$(wc -l <"$LOG")" -eq 2 ]
  grep -q -- '--max-age 2h --no-traverse' "$LOG"
  grep -q "copy $WORK/uploads r2:your-bucket " "$LOG"
  grep -q -- '- /private-stuff/\*\*' "$LOG"
  grep -q -- '+ \*.jpg' "$LOG"
  heic_line="$(grep -- '+ \*.heic' "$LOG")"
  [[ "$heic_line" != *"--header-upload"* ]]
}

@test "a source that starts with a dash is never read as an rclone flag" {
  mkdir -p "$WORK/-n"
  cd "$WORK"
  run "$SCRIPT" --source "-n" --remote r2:your-bucket --rclone "$FAKE" --extensions jpg
  [ "$status" -eq 0 ]
  grep -q -- "^copy ./-n r2:your-bucket/wp-content/uploads " "$LOG"
}

@test "help exits 0" {
  run "$SCRIPT" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"Never deletes"* ]]
}
