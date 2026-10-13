import type { TaskPriority, TaskStatus } from "@rcp/shared";
import type { Database } from "../db/database.js";

export interface TaskRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly labels: string[];
  readonly position: number;
  readonly documentId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type TaskRow = Omit<TaskRecord, "labels"> & { labels: string };

const COLUMNS = `id, workspace_id AS workspaceId, title, description, status, priority, assignee_id AS assigneeId,
  due_date AS dueDate, labels, position, document_id AS documentId, created_by AS createdBy, created_at AS createdAt,
  updated_at AS updatedAt`;

function fromRow(row: TaskRow): TaskRecord {
  let labels: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.labels);
    if (Array.isArray(parsed)) labels = parsed.filter((l): l is string => typeof l === "string");
  } catch {
    labels = [];
  }
  return { ...row, labels };
}

export interface TaskFilter {
  readonly status?: TaskStatus;
  readonly assigneeId?: string;
  readonly label?: string;
}

export class TaskRepository {
  constructor(private readonly db: Database) {}

  insert(t: TaskRecord): void {
    this.db.run(
      `INSERT INTO tasks (id, workspace_id, title, description, status, priority, assignee_id, due_date, labels, position,
         document_id, created_by, created_at, updated_at)
       VALUES (:id, :workspaceId, :title, :description, :status, :priority, :assigneeId, :dueDate, :labels, :position,
         :documentId, :createdBy, :createdAt, :updatedAt)`,
      { ...t, labels: JSON.stringify(t.labels) },
    );
  }

  findById(id: string): TaskRecord | undefined {
    const row = this.db.get<TaskRow>(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`, [id]);
    return row ? fromRow(row) : undefined;
  }

  list(workspaceId: string, filter: TaskFilter = {}): TaskRecord[] {
    const clauses = ["workspace_id = :workspaceId"];
    const params: Record<string, string> = { workspaceId };
    if (filter.status) {
      clauses.push("status = :status");
      params.status = filter.status;
    }
    if (filter.assigneeId) {
      clauses.push("assignee_id = :assigneeId");
      params.assigneeId = filter.assigneeId;
    }
    if (filter.label) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE json_each.value = :label)");
      params.label = filter.label.toLowerCase();
    }
    return this.db
      .all<TaskRow>(`SELECT ${COLUMNS} FROM tasks WHERE ${clauses.join(" AND ")} ORDER BY status, position`, params)
      .map(fromRow);
  }

  listAll(): TaskRecord[] {
    return this.db.all<TaskRow>(`SELECT ${COLUMNS} FROM tasks`).map(fromRow);
  }

  /** Ordered positions of a column, used to compute fractional positions. */
  columnPositions(workspaceId: string, status: TaskStatus): Array<{ id: string; position: number }> {
    return this.db.all<{ id: string; position: number }>(
      "SELECT id, position FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY position",
      [workspaceId, status],
    );
  }

  update(task: TaskRecord): void {
    this.db.run(
      `UPDATE tasks SET title = :title, description = :description, status = :status, priority = :priority,
         assignee_id = :assigneeId, due_date = :dueDate, labels = :labels, position = :position, document_id = :documentId,
         updated_at = :updatedAt
       WHERE id = :id`,
      {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        assigneeId: task.assigneeId,
        dueDate: task.dueDate,
        labels: JSON.stringify(task.labels),
        position: task.position,
        documentId: task.documentId,
        updatedAt: task.updatedAt,
      },
    );
  }

  /** Rewrites positions of a column as 1024, 2048, ... (used when gaps run out). */
  renumber(workspaceId: string, status: TaskStatus): void {
    const rows = this.columnPositions(workspaceId, status);
    this.db.transaction(() => {
      rows.forEach((r, i) => this.db.run("UPDATE tasks SET position = ? WHERE id = ?", [(i + 1) * 1024, r.id]));
    });
  }

  delete(id: string): boolean {
    return this.db.run("DELETE FROM tasks WHERE id = ?", [id]).changes === 1;
  }

  unassignInWorkspace(workspaceId: string, userId: string, at: string): string[] {
    const ids = this.db
      .all<{ id: string }>("SELECT id FROM tasks WHERE workspace_id = ? AND assignee_id = ?", [workspaceId, userId])
      .map((r) => r.id);
    this.db.run("UPDATE tasks SET assignee_id = NULL, updated_at = ? WHERE workspace_id = ? AND assignee_id = ?", [at, workspaceId, userId]);
    return ids;
  }
}
