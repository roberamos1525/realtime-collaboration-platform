import type { Database } from "../db/database.js";

export interface DocumentRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly content: string;
}

export interface DocumentState {
  readonly snapshot: string;
  readonly snapshotSeq: number;
  readonly headSeq: number;
}

export interface StoredOp {
  readonly seq: number;
  readonly userId: string | null;
  readonly op: string;
}

export interface VersionRecord {
  readonly id: string;
  readonly documentId: string;
  readonly label: string;
  readonly content: string;
  readonly seq: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

const COLUMNS = `id, workspace_id AS workspaceId, title, created_by AS createdBy, created_at AS createdAt,
  updated_at AS updatedAt, content`;
const VERSION_COLUMNS = `id, document_id AS documentId, label, content, seq, created_by AS createdBy, created_at AS createdAt`;

export class DocumentRepository {
  constructor(private readonly db: Database) {}

  insert(doc: DocumentRecord, snapshot: string): void {
    this.db.run(
      `INSERT INTO documents (id, workspace_id, title, created_by, created_at, updated_at, snapshot, content)
       VALUES (:id, :workspaceId, :title, :createdBy, :createdAt, :updatedAt, :snapshot, :content)`,
      { ...doc, snapshot },
    );
  }

  findById(id: string): DocumentRecord | undefined {
    return this.db.get<DocumentRecord>(`SELECT ${COLUMNS} FROM documents WHERE id = ? AND deleted_at IS NULL`, [id]);
  }

  listByWorkspace(workspaceId: string): DocumentRecord[] {
    return this.db.all<DocumentRecord>(
      `SELECT ${COLUMNS} FROM documents WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [workspaceId],
    );
  }

  /** Every live document, used to build the search index at startup. */
  listAll(): DocumentRecord[] {
    return this.db.all<DocumentRecord>(`SELECT ${COLUMNS} FROM documents WHERE deleted_at IS NULL`);
  }

  rename(id: string, title: string, at: string): void {
    this.db.run("UPDATE documents SET title = ?, updated_at = ? WHERE id = ?", [title, at, id]);
  }

  softDelete(id: string, at: string): void {
    this.db.run("UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?", [at, at, id]);
  }

  loadState(id: string): DocumentState | undefined {
    return this.db.get<DocumentState>(
      "SELECT snapshot, snapshot_seq AS snapshotSeq, head_seq AS headSeq FROM documents WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
  }

  opsAfter(id: string, seq: number): StoredOp[] {
    return this.db.all<StoredOp>("SELECT seq, user_id AS userId, op FROM document_ops WHERE document_id = ? AND seq > ? ORDER BY seq", [
      id,
      seq,
    ]);
  }

  countOps(id: string): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM document_ops WHERE document_id = ?", [id])?.n ?? 0;
  }

  /** Appends one integrated operation and advances the head sequence. */
  appendOp(id: string, seq: number, userId: string | null, op: string, at: string): void {
    this.db.transaction(() => {
      this.db.run("INSERT INTO document_ops (document_id, seq, user_id, op, created_at) VALUES (?, ?, ?, ?, ?)", [id, seq, userId, op, at]);
      this.db.run("UPDATE documents SET head_seq = ?, updated_at = ? WHERE id = ?", [seq, at, id]);
    });
  }

  /** Writes a compacted snapshot and drops the operations it covers. */
  saveSnapshot(id: string, snapshot: string, seq: number, content: string, at: string): number {
    return this.db.transaction(() => {
      this.db.run("UPDATE documents SET snapshot = ?, snapshot_seq = ?, content = ?, updated_at = max(updated_at, ?) WHERE id = ?", [
        snapshot,
        seq,
        content,
        at,
        id,
      ]);
      return this.db.run("DELETE FROM document_ops WHERE document_id = ? AND seq <= ?", [id, seq]).changes;
    });
  }

  updateContent(id: string, content: string): void {
    this.db.run("UPDATE documents SET content = ? WHERE id = ?", [content, id]);
  }

  insertVersion(v: VersionRecord): void {
    this.db.run(
      `INSERT INTO document_versions (id, document_id, label, content, seq, created_by, created_at)
       VALUES (:id, :documentId, :label, :content, :seq, :createdBy, :createdAt)`,
      { ...v },
    );
  }

  listVersions(documentId: string): VersionRecord[] {
    return this.db.all<VersionRecord>(
      `SELECT ${VERSION_COLUMNS} FROM document_versions WHERE document_id = ? ORDER BY created_at DESC, rowid DESC`,
      [documentId],
    );
  }

  findVersion(documentId: string, versionId: string): VersionRecord | undefined {
    return this.db.get<VersionRecord>(`SELECT ${VERSION_COLUMNS} FROM document_versions WHERE document_id = ? AND id = ?`, [
      documentId,
      versionId,
    ]);
  }

  count(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM documents WHERE deleted_at IS NULL")?.n ?? 0;
  }

  listIds(): string[] {
    return this.db.all<{ id: string }>("SELECT id FROM documents WHERE deleted_at IS NULL").map((r) => r.id);
  }
}
