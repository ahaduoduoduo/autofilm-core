import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("upgrades the existing service table and preserves configured services", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-db-"));
    directories.push(directory);
    const filename = path.join(directory, "autofilm.sqlite");
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES
        (1, '2026-07-01'), (2, '2026-07-01'), (3, '2026-07-01');
      CREATE TABLE service_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (
          type IN ('openlist', 'jellyfin', 'jackett', 'tmdb')
        ),
        base_url TEXT NOT NULL DEFAULT '',
        credential_encrypted TEXT,
        options_json TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO service_configs VALUES
        ('one', 'OpenList', 'openlist', 'http://openlist:5244', NULL, '{}', 1,
         '2026-07-01', '2026-07-01');
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE channel_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        inbound_token_hash TEXT,
        outbound_token_encrypted TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const db = openDatabase(filename);
    expect(
      (db.prepare("SELECT name FROM service_configs WHERE id='one'").get() as {
        name: string;
      }).name,
    ).toBe("OpenList");
    expect(
      db.prepare(
        `INSERT INTO service_configs
          (id,name,type,base_url,options_json,enabled,created_at,updated_at)
         VALUES ('sub','SubHD','subhd','https://subhd.tv','{}',1,'now','now')`,
      ).run().changes,
    ).toBe(1);
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='watchlists'",
      ).get(),
    ).toBeTruthy();
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='prompt_configs'",
      ).get(),
    ).toBeTruthy();
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='media_upgrade_items'",
      ).get(),
    ).toBeTruthy();
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='user_memories'",
      ).get(),
    ).toBeTruthy();
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='media_upgrade_check_items'",
      ).get(),
    ).toBeTruthy();
    db.close();
  });
});
