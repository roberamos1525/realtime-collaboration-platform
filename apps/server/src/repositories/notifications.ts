import type { NotificationDto } from "@rcp/shared";
import type { Database } from "../db/database.js";

export interface NotificationRecord {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string | null;
  readonly documentId: string | null;
  readonly entityId: string | null;
  readonly kind: NotificationDto["kind"];
  readonly title: string;
  readonly body: string;
  readonly actorId: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

const COLUMNS = `id, user_id AS userId, workspace_id AS workspaceId, document_id AS documentId, entity_id AS entityId,
  kind, title, body, actor_id AS actorId, read_at AS readAt, created_at AS createdAt`;

export class NotificationRepository {
  constructor(private readonly db: Database) {}

  insert(n: NotificationRecord): void {
    this.db.run(
      `INSERT INTO notifications (id, user_id, workspace_id, document_id, entity_id, kind, title, body, actor_id, read_at, created_at)
       VALUES (:id, :userId, :workspaceId, :documentId, :entityId, :kind, :title, :body, :actorId, :readAt, :createdAt)`,
      { ...n },
    );
  }

  /** Keyset pagination ordered newest first by (created_at, id). */
  list(userId: string, opts: { limit: number; unreadOnly: boolean; before?: { createdAt: string; id: string } }): NotificationRecord[] {
    const clauses = ["user_id = :userId"];
    const params: Record<string, string | number> = { userId, limit: opts.limit };
    if (opts.unreadOnly) clauses.push("read_at IS NULL");
    if (opts.before) {
      clauses.push("(created_at < :beforeAt OR (created_at = :beforeAt AND id < :beforeId))");
      params.beforeAt = opts.before.createdAt;
      params.beforeId = opts.before.id;
    }
    return this.db.all<NotificationRecord>(
      `SELECT ${COLUMNS} FROM notifications WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT :limit`,
      params,
    );
  }

  findById(id: string): NotificationRecord | undefined {
    return this.db.get<NotificationRecord>(`SELECT ${COLUMNS} FROM notifications WHERE id = ?`, [id]);
  }

  unreadCount(userId: string): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", [userId])?.n ?? 0;
  }

  markRead(userId: string, id: string, at: string): boolean {
    return this.db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL", [at, id, userId]).changes === 1;
  }

  markUnread(userId: string, id: string): boolean {
    return this.db.run("UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ?", [id, userId]).changes === 1;
  }

  markAllRead(userId: string, at: string): number {
    return this.db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", [at, userId]).changes;
  }
}
