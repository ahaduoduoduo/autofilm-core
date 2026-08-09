#!/bin/sh

set -eu

PATH="/usr/local/bin:/usr/syno/bin:/usr/syno/sbin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

staging_dir="${RESTIC_STAGING_DIR:-/volume1/docker/backrest/staging}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
request_id="${1:-manual-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
lock_file="$staging_dir/control/export.lock"
new_dir="$staging_dir/.recovery-$request_id"
current_dir="$staging_dir/recovery"
previous_dir="$staging_dir/.recovery-previous"

case "$request_id" in
  *[!A-Za-z0-9._-]*|'')
    printf 'Invalid recovery export request id: %s\n' "$request_id" >&2
    exit 2
    ;;
esac

mkdir -p "$staging_dir/control"
exec 9>"$lock_file"
flock -w 240 9

if [ -e "$new_dir" ]; then
  printf 'Temporary recovery directory already exists: %s\n' "$new_dir" >&2
  exit 3
fi

mkdir -p "$new_dir"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

on_error() {
  printf 'Recovery export failed; temporary data retained at %s\n' "$new_dir" >&2
}
trap on_error HUP INT TERM EXIT

"$script_dir/export-dsm-recovery.sh" "$new_dir/dsm"
"$script_dir/export-docker-recovery.py" "$new_dir/docker"
"$script_dir/export-sqlite-databases.py" "$new_dir/databases"

mkdir -p "$new_dir/backrest"
cp -p "$staging_dir/../config/config.json" "$new_dir/backrest/config.json"

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
(
  cd "$new_dir"
  find . -type f ! -name manifest.sha256 -exec sha256sum {} \; \
    | LC_ALL=C sort >manifest.sha256
)

jq -n \
  --arg schema_version "1" \
  --arg request_id "$request_id" \
  --arg hostname "$(hostname)" \
  --arg started_at "$started_at" \
  --arg finished_at "$finished_at" \
  '{
    schema_version: ($schema_version | tonumber),
    request_id: $request_id,
    hostname: $hostname,
    started_at: $started_at,
    finished_at: $finished_at,
    directories: {
      dsm: "DSM configuration and AI-readable reconstruction facts",
      docker: "Docker runtime inventory and generated recovery Compose files",
      databases: "transaction-consistent SQLite copies",
      backrest: "Backrest repository and plan configuration"
    }
  }' >"$new_dir/manifest.json"

if [ -e "$previous_dir" ]; then
  case "$previous_dir" in
    "$staging_dir"/.recovery-previous)
      find -P "$previous_dir" -depth -delete
      ;;
    *)
      printf 'Refusing to remove unexpected path: %s\n' "$previous_dir" >&2
      exit 4
      ;;
  esac
fi

if [ -e "$current_dir" ]; then
  mv "$current_dir" "$previous_dir"
fi
mv "$new_dir" "$current_dir"

for legacy_file in \
  "$staging_dir/docker-containers.txt" \
  "$staging_dir/dsm-config.dss" \
  "$staging_dir/dsm-packages.txt"; do
  if [ -f "$legacy_file" ]; then
    rm "$legacy_file"
  fi
done
if [ -d "$staging_dir/openlist" ]; then
  find -P "$staging_dir/openlist" -depth -delete
fi
if [ -d "$previous_dir" ]; then
  find -P "$previous_dir" -depth -delete
fi

chmod -R go-rwx "$current_dir"
trap - HUP INT TERM EXIT
printf 'Recovery export completed: %s\n' "$current_dir"
