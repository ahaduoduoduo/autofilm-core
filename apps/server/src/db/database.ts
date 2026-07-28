import Database from "better-sqlite3";

const migrations = [
  `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

  CREATE TABLE ai_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_encrypted TEXT,
    custom_headers_encrypted TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE model_profiles (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    model TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    temperature REAL,
    max_output_tokens INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX one_default_model_idx
    ON model_profiles(is_default) WHERE is_default = 1;

  CREATE TABLE channel_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('native', 'telegram')),
    provider_instance_id TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    inbound_token_hash TEXT,
    outbound_token_encrypted TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(type, provider_instance_id)
  );

  CREATE TABLE external_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    channel TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'blocked')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(channel, provider_instance_id, external_user_id)
  );
  CREATE INDEX external_identities_user_idx ON external_identities(user_id);

  CREATE TABLE service_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('openlist', 'jellyfin', 'jackett', 'tmdb')),
    base_url TEXT NOT NULL DEFAULT '',
    credential_encrypted TEXT,
    options_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
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

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_calls_json TEXT,
    tool_call_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_conversation_idx
    ON messages(conversation_id, created_at);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    progress REAL,
    status_text TEXT NOT NULL DEFAULT '',
    external_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX tasks_state_idx ON tasks(state, updated_at);

  CREATE TABLE processed_events (
    event_id TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    processed_at TEXT NOT NULL
  );

  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE outbox_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    channel TEXT,
    provider_instance_id TEXT,
    target_id TEXT,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX outbox_due_idx
    ON outbox_messages(state, next_attempt_at);
  `,
  `
  CREATE TABLE ephemeral_media (
    token_hash TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    content_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    remaining_reads INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX ephemeral_media_expiry_idx ON ephemeral_media(expires_at);
  `,
];

export type AppDatabase = Database.Database;

export function openDatabase(filename: string): AppDatabase {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  migrations.forEach((sql, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(version, new Date().toISOString());
    })();
  });
}
