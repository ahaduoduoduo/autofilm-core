#!/bin/sh

set -eu

staging_dir="${RESTIC_STAGING_DIR:-/staging}"
timeout_seconds="${RESTIC_STAGING_TIMEOUT_SECONDS:-300}"
request_id="backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
request_dir="$staging_dir/control/requests"
result_dir="$staging_dir/control/results"
request_file="$request_dir/$request_id.request"

mkdir -p "$request_dir" "$result_dir"
printf '%s\n' "$request_id" >"$request_file.tmp"
mv "$request_file.tmp" "$request_file"

elapsed=0
while [ "$elapsed" -lt "$timeout_seconds" ]; do
  if [ -f "$result_dir/$request_id.ok" ]; then
    printf 'Recovery material refreshed for %s\n' "$request_id"
    exit 0
  fi
  if [ -f "$result_dir/$request_id.failed" ]; then
    cat "$result_dir/$request_id.failed" >&2
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

printf 'Timed out waiting for DSM recovery export: %s\n' "$request_id" >&2
exit 1
