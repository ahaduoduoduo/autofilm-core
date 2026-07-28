import { createToken, hashToken } from "../security/tokens.js";
import type { AppDatabase } from "./database.js";

interface MediaRow {
  content: Buffer;
  content_type: string;
  file_name: string;
  remaining_reads: number;
}

export class EphemeralMediaStore {
  constructor(private readonly db: AppDatabase) {}

  create(input: {
    content: Buffer;
    contentType: string;
    fileName: string;
    expiresAt: Date;
    reads?: number;
  }): string {
    const token = createToken(32);
    this.db
      .prepare(
        `INSERT INTO ephemeral_media
          (token_hash, content, content_type, file_name, expires_at,
           remaining_reads, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(token),
        input.content,
        input.contentType,
        input.fileName,
        input.expiresAt.toISOString(),
        input.reads ?? 5,
        new Date().toISOString(),
      );
    return token;
  }

  consume(token: string): {
    content: Buffer;
    contentType: string;
    fileName: string;
  } | undefined {
    return this.db.transaction(() => {
      const tokenHash = hashToken(token);
      const row = this.db
        .prepare(
          `SELECT content, content_type, file_name, remaining_reads
           FROM ephemeral_media
           WHERE token_hash = ? AND expires_at > ? AND remaining_reads > 0`,
        )
        .get(tokenHash, new Date().toISOString()) as MediaRow | undefined;
      if (!row) return undefined;
      this.db
        .prepare(
          `UPDATE ephemeral_media SET remaining_reads = remaining_reads - 1
           WHERE token_hash = ?`,
        )
        .run(tokenHash);
      return {
        content: row.content,
        contentType: row.content_type,
        fileName: row.file_name,
      };
    })();
  }

  deleteExpired(): void {
    this.db
      .prepare(
        "DELETE FROM ephemeral_media WHERE expires_at <= ? OR remaining_reads <= 0",
      )
      .run(new Date().toISOString());
  }
}
