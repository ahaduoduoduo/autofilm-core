#!/bin/sh

set -eu

staging_dir="/volume1/docker/autofilm-suite/autofilm-core/data/backrest/staging"
openlist_dir="/volume1/docker/alist"

mkdir -p "$staging_dir/openlist"

/usr/syno/bin/synoconfbkp export --filepath="$staging_dir/dsm-config.dss"
/usr/syno/bin/synopkg list >"$staging_dir/dsm-packages.txt"
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' \
  >"$staging_dir/docker-containers.txt"
sqlite3 "$openlist_dir/data.db" \
  ".backup '$staging_dir/openlist/data.db'"
cp -p "$openlist_dir/config.json" "$staging_dir/openlist/config.json"

chmod 600 "$staging_dir/dsm-config.dss" \
  "$staging_dir/dsm-packages.txt" \
  "$staging_dir/docker-containers.txt" \
  "$staging_dir/openlist/data.db" \
  "$staging_dir/openlist/config.json"
