import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./database.js";

export type UserMemoryCategory =
  | "preference"
  | "profile"
  | "constraint"
  | "note";

export interface UserMemory {
  id: string;
  userId: string;
  category: UserMemoryCategory;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  user_id: string;
  category: UserMemoryCategory;
  content: string;
  created_at: string;
  updated_at: string;
}

const MAX_MEMORIES_PER_USER = 100;
const MAX_CONTENT_LENGTH = 1_000;
const MAX_PROMPT_LENGTH = 16_000;

export class UserMemoryStore {
  constructor(private readonly db: AppDatabase) {}

  list(userId: string): UserMemory[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM user_memories
           WHERE user_id = ? ORDER BY updated_at DESC, id`,
        )
        .all(userId) as MemoryRow[]
    ).map(toMemory);
  }

  add(input: {
    userId: string;
    category: UserMemoryCategory;
    content: string;
  }): UserMemory {
    const content = normalizedContent(input.content);
    const count = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS total FROM user_memories WHERE user_id = ?",
        )
        .get(input.userId) as { total: number }
    ).total;
    if (count >= MAX_MEMORIES_PER_USER) {
      throw new Error(`每个用户最多保存 ${MAX_MEMORIES_PER_USER} 条长期记忆`);
    }
    const duplicate = this.db
      .prepare(
        `SELECT * FROM user_memories
         WHERE user_id = ? AND category = ? AND content = ?`,
      )
      .get(input.userId, input.category, content) as MemoryRow | undefined;
    if (duplicate) return toMemory(duplicate);

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_memories
          (id, user_id, category, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.userId, input.category, content, now, now);
    return this.get(input.userId, id)!;
  }

  update(input: {
    userId: string;
    id: string;
    category?: UserMemoryCategory;
    content?: string;
  }): UserMemory {
    const current = this.get(input.userId, input.id);
    if (!current) throw new Error("长期记忆不存在");
    const category = input.category ?? current.category;
    const content =
      input.content === undefined
        ? current.content
        : normalizedContent(input.content);
    this.db
      .prepare(
        `UPDATE user_memories
         SET category = ?, content = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(category, content, new Date().toISOString(), input.id, input.userId);
    return this.get(input.userId, input.id)!;
  }

  delete(userId: string, id: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM user_memories WHERE id = ? AND user_id = ?")
        .run(id, userId).changes > 0
    );
  }

  prompt(userId: string): string {
    const memories = this.list(userId);
    if (memories.length === 0) return "";
    const lines = memories.map(
      (memory) =>
        `- [${memory.id}] (${memory.category}) ${memory.content}`,
    );
    const selected: string[] = [];
    let length = 0;
    for (const line of lines) {
      if (length + line.length > MAX_PROMPT_LENGTH) break;
      selected.push(line);
      length += line.length;
    }
    return [
      "## 当前成员长期记忆",
      "以下内容属于当前成员，跨会话保留；方括号内是修改时使用的 memory_id。",
      ...selected,
    ].join("\n");
  }

  private get(userId: string, id: string): UserMemory | undefined {
    const row = this.db
      .prepare("SELECT * FROM user_memories WHERE id = ? AND user_id = ?")
      .get(id, userId) as MemoryRow | undefined;
    return row ? toMemory(row) : undefined;
  }
}

function normalizedContent(value: string): string {
  const content = value.trim();
  if (!content) throw new Error("长期记忆内容不能为空");
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`单条长期记忆不能超过 ${MAX_CONTENT_LENGTH} 个字符`);
  }
  return content;
}

function toMemory(row: MemoryRow): UserMemory {
  return {
    id: row.id,
    userId: row.user_id,
    category: row.category,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
