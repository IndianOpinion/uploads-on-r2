#!/usr/bin/env bash
# check-source.sh: show which path served each URL (r2, edge-cache, origin,
# negative-cache, deny), by reading the Worker's diagnostic header.
#
# Usage: examples/check-source.sh https://example.com/wp-content/uploads/2026/01/a.jpg [...]
# Set SOURCE_HEADER if you renamed the header.

set -euo pipefail

header="${SOURCE_HEADER:-x-uploads-source}"

if (($# == 0)); then
  echo "usage: $0 <url> [<url> ...]" >&2
  exit 1
fi

for url in "$@"; do
  # Two requests: the second shows whether the first warmed the edge cache.
  for attempt in 1 2; do
    line="$(curl -sS -o /dev/null -D - "$url" | tr -d '\r' | awk -v h="$header" '
      tolower($0) ~ "^http/" { status = $2 }
      tolower($0) ~ "^" tolower(h) ":" { source = $2 }
      END { printf "%s %s", status, (source == "" ? "(no source header: passed)" : source) }')"
    printf '%s  try %d  %s\n' "$url" "$attempt" "$line"
  done
done
