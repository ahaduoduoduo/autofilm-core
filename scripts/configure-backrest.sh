#!/usr/bin/env bash

set -euo pipefail

compose_dir="/volume1/docker/autofilm-suite/autofilm-core"
backrest_url="http://127.0.0.1:${BACKREST_PORT:-9898}"

set -a
# shellcheck disable=SC1091
. "$compose_dir/.env"
set +a

: "${AUTOFILM_MASTER_KEY:?AUTOFILM_MASTER_KEY is required}"
: "${AUTOFILM_ADMIN_PASSWORD:?AUTOFILM_ADMIN_PASSWORD is required}"

ui_username="${AUTOFILM_ADMIN_USERNAME:-admin}"
if [[ ! "$ui_username" =~ ^[A-Za-z0-9_-]+$ ]]; then
  ui_username="admin"
fi

restic_exec=(
  docker compose
  -f "$compose_dir/compose.full.yaml"
  exec -T
  -e RESTIC_REPOSITORY=rest:http://openlist:5244/restic/synology/
  -e RESTIC_PASSWORD="$AUTOFILM_MASTER_KEY"
  -e RESTIC_REST_USERNAME=backrest
  -e RESTIC_REST_PASSWORD="$AUTOFILM_MASTER_KEY"
  backrest
  /bin/restic
)

if ! repository_config="$("${restic_exec[@]}" cat config --json 2>/dev/null)"; then
  "${restic_exec[@]}" init >/dev/null
  repository_config="$("${restic_exec[@]}" cat config --json)"
fi
repository_guid="$(printf '%s' "$repository_config" | jq -er '.id')"

hash_response="$({
  jq -n --arg value "$AUTOFILM_ADMIN_PASSWORD" '{value: $value}'
} | curl -fsS \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "$backrest_url/v1.Authentication/HashPassword")"
password_hash="$(printf '%s' "$hash_response" | jq -er '.value')"

if current_config="$(curl -fsS \
  -H 'Content-Type: application/json' \
  --data-binary '{}' \
  "$backrest_url/v1.Backrest/GetConfig" 2>/dev/null)"; then
  auth_args=()
else
  current_config="$(curl -fsS \
    -u "$ui_username:$AUTOFILM_ADMIN_PASSWORD" \
    -H 'Content-Type: application/json' \
    --data-binary '{}' \
    "$backrest_url/v1.Backrest/GetConfig")"
  auth_args=(-u "$ui_username:$AUTOFILM_ADMIN_PASSWORD")
fi

snapshot_hook="/recovery-scripts/request-restic-staging.sh"

configured="$(printf '%s' "$current_config" | jq \
  --arg restic_password "$AUTOFILM_MASTER_KEY" \
  --arg repository_guid "$repository_guid" \
  --arg ui_username "$ui_username" \
  --arg password_hash "$password_hash" \
  --arg snapshot_hook "$snapshot_hook" '
  .instance = "Synology-115-Offsite" |
  .repos = [
    {
      id: "115-offsite",
      guid: $repository_guid,
      uri: "rest:http://openlist:5244/restic/synology/",
      password: $restic_password,
      env: [
        "RESTIC_REST_USERNAME=backrest",
        ("RESTIC_REST_PASSWORD=" + $restic_password)
      ],
      flags: [],
      prunePolicy: {schedule: {disabled: true}},
      checkPolicy: {
        schedule: {cron: "0 6 * * 0"},
        structureOnly: true
      },
      hooks: [],
      autoUnlock: true,
      autoInitialize: false,
      shared: false
    }
  ] |
  .plans = [
    {
      id: "nas-config",
      repo: "115-offsite",
      paths: [
        "/source/docker",
        "/source/docker-volumes/telegram-data",
        "/source/dsm-packages",
        "/source/home-assistant",
        "/source/web-live",
        "/source/web-autoaccount",
        "/source/dsm-certificates",
        "/staging"
      ],
      excludes: [
        "**/@eaDir/**",
        "**/.DS_Store",
        "**/.cache/**",
        "**/.git/**",
        "**/.next/**",
        "**/.pytest_cache/**",
        "**/.ruff_cache/**",
        "**/__pycache__/**",
        "**/cache/**",
        "**/logs/**",
        "**/node_modules/**",
        "**/temp/**",
        "**/tmp/**",
        "**/*.log",
        "**/*.log.*",
        "/source/docker/SYNC/**",
        "/source/docker/SYNC_BIU/**",
        "/source/docker/autofilm-suite/autofilm-core/data/backrest/**",
        "/source/docker/alist/data.db*",
        "/source/docker/autofilm-suite/autofilm-core/data/autofilm.sqlite*",
        "/source/docker/jellyfin/config/data/*.db*",
        "/source/docker/subhub/data/subhub.db*",
        "/source/docker/localproxy-data/localproxy.db*",
        "/source/docker/nas-gateway-manager/data/manager.db*",
        "/source/web-autoaccount/automation.db*",
        "/source/dsm-packages/appconf/Virtualization/ccc/etcd.data/**",
        "/staging/control/**",
        "/source/home-assistant/home-assistant_v2.db*"
      ],
      schedule: {cron: "0 5 * * *"},
      retention: {
        policyTimeBucketed: {
          daily: 14,
          weekly: 8,
          monthly: 12,
          yearly: 3,
          keepLastN: 3
        }
      },
      hooks: [
        {
          conditions: ["CONDITION_SNAPSHOT_START"],
          onError: "ON_ERROR_FATAL",
          actionCommand: {command: $snapshot_hook}
        }
      ],
      skipIfUnchanged: true
    },
    {
      id: "time-machine",
      repo: "115-offsite",
      paths: ["/source/time-machine"],
      excludes: ["**/@eaDir/**", "**/.DS_Store"],
      schedule: {disabled: true},
      retention: {policyKeepLastN: 2},
      hooks: [],
      skipIfUnchanged: true
    }
  ] |
  .auth = {
    disabled: false,
    users: [{name: $ui_username, passwordBcrypt: $password_hash}]
  }
')"

set_response="$(printf '%s' "$configured" | curl -sS \
  "${auth_args[@]}" \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  -w $'\n%{http_code}' \
  "$backrest_url/v1.Backrest/SetConfig")"
set_status="${set_response##*$'\n'}"
set_body="${set_response%$'\n'*}"
if [[ "$set_status" != 2* ]]; then
  set_message="$(printf '%s' "$set_body" | jq -r '.message // .code // "unknown error"')"
  printf 'Backrest configuration failed: HTTP %s: %s\n' "$set_status" "$set_message" >&2
  exit 1
fi

printf 'Backrest configured: %s, plans: nas-config, time-machine\n' "$ui_username"
