import type { Database } from "../db/database.js";

export interface CommentRecord {
  readonly id: string;
  readonly documentId: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly authorId: string | null;
  readonly body: string;
  readonly anchorStart: string | null;
  readonly anchorEnd: string | null;
  readonly anchorQuote: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const COLUMNS = `id, document_id AS documentId, workspace_id AS workspaceId, parent_id AS parentId, author_id AS authorId,
  body, anchor_start AS anchorStart, anchor_end AS anchorEnd, anchor_quote AS anchorQuote, resolved_at AS resolvedAt,
  resolved_by AS resolvedBy, created_at AS createdAt, updated_at AS updatedAt`;

export class CommentRepository {
  constructor(private readonly db: Database) {}

  insert(c: CommentRecord): void {
    this.db.run(
      `INSERT INTO comments (id, document_id, workspace_id, parent_id, author_id, body, anchor_start, anchor_end, anchor_quote,
         resolved_at, resolved_by, created_at, updated_at)
       VALUES (:id, :documentId, :workspaceId, :parentId, :authorId, :body, :anchorStart, :anchorEnd, :anchorQuote,
         :resolvedAt, :resolvedBy, :createdAt, :updatedAt)`,
      { ...c },
    );
  }

  findById(id: string): CommentRecord | undefined {
    return this.db.get<CommentRecord>(`SELECT ${COLUMNS} FROM comments WHERE id = ?`, [id]);
  }

  listByDocument(documentId: string): CommentRecord[] {
    return this.db.all<CommentRecord>(`SELECT ${COLUMNS} FROM comments WHERE document_id = ? ORDER BY created_at, rowid`, [documentId]);
  }

  listAll(): CommentRecord[] {
    return this.db.all<CommentRecord>(`SELECT ${COLUMNS} FROM comments`);
  }

  /** Distinct authors in a thread (root + replies), for reply notifications. */
  threadParticipants(rootId: string): string[] {
    return this.db
      .all<{ authorId: string }>(
        "SELECT DISTINCT author_id AS authorId FROM comments WHERE (id = ? OR parent_id = ?) AND author_id IS NOT NULL",
        [rootId, rootId],
      )
      .map((r) => r.authorId);
  }

  /** Element keys referenced by comment anchors; retained during CRDT GC. */
  anchorKeys(documentId: string): Set<string> {
    const rows = this.db.all<{ s: string | null; e: string | null }>(
      "SELECT anchor_start AS s, anchor_end AS e FROM comments WHERE document_id = ? AND anchor_start IS NOT NULL",
      [documentId],
    );
    const keys = new Set<string>();
    for (const r of rows) {
      if (r.s) keys.add(r.s);
      if (r.e) keys.add(r.e);
    }
    return keys;
  }

  updateBody(id: string, body: string, at: string): void {
    this.db.run("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?", [body, at, id]);
  }

  setResolved(id: string, resolvedBy: string | null, at: string): void {
    this.db.run("UPDATE comments SET resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?", [
      resolvedBy ? at : null,
      resolvedBy,
      at,
      id,
    ]);
  }

  /** Deletes a comment; replies cascade. Returns the ids removed. */
  delete(id: string): string[] {
    const ids = this.db.all<{ id: string }>("SELECT id FROM comments WHERE id = ? OR parent_id = ?", [id, id]).map((r) => r.id);
    this.db.run("DELETE FROM comments WHERE id = ?", [id]);
    return ids;
  }
}
