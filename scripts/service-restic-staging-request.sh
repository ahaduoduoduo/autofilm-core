#!/bin/sh

set -eu

PATH="/usr/local/bin:/usr/syno/bin:/usr/syno/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

staging_dir="${RESTIC_STAGING_DIR:-/volume1/docker/backrest/staging}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
request_dir="$staging_dir/control/requests"
result_dir="$staging_dir/control/results"

mkdir -p "$request_dir" "$result_dir"

for request_file in "$request_dir"/*.request; do
  [ -f "$request_file" ] || continue
  request_name="$(basename "$request_file")"
  request_id="${request_name%.request}"

  case "$request_id" in
    *[!A-Za-z0-9._-]*|'')
      printf '%s\tinvalid request id\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        >"$result_dir/$request_id.failed"
      mv "$request_file" "$request_file.invalid"
      continue
      ;;
  esac

  if "$script_dir/prepare-restic-staging.sh" "$request_id" \
    >"$staging_dir/control/last-export.log" 2>&1; then
    printf '%s\tok\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >"$result_dir/$request_id.ok.tmp"
    mv "$result_dir/$request_id.ok.tmp" "$result_dir/$request_id.ok"
  else
    {
      printf '%s\tfailed\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      tail -n 80 "$staging_dir/control/last-export.log"
    } >"$result_dir/$request_id.failed.tmp"
    mv "$result_dir/$request_id.failed.tmp" "$result_dir/$request_id.failed"
  fi

  mv "$request_file" "$request_file.processed"
done
