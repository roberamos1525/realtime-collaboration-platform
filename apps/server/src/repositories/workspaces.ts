import type { Role } from "@rcp/shared";
import type { Database } from "../db/database.js";

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly ownerId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspaceWithRole extends WorkspaceRecord {
  readonly role: Role;
  readonly memberCount: number;
}

export interface MemberRow {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: Role;
  readonly joinedAt: string;
}

const COLUMNS = `w.id, w.name, w.slug, w.description, w.owner_id AS ownerId, w.created_at AS createdAt, w.updated_at AS updatedAt`;

export class WorkspaceRepository {
  constructor(private readonly db: Database) {}

  insert(w: WorkspaceRecord): void {
    this.db.run(
      `INSERT INTO workspaces (id, name, slug, description, owner_id, created_at, updated_at)
       VALUES (:id, :name, :slug, :description, :ownerId, :createdAt, :updatedAt)`,
      { ...w },
    );
  }

  findById(id: string): WorkspaceRecord | undefined {
    return this.db.get<WorkspaceRecord>(`SELECT ${COLUMNS} FROM workspaces w WHERE w.id = ?`, [id]);
  }

  slugExists(slug: string): boolean {
    return this.db.get("SELECT 1 AS x FROM workspaces WHERE slug = ?", [slug]) !== undefined;
  }

  update(id: string, patch: { name?: string; description?: string }, at: string): void {
    this.db.run(
      `UPDATE workspaces SET name = coalesce(:name, name), description = coalesce(:description, description), updated_at = :at WHERE id = :id`,
      { id, name: patch.name ?? null, description: patch.description ?? null, at },
    );
  }

  setOwner(id: string, ownerId: string, at: string): void {
    this.db.run("UPDATE workspaces SET owner_id = ?, updated_at = ? WHERE id = ?", [ownerId, at, id]);
  }

  delete(id: string): void {
    this.db.run("DELETE FROM workspaces WHERE id = ?", [id]);
  }

  listForUser(userId: string): WorkspaceWithRole[] {
    return this.db.all<WorkspaceWithRole>(
      `SELECT ${COLUMNS}, m.role AS role,
         (SELECT count(*) FROM memberships mm WHERE mm.workspace_id = w.id) AS memberCount
       FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
       WHERE m.user_id = ? ORDER BY w.name COLLATE NOCASE`,
      [userId],
    );
  }

  findForUser(id: string, userId: string): WorkspaceWithRole | undefined {
    return this.db.get<WorkspaceWithRole>(
      `SELECT ${COLUMNS}, m.role AS role,
         (SELECT count(*) FROM memberships mm WHERE mm.workspace_id = w.id) AS memberCount
       FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
       WHERE w.id = ? AND m.user_id = ?`,
      [id, userId],
    );
  }

  roleOf(workspaceId: string, userId: string): Role | null {
    return this.db.get<{ role: Role }>("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?", [workspaceId, userId])?.role ?? null;
  }

  /** Map of workspace id -> role for every membership of the user. */
  rolesForUser(userId: string): Map<string, Role> {
    const rows = this.db.all<{ workspaceId: string; role: Role }>(
      "SELECT workspace_id AS workspaceId, role FROM memberships WHERE user_id = ?",
      [userId],
    );
    return new Map(rows.map((r) => [r.workspaceId, r.role]));
  }

  listMembers(workspaceId: string): MemberRow[] {
    return this.db.all<MemberRow>(
      `SELECT u.id AS userId, u.username, u.display_name AS displayName, m.role, m.created_at AS joinedAt
       FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 WHEN 'commenter' THEN 3 ELSE 4 END, u.username`,
      [workspaceId],
    );
  }

  memberIds(workspaceId: string): string[] {
    return this.db.all<{ userId: string }>("SELECT user_id AS userId FROM memberships WHERE workspace_id = ?", [workspaceId]).map(
      (r) => r.userId,
    );
  }

  addMember(workspaceId: string, userId: string, role: Role, at: string): void {
    this.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", [workspaceId, userId, role, at]);
  }

  setRole(workspaceId: string, userId: string, role: Role): void {
    this.db.run("UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?", [role, workspaceId, userId]);
  }

  removeMember(workspaceId: string, userId: string): boolean {
    return this.db.run("DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?", [workspaceId, userId]).changes === 1;
  }

  count(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM workspaces")?.n ?? 0;
  }
}
