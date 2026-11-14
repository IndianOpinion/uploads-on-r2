#!/usr/bin/env bash
# sync-uploads.sh: copy WordPress media from the origin's uploads folder
# into an R2 bucket through rclone, so the uploads-on-r2 Worker can serve it.
#
# It copies and never deletes. It copies only media extensions, and never
# the private WordPress folders the Worker denies. It sets the content type
# by extension. Credentials stay in rclone's own config; this script reads
# none.
#
# Exit codes: 0 success, 1 usage error, 2 rclone missing or too old,
# 3 copy failed.

set -euo pipefail

readonly DEFAULT_EXTENSIONS="jpg,jpeg,png,gif,webp,avif,svg,mp4,webm,mp3,pdf"
readonly DEFAULT_MIN_VERSION="1.63.0"
readonly BUILT_IN_DENY="wp-personal-data-exports wc-logs woocommerce_uploads wpcf7_uploads"

usage() {
  cat <<'USAGE'
Usage: sync-uploads.sh --source <dir> --remote <rclone-remote>:<bucket> [options]

Copies media files from <dir> to the bucket. Never deletes.

Options:
  --source <dir>          The uploads directory, for example /var/www/site/wp-content/uploads
  --remote <remote:bucket> The rclone remote and bucket, for example r2:your-bucket
  --key-prefix <prefix>   Key prefix inside the bucket (default: wp-content/uploads/; may be empty)
  --max-age <duration>    Only files changed within this window, for example 2h (rclone syntax)
  --dry-run               Show what would be copied; copy nothing
  --rclone <path>         The rclone binary (default: rclone on PATH)
  --min-version <x.y.z>   Refuse an older rclone (default: 1.63.0)
  --extensions <list>     Comma-separated media extensions (default: the Worker's list)
  --deny <prefix>         An extra private folder to skip; repeatable
  -h, --help              Show this help

Exit codes: 0 success, 1 usage error, 2 rclone missing or too old, 3 copy failed.
USAGE
}

die_usage() {
  printf 'sync-uploads: %s\n' "$1" >&2
  printf 'Run with --help for usage.\n' >&2
  exit 1
}

# version_ge A B: true when version A >= version B (numeric x.y.z).
version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2)
  local i
  for i in 0 1 2; do
    local x="${a[i]:-0}" y="${b[i]:-0}"
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}

content_type_for() {
  case "$1" in
    jpg | jpeg) printf 'image/jpeg' ;;
    png) printf 'image/png' ;;
    gif) printf 'image/gif' ;;
    webp) printf 'image/webp' ;;
    avif) printf 'image/avif' ;;
    svg) printf 'image/svg+xml' ;;
    mp4) printf 'video/mp4' ;;
    webm) printf 'video/webm' ;;
    mp3) printf 'audio/mpeg' ;;
    pdf) printf 'application/pdf' ;;
    *) printf '' ;;
  esac
}

