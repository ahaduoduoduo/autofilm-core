#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import json
import pathlib
import sqlite3
import sys


DATABASES = {
    "openlist/data.db": "/volume1/docker/alist/data.db",
    "autofilm/autofilm.sqlite": (
        "/volume1/docker/autofilm-suite/autofilm-core/data/autofilm.sqlite"
    ),
    "subhub/subhub.db": "/volume1/docker/subhub/data/subhub.db",
    "localproxy/localproxy.db": "/volume1/docker/localproxy-data/localproxy.db",
    "nas-gateway-manager/manager.db": (
        "/volume1/docker/nas-gateway-manager/data/manager.db"
    ),
    "autoaccount/automation.db": "/volume1/web/autoaccount/data/automation.db",
    "jellyfin/jellyfin.db": "/volume1/docker/jellyfin/config/data/jellyfin.db",
    "jellyfin/infuse_sync.db": (
        "/volume1/docker/jellyfin/config/data/infuse_sync.db"
    ),
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def backup_database(source: pathlib.Path, target: pathlib.Path) -> dict[str, object]:
    record: dict[str, object] = {
        "source": str(source),
        "target": str(target),
        "started_at": utc_now(),
    }
    if not source.is_file():
        record["status"] = "missing"
        return record
    if source.stat().st_size == 0:
        record["status"] = "empty"
        return record

    target.parent.mkdir(parents=True, exist_ok=True)
    source_uri = f"file:{source}?mode=ro"
    try:
        with sqlite3.connect(source_uri, uri=True, timeout=60) as source_db:
            with sqlite3.connect(target, timeout=60) as target_db:
                source_db.backup(target_db, pages=1024, sleep=0.05)
                result = target_db.execute("PRAGMA quick_check").fetchone()
                if result != ("ok",):
                    raise RuntimeError(f"quick_check returned {result!r}")
        record.update(
            status="ok",
            source_bytes=source.stat().st_size,
            backup_bytes=target.stat().st_size,
        )
    except Exception as exc:  # retain the failure in the encrypted recovery record
        if target.exists():
            target.unlink()
        record.update(status="failed", error=str(exc))
    record["finished_at"] = utc_now()
    return record


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} OUTPUT_DIRECTORY", file=sys.stderr)
        return 2

    output_dir = pathlib.Path(sys.argv[1])
    output_dir.mkdir(parents=True, exist_ok=False)

    records = []
    for relative_target, source_name in DATABASES.items():
        records.append(
            backup_database(pathlib.Path(source_name), output_dir / relative_target)
        )

    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "databases": records,
        "intentionally_omitted": [
            {
                "source": "/volume1/web/HA/home-assistant_v2.db",
                "reason": "Home Assistant recorder history is excluded by backup policy",
            },
            {
                "source": "/volume1/docker/autofilm-suite/autofilm-core/data/backrest/data",
                "reason": "Backrest operation logs and cache are not recovery-critical",
            },
            {
                "source": "/volume1/docker/jellyfin/config/data/kodisyncqueue*.db",
                "reason": "Kodi Sync Queue plugin files are not SQLite and contain rebuildable queue state",
            },
        ],
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    failed = [record for record in records if record["status"] == "failed"]
    if failed:
        for record in failed:
            print(f"SQLite backup failed: {record['source']}: {record['error']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
