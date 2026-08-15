import type { PromptConfigSummary } from "@autofilm/contracts";
import {
  PROMPT_DEFINITIONS,
  promptDefinition,
  type PromptKey,
} from "../agent/prompt.js";
import type { AppDatabase } from "./database.js";

interface PromptRow {
  key: string;
  content: string;
  customized: number;
  default_version: number;
  updated_at: string;
}

export class PromptStore {
  constructor(private readonly db: AppDatabase) {
    this.ensureDefaults();
  }

  list(): PromptConfigSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM prompt_configs ORDER BY key")
      .all() as PromptRow[];
    return rows
      .filter((row) => Boolean(promptDefinition(row.key)))
      .map((row) => this.summary(row))
      .sort(
        (left, right) =>
          PROMPT_DEFINITIONS.findIndex((item) => item.key === left.key) -
          PROMPT_DEFINITIONS.findIndex((item) => item.key === right.key),
      );
  }

  get(key: PromptKey): string {
    const row = this.db
      .prepare("SELECT content FROM prompt_configs WHERE key = ?")
      .get(key) as { content: string } | undefined;
    return row?.content ?? promptDefinition(key)?.content ?? "";
  }

  save(key: PromptKey, content: string): PromptConfigSummary {
    const definition = requiredDefinition(key);
    const normalized = content.trim();
    if (!normalized) throw new Error("Prompt content cannot be empty");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO prompt_configs
          (key, content, customized, default_version, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           content=excluded.content, customized=1,
           default_version=excluded.default_version, updated_at=excluded.updated_at`,
      )
      .run(key, normalized, definition.version, now);
    return this.list().find((item) => item.key === key)!;
  }

  reset(key: PromptKey): PromptConfigSummary {
    const definition = requiredDefinition(key);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO prompt_configs
          (key, content, customized, default_version, updated_at)
         VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           content=excluded.content, customized=0,
           default_version=excluded.default_version, updated_at=excluded.updated_at`,
      )
      .run(key, definition.content, definition.version, now);
    return this.list().find((item) => item.key === key)!;
  }

  private ensureDefaults(): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO prompt_configs
        (key, content, customized, default_version, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    );
    const upgrade = this.db.prepare(
      `UPDATE prompt_configs
       SET content = ?, default_version = ?, updated_at = ?
       WHERE key = ? AND customized = 0 AND default_version < ?`,
    );
    this.db.transaction(() => {
      for (const definition of PROMPT_DEFINITIONS) {
        insert.run(
          definition.key,
          definition.content,
          definition.version,
          now,
        );
        upgrade.run(
          definition.content,
          definition.version,
          now,
          definition.key,
          definition.version,
        );
      }
    })();
  }

  private summary(row: PromptRow): PromptConfigSummary {
    const definition = requiredDefinition(row.key);
    return {
      key: definition.key,
      name: definition.name,
      description: definition.description,
      content: row.content,
      customized: Boolean(row.customized),
      defaultVersion: row.default_version,
      updatedAt: row.updated_at,
    };
  }
}

function requiredDefinition(key: string) {
  const definition = promptDefinition(key);
  if (!definition) throw new Error(`Unknown prompt: ${key}`);
  return definition;
}
