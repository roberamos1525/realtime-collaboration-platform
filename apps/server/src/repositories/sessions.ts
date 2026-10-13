import type { Database } from "../db/database.js";

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly refreshHash: string;
  readonly previousHash: string | null;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
}

const COLUMNS = `id, user_id AS userId, refresh_hash AS refreshHash, previous_hash AS previousHash,
  user_agent AS userAgent, ip, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt,
  revoked_at AS revokedAt, revoke_reason AS revokeReason`;

export class SessionRepository {
  constructor(private readonly db: Database) {}

  insert(s: Omit<SessionRecord, "previousHash" | "revokedAt" | "revokeReason">): void {
    this.db.run(
      `INSERT INTO sessions (id, user_id, refresh_hash, user_agent, ip, created_at, last_used_at, expires_at)
       VALUES (:id, :userId, :refreshHash, :userAgent, :ip, :createdAt, :lastUsedAt, :expiresAt)`,
      { ...s },
    );
  }

  findById(id: string): SessionRecord | undefined {
    return this.db.get<SessionRecord>(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`, [id]);
  }

  findByRefreshHash(hash: string): SessionRecord | undefined {
    return this.db.get<SessionRecord>(`SELECT ${COLUMNS} FROM sessions WHERE refresh_hash = ?`, [hash]);
  }

  findByPreviousHash(hash: string): SessionRecord | undefined {
    return this.db.get<SessionRecord>(`SELECT ${COLUMNS} FROM sessions WHERE previous_hash = ?`, [hash]);
  }

  /** Rotates the refresh token, remembering the old hash for reuse detection. */
  rotate(id: string, oldHash: string, newHash: string, at: string, expiresAt: string): boolean {
    const result = this.db.run(
      `UPDATE sessions SET refresh_hash = ?, previous_hash = ?, last_used_at = ?, expires_at = ?
       WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL`,
      [newHash, oldHash, at, expiresAt, id, oldHash],
    );
    return result.changes === 1;
  }

  revoke(id: string, reason: string, at: string): boolean {
    return this.db.run("UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL", [at, reason, id])
      .changes === 1;
  }

  /** Revokes all active sessions of a user, optionally keeping one. Returns revoked ids. */
  revokeAllForUser(userId: string, reason: string, at: string, exceptId: string | null = null): string[] {
    const ids = this.db
      .all<{ id: string }>("SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?", [userId, exceptId])
      .map((r) => r.id);
    if (ids.length > 0) {
      this.db.run("UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?", [
        at,
        reason,
        userId,
        exceptId,
      ]);
    }
    return ids;
  }

  listActiveForUser(userId: string, nowIso: string): SessionRecord[] {
    return this.db.all<SessionRecord>(
      `SELECT ${COLUMNS} FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_used_at DESC`,
      [userId, nowIso],
    );
  }

  /** Deletes sessions that expired or were revoked before `beforeIso`. */
  prune(beforeIso: string): number {
    return this.db.run("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)", [beforeIso, beforeIso])
      .changes;
  }
}
