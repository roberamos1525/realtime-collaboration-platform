import type { Database } from "../db/database.js";

export interface ActivityRecord {
  readonly id: number;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly actorId: string | null;
  readonly verb: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly meta: Record<string, unknown>;
  readonly createdAt: string;
}

type ActivityRow = Omit<ActivityRecord, "meta"> & { meta: string };

const COLUMNS = `id, workspace_id AS workspaceId, document_id AS documentId, actor_id AS actorId, verb,
  target_type AS targetType, target_id AS targetId, meta, created_at AS createdAt`;

function fromRow(row: ActivityRow): ActivityRecord {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.meta);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return { ...row, meta };
}

export class ActivityRepository {
  constructor(private readonly db: Database) {}

  insert(a: Omit<ActivityRecord, "id">): ActivityRecord {
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO activity (workspace_id, document_id, actor_id, verb, target_type, target_id, meta, created_at)
       VALUES (:workspaceId, :documentId, :actorId, :verb, :targetType, :targetId, :meta, :createdAt)`,
      { ...a, meta: JSON.stringify(a.meta) },
    );
    return { ...a, id: lastInsertRowid };
  }

  /** Newest-first page; `beforeId` is the keyset cursor. */
  listForWorkspace(workspaceId: string, limit: number, beforeId?: number): ActivityRecord[] {
    return this.db
      .all<ActivityRow>(
        `SELECT ${COLUMNS} FROM activity WHERE workspace_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
        [workspaceId, beforeId ?? Number.MAX_SAFE_INTEGER, limit],
      )
      .map(fromRow);
  }

  listForDocument(documentId: string, limit: number, beforeId?: number): ActivityRecord[] {
    return this.db
      .all<ActivityRow>(`SELECT ${COLUMNS} FROM activity WHERE document_id = ? AND id < ? ORDER BY id DESC LIMIT ?`, [
        documentId,
        beforeId ?? Number.MAX_SAFE_INTEGER,
        limit,
      ])
      .map(fromRow);
  }
}
