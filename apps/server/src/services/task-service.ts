import { can, type TaskDto, type TaskPriority, type TaskStatus } from "@rcp/shared";
import { badRequest, forbidden, notFound } from "../core/errors.js";
import { iso, newId } from "../core/util.js";
import type { TaskFilter, TaskRecord } from "../repositories/tasks.js";
import { toPublicUser } from "../repositories/users.js";
import type { ActivityService } from "./activity-service.js";
import type { AccessControl, ServiceDeps } from "./context.js";
import type { NotificationService } from "./notification-service.js";

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly labels: string[];
  readonly documentId: string | null;
}

export type UpdateTaskInput = Partial<CreateTaskInput>;

const POSITION_STEP = 1024;
const MIN_GAP = 1e-6;

/**
 * Kanban tasks. Ordering inside a column uses fractional positions so a move
 * touches a single row; when the gap between neighbours becomes too small the
 * column is renumbered.
 */
export class TaskService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly access: AccessControl,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
  ) {}

  list(userId: string, workspaceId: string, filter: TaskFilter): TaskDto[] {
    this.access.requireWorkspace(userId, workspaceId, "task.read");
    return this.toDtos(this.deps.repos.tasks.list(workspaceId, filter));
  }

  get(userId: string, taskId: string): TaskDto {
    const task = this.requireTask(userId, taskId, "task.read");
    return this.toDtos([task])[0] as TaskDto;
  }

  create(userId: string, workspaceId: string, input: CreateTaskInput): TaskDto {
    const { workspace } = this.access.requireWorkspace(userId, workspaceId, "task.write");
    this.validateRefs(workspaceId, input.assigneeId, input.documentId);
    const now = iso(this.deps.clock.now());
    const column = this.deps.repos.tasks.columnPositions(workspaceId, input.status);
    const task: TaskRecord = {
      id: newId("tsk"),
      workspaceId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId,
      dueDate: input.dueDate,
      labels: input.labels,
      position: (column.at(-1)?.position ?? 0) + POSITION_STEP,
      documentId: input.documentId,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repos.tasks.insert(task);
    this.activity.record({ workspaceId, actorId: userId, verb: "task.created", targetType: "task", targetId: task.id, meta: { title: task.title } });
    if (task.assigneeId) this.notifyAssignee(task, userId, workspace.name);
    return this.emit(task);
  }

  update(userId: string, taskId: string, patch: UpdateTaskInput): TaskDto {
    const current = this.requireTask(userId, taskId, "task.write");
    if (patch.assigneeId !== undefined || patch.documentId !== undefined) {
      this.validateRefs(current.workspaceId, patch.assigneeId ?? null, patch.documentId ?? null);
    }
    let position = current.position;
    if (patch.status && patch.status !== current.status) {
      const column = this.deps.repos.tasks.columnPositions(current.workspaceId, patch.status);
      position = (column.at(-1)?.position ?? 0) + POSITION_STEP;
    }
    const next: TaskRecord = {
      ...current,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      position,
      updatedAt: iso(this.deps.clock.now()),
    };
    this.deps.repos.tasks.update(next);
    const changed = Object.keys(patch).filter((k) => patch[k as keyof UpdateTaskInput] !== undefined);
    this.activity.record({
      workspaceId: current.workspaceId,
      actorId: userId,
      verb: patch.status && patch.status !== current.status ? "task.status_changed" : "task.updated",
      targetType: "task",
      targetId: taskId,
      meta: { title: next.title, fields: changed, ...(patch.status ? { from: current.status, to: patch.status } : {}) },
    });
    if (next.assigneeId && next.assigneeId !== current.assigneeId) {
      const ws = this.deps.repos.workspaces.findById(current.workspaceId);
      this.notifyAssignee(next, userId, ws?.name ?? "workspace");
    }
    return this.emit(next);
  }

  /** Moves a task to `status`, directly before `beforeId` (or to the end). */
  move(userId: string, taskId: string, status: TaskStatus, beforeId: string | null): TaskDto {
    const current = this.requireTask(userId, taskId, "task.write");
    if (beforeId === taskId) throw badRequest("a task cannot be placed before itself");
    const position = this.positionFor(current.workspaceId, status, beforeId, taskId);
    const next: TaskRecord = { ...current, status, position, updatedAt: iso(this.deps.clock.now()) };
    this.deps.repos.tasks.update(next);
    if (status !== current.status) {
      this.activity.record({
        workspaceId: current.workspaceId,
        actorId: userId,
        verb: "task.status_changed",
        targetType: "task",
        targetId: taskId,
        meta: { title: current.title, from: current.status, to: status },
      });
    }
    return this.emit(next);
  }

  delete(userId: string, taskId: string): void {
    const task = this.requireTask(userId, taskId, "task.read");
    const role = this.access.roleIn(task.workspaceId, userId);
    // Editors may delete tasks they created; otherwise admin rights are needed.
    const ownTask = task.createdBy === userId && can(role, "task.write");
    if (!ownTask && !can(role, "task.delete")) throw forbidden("only admins can delete tasks created by others");
    this.deps.repos.tasks.delete(taskId);
    this.activity.record({ workspaceId: task.workspaceId, actorId: userId, verb: "task.deleted", targetType: "task", targetId: taskId, meta: { title: task.title } });
    this.deps.events.emit({ type: "task.deleted", taskId, workspaceId: task.workspaceId });
  }

  /** Clears assignments of a departing member; returns how many tasks changed. */
  unassignMember(workspaceId: string, userId: string): number {
    const ids = this.deps.repos.tasks.unassignInWorkspace(workspaceId, userId, iso(this.deps.clock.now()));
    for (const id of ids) {
      const task = this.deps.repos.tasks.findById(id);
      if (task) this.emit(task);
    }
    return ids.length;
  }

  private positionFor(workspaceId: string, status: TaskStatus, beforeId: string | null, movingId: string): number {
    let column = this.deps.repos.tasks.columnPositions(workspaceId, status).filter((t) => t.id !== movingId);
    if (beforeId === null) return (column.at(-1)?.position ?? 0) + POSITION_STEP;
    let index = column.findIndex((t) => t.id === beforeId);
    if (index < 0) throw badRequest("beforeId is not in the target column");
    const compute = (): number => {
      const after = column[index] as { position: number };
      const prev = index > 0 ? (column[index - 1] as { position: number }).position : after.position - 2 * POSITION_STEP;
      return (prev + after.position) / 2;
    };
    let position = compute();
    const neighbourGap = index > 0 ? (column[index] as { position: number }).position - (column[index - 1] as { position: number }).position : Infinity;
    if (neighbourGap < MIN_GAP) {
      this.deps.repos.tasks.renumber(workspaceId, status);
      column = this.deps.repos.tasks.columnPositions(workspaceId, status).filter((t) => t.id !== movingId);
      index = column.findIndex((t) => t.id === beforeId);
      position = compute();
    }
    return position;
  }

  private requireTask(userId: string, taskId: string, action: "task.read" | "task.write"): TaskRecord {
    const task = this.deps.repos.tasks.findById(taskId);
    if (!task || !this.access.roleIn(task.workspaceId, userId)) throw notFound("task");
    this.access.requireWorkspace(userId, task.workspaceId, action);
    return task;
  }

  private validateRefs(workspaceId: string, assigneeId: string | null, documentId: string | null): void {
    if (assigneeId && !this.deps.repos.workspaces.roleOf(workspaceId, assigneeId)) {
      throw badRequest("assignee must be a member of the workspace");
    }
    if (documentId) {
      const doc = this.deps.repos.documents.findById(documentId);
      if (!doc || doc.workspaceId !== workspaceId) throw badRequest("linked document must belong to the workspace");
    }
  }

  private notifyAssignee(task: TaskRecord, actorId: string, workspaceName: string): void {
    if (!task.assigneeId) return;
    this.notifications.notify({
      userId: task.assigneeId,
      kind: "task_assigned",
      title: `Task assigned: ${task.title}`,
      body: `In ${workspaceName}${task.dueDate ? ` · due ${task.dueDate}` : ""}`,
      actorId,
      workspaceId: task.workspaceId,
      entityId: task.id,
      documentId: task.documentId,
    });
  }

  private emit(task: TaskRecord): TaskDto {
    const dto = this.toDtos([task])[0] as TaskDto;
    this.deps.events.emit({ type: "task.upserted", task: dto });
    return dto;
  }

  private toDtos(tasks: TaskRecord[]): TaskDto[] {
    const users = this.deps.repos.users.findManyByIds(tasks.map((t) => t.assigneeId).filter((id): id is string => id !== null));
    return tasks.map((t) => {
      const assignee = t.assigneeId ? users.get(t.assigneeId) : undefined;
      return {
        id: t.id,
        workspaceId: t.workspaceId,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        assignee: assignee ? toPublicUser(assignee) : null,
        dueDate: t.dueDate,
        labels: t.labels,
        position: t.position,
        documentId: t.documentId,
        createdBy: t.createdBy,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    });
  }
}
