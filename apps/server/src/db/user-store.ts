import { randomUUID } from "node:crypto";
import type {
  ExternalIdentity,
  MemberSummary,
  SessionUser,
  UserRole,
  UserStatus,
} from "@autofilm/contracts";
import type { AppDatabase } from "./database.js";

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

interface IdentityRow {
  id: string;
  user_id: string | null;
  channel: string;
  provider_instance_id: string;
  external_user_id: string;
  display_name: string;
  status: "pending" | "active" | "blocked";
  created_at: string;
}

export class UserStore {
  constructor(private readonly db: AppDatabase) {}

  count(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS total FROM users").get() as {
        total: number;
      }
    ).total;
  }

  ownerCount(): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS total FROM users WHERE role = 'owner' AND status = 'active'",
        )
        .get() as { total: number }
    ).total;
  }

  create(input: {
    username: string;
    displayName: string;
    passwordHash?: string;
    role: UserRole;
    status?: UserStatus;
  }): SessionUser {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users
          (id, username, display_name, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.username,
        input.displayName,
        input.passwordHash ?? null,
        input.role,
        input.status ?? "active",
        now,
        now,
      );
    return {
      id,
      username: input.username,
      displayName: input.displayName,
      role: input.role,
    };
  }

  findByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username) as UserRow | undefined;
  }

  findById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined;
  }

  sessionUser(id: string): SessionUser | undefined {
    const row = this.findById(id);
    if (!row || row.status !== "active") return undefined;
    return toSessionUser(row);
  }

  listMembers(): MemberSummary[] {
    const identities = this.listIdentities();
    const grouped = new Map<string, ExternalIdentity[]>();
    for (const identity of identities) {
      if (!identity.userId) continue;
      const current = grouped.get(identity.userId) ?? [];
      current.push(identity);
      grouped.set(identity.userId, current);
    }
    return (this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[]).map(
      (row) => ({
        ...toSessionUser(row),
        status: row.status,
        identities: grouped.get(row.id) ?? [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }

  update(
    id: string,
    input: {
      displayName?: string;
      role?: UserRole;
      status?: UserStatus;
      passwordHash?: string;
    },
  ): void {
    const existing = this.findById(id);
    if (!existing) throw new Error("Member not found");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE users
         SET display_name = ?, role = ?, status = ?, password_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.displayName ?? existing.display_name,
        input.role ?? existing.role,
        input.status ?? existing.status,
        input.passwordHash ?? existing.password_hash,
        now,
        id,
      );
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  createSession(userId: string, tokenHash: string, expiresAt: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions(token_hash, user_id, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, expiresAt, new Date().toISOString());
  }

  resolveSession(tokenHash: string): SessionUser | undefined {
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
      )
      .get(tokenHash, new Date().toISOString()) as UserRow | undefined;
    return row ? toSessionUser(row) : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteExpiredSessions(): void {
    this.db
      .prepare("DELETE FROM sessions WHERE expires_at <= ?")
      .run(new Date().toISOString());
  }

  listIdentities(): ExternalIdentity[] {
    return (
      this.db
        .prepare("SELECT * FROM external_identities ORDER BY created_at DESC")
        .all() as IdentityRow[]
    ).map(toIdentity);
  }

  activeIdentities(userId: string): ExternalIdentity[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM external_identities
           WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC`,
        )
        .all(userId) as IdentityRow[]
    ).map(toIdentity);
  }

  findIdentity(
    channel: string,
    providerInstanceId: string,
    externalUserId: string,
  ): ExternalIdentity | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM external_identities
         WHERE channel = ? AND provider_instance_id = ? AND external_user_id = ?`,
      )
      .get(channel, providerInstanceId, externalUserId) as
      | IdentityRow
      | undefined;
    return row ? toIdentity(row) : undefined;
  }

  ensurePendingIdentity(input: {
    channel: string;
    providerInstanceId: string;
    externalUserId: string;
    displayName: string;
  }): ExternalIdentity {
    const existing = this.findIdentity(
      input.channel,
      input.providerInstanceId,
      input.externalUserId,
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO external_identities
          (id, channel, provider_instance_id, external_user_id, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.channel,
        input.providerInstanceId,
        input.externalUserId,
        input.displayName,
        now,
        now,
      );
    return {
      id,
      userId: null,
      channel: input.channel,
      providerInstanceId: input.providerInstanceId,
      externalUserId: input.externalUserId,
      displayName: input.displayName,
      status: "pending",
      createdAt: now,
    };
  }

  bindIdentity(
    identityId: string,
    userId: string | null,
    status: "pending" | "active" | "blocked",
  ): void {
    this.db
      .prepare(
        `UPDATE external_identities
         SET user_id = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(userId, status, new Date().toISOString(), identityId);
  }
}

function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
  };
}

function toIdentity(row: IdentityRow): ExternalIdentity {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    providerInstanceId: row.provider_instance_id,
    externalUserId: row.external_user_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
  };
}