main() {
  local source="" remote="" key_prefix="wp-content/uploads/" max_age="" dry_run=0
  local rclone="rclone" min_version="$DEFAULT_MIN_VERSION" extensions="$DEFAULT_EXTENSIONS"
  local -a extra_deny=()

  while (($# > 0)); do
    case "$1" in
      --source) (($# >= 2)) || die_usage "--source needs a value"; source="$2"; shift 2 ;;
      --remote) (($# >= 2)) || die_usage "--remote needs a value"; remote="$2"; shift 2 ;;
      --key-prefix) (($# >= 2)) || die_usage "--key-prefix needs a value"; key_prefix="$2"; shift 2 ;;
      --max-age) (($# >= 2)) || die_usage "--max-age needs a value"; max_age="$2"; shift 2 ;;
      --rclone) (($# >= 2)) || die_usage "--rclone needs a value"; rclone="$2"; shift 2 ;;
      --min-version) (($# >= 2)) || die_usage "--min-version needs a value"; min_version="$2"; shift 2 ;;
      --extensions) (($# >= 2)) || die_usage "--extensions needs a value"; extensions="$2"; shift 2 ;;
      --deny) (($# >= 2)) || die_usage "--deny needs a value"; extra_deny+=("$2"); shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die_usage "unknown argument: $1" ;;
    esac
  done

  [[ -n "$source" ]] || die_usage "--source is required"
  [[ -d "$source" ]] || die_usage "--source is not a directory: $source"
  [[ "$remote" =~ ^[A-Za-z0-9_.-]+:[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || die_usage "--remote must look like name:bucket"
  [[ "$key_prefix" != /* && "$key_prefix" != *..* ]] || die_usage "--key-prefix must not start with / or contain .."
  [[ "$min_version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || die_usage "--min-version must look like 1.63.0"
  if [[ -n "$max_age" && ! "$max_age" =~ ^[0-9]+(ms|s|m|h|d|w|M|y)?$ ]]; then
    die_usage "--max-age must be an rclone duration such as 90m or 2h"
  fi

  local -a exts=()
  local ext
  IFS=',' read -r -a exts <<<"$extensions"
  ((${#exts[@]} > 0)) || die_usage "--extensions is empty"
  for ext in "${exts[@]}"; do
    [[ "$ext" =~ ^[A-Za-z0-9]{1,16}$ ]] || die_usage "bad extension: $ext"
  done

  local deny
  for deny in "${extra_deny[@]+"${extra_deny[@]}"}"; do
    [[ "$deny" =~ ^[A-Za-z0-9_./-]+$ && "$deny" != *..* ]] || die_usage "bad --deny prefix: $deny"
  done

  # rclone present and recent enough.
  if ! command -v "$rclone" >/dev/null 2>&1; then
    printf 'sync-uploads: rclone not found: %s\n' "$rclone" >&2
    exit 2
  fi
  local version_line version
  version_line="$("$rclone" version 2>/dev/null | head -n 1 || true)"
  if [[ "$version_line" =~ v([0-9]+\.[0-9]+(\.[0-9]+)?) ]]; then
    version="${BASH_REMATCH[1]}"
  else
    printf 'sync-uploads: cannot read the rclone version from: %s\n' "$version_line" >&2
    exit 2
  fi
  if ! version_ge "$version" "$min_version"; then
    printf 'sync-uploads: rclone %s is older than %s; old builds false-fail against R2\n' "$version" "$min_version" >&2
    exit 2
  fi

  # Filters: private folders first (at the root and under multisite
  # sites/<n>/), then the media extensions, then exclude everything else.
  local -a filters=()
  local name
  for name in $BUILT_IN_DENY "${extra_deny[@]+"${extra_deny[@]}"}"; do
    name="${name#/}"
    name="${name%/}"
    filters+=(--filter "- /${name}/**" --filter "- /sites/*/${name}/**")
  done

  # A relative source that starts with '-' would be read by rclone as a flag.
  if [[ "$source" == -* ]]; then
    source="./$source"
  fi

  local destination="$remote"
  if [[ -n "$key_prefix" ]]; then
    destination="${remote}/${key_prefix%/}"
  fi

  local -a common=(copy "$source" "$destination" --ignore-case --stats-one-line)
  if [[ -n "$max_age" ]]; then
    common+=(--max-age "$max_age" --no-traverse)
  fi
  if ((dry_run)); then
    common+=(--dry-run)
  fi

  # One pass per extension, so each file gets an exact content type.
  local failed=0 lower type
  local -a seen=() args=()
  for ext in "${exts[@]}"; do
    lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
    if [[ " ${seen[*]-} " == *" $lower "* ]]; then
      continue
    fi
    seen+=("$lower")
    args=("${common[@]}" "${filters[@]}" --filter "+ *.${lower}" --filter "- *")
    type="$(content_type_for "$lower")"
    if [[ -n "$type" ]]; then
      args+=(--header-upload "Content-Type: ${type}")
    fi
    printf 'sync-uploads: copying *.%s\n' "$lower" >&2
    if ! "$rclone" "${args[@]}"; then
      printf 'sync-uploads: copy failed for *.%s\n' "$lower" >&2
      failed=1
    fi
  done

  if ((failed)); then
    exit 3
  fi
}

main "$@"
