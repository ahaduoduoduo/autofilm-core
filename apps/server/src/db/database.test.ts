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
      CREATE TABLE model_profiles (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        temperature REAL,
        max_output_tokens INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, channel, provider_instance_id, external_conversation_id)
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
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_compactions'",
      ).get(),
    ).toBeTruthy();
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='native_request_jobs'",
      ).get(),
    ).toBeTruthy();
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_compaction_chunks'",
      ).get(),
    ).toBeTruthy();
    expect(
      db.prepare("PRAGMA table_info(model_profiles)").all().some(
        (column) =>
          (column as { name: string }).name === "context_window_tokens",
      ),
    ).toBe(true);
    expect(
      db.prepare("PRAGMA table_info(model_profiles)").all().some(
        (column) =>
          (column as { name: string }).name === "compact_keep_recent_tokens",
      ),
    ).toBe(true);
    expect(
      db.prepare("PRAGMA table_info(conversation_compactions)").all().some(
        (column) =>
          (column as { name: string }).name === "retained_user_messages_json",
      ),
    ).toBe(false);
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'conversation_topic_%'",
      ).all(),
    ).toEqual([]);
    db.close();
  });

  it("replaces the legacy layered context schema with one checkpoint", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "autofilm-db-v10-"));
    directories.push(directory);
    const filename = path.join(directory, "autofilm.sqlite");
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES
        (1, '2026-08-01'), (2, '2026-08-01'), (3, '2026-08-01'),
        (4, '2026-08-01'), (5, '2026-08-01'), (6, '2026-08-01'),
        (7, '2026-08-01'), (8, '2026-08-01'), (9, '2026-08-01'),
        (10, '2026-08-01');
      CREATE TABLE users (id TEXT PRIMARY KEY);
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE model_profiles (
        id TEXT PRIMARY KEY,
        context_window_tokens INTEGER NOT NULL DEFAULT 128000,
        auto_compact_token_limit INTEGER,
        tool_output_token_limit INTEGER NOT NULL DEFAULT 12000
      );
      CREATE TABLE prompt_configs (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        customized INTEGER NOT NULL DEFAULT 0,
        default_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE conversation_topic_state (
        conversation_id TEXT PRIMARY KEY,
        topic_key TEXT NOT NULL
      );
      CREATE TABLE conversation_topic_summaries (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        summary TEXT NOT NULL
      );
      CREATE TABLE conversation_compactions (
        conversation_id TEXT PRIMARY KEY
          REFERENCES conversations(id) ON DELETE CASCADE,
        through_sequence INTEGER NOT NULL,
        summary TEXT NOT NULL,
        retained_user_messages_json TEXT NOT NULL DEFAULT '[]',
        source_token_estimate INTEGER NOT NULL DEFAULT 0,
        summary_token_estimate INTEGER NOT NULL DEFAULT 0,
        compaction_count INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO users VALUES ('user-1');
      INSERT INTO conversations VALUES ('conversation-1', 'user-1');
      INSERT INTO conversation_compactions VALUES
        ('conversation-1', 42, '保留的检查点', '["旧原话副本"]', 1000, 50, 2,
         '2026-08-01', '2026-08-01');
      INSERT INTO conversation_topic_state VALUES
        ('conversation-1', 'movie:tmdb:1');
      INSERT INTO conversation_topic_summaries VALUES
        ('summary-1', 'conversation-1', '旧主题摘要');
      INSERT INTO prompt_configs VALUES
        ('conversation.summarizer', '旧提示词', 0, 1, '2026-08-01');
    `);
    legacy.close();

    const db = openDatabase(filename);
    expect(
      db.prepare("SELECT summary FROM conversation_compactions").get(),
    ).toEqual({ summary: "保留的检查点" });
    expect(
      db.prepare("PRAGMA table_info(conversation_compactions)").all().map(
        (column) => (column as { name: string }).name,
      ),
    ).not.toContain("retained_user_messages_json");
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'conversation_topic_%'",
      ).all(),
    ).toEqual([]);
    expect(
      db.prepare(
        "SELECT key FROM prompt_configs WHERE key='conversation.summarizer'",
      ).get(),
    ).toBeUndefined();
    expect(
      db.prepare("PRAGMA table_info(model_profiles)").all().map(
        (column) => (column as { name: string }).name,
      ),
    ).toContain("compact_keep_recent_tokens");
    db.close();
  });
});
