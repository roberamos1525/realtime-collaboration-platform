import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  can,
  type MemberDto,
  type TaskDto,
  type TaskPriority,
  type TaskStatus,
  type WorkspaceDto,
} from "@rcp/shared";
import { useMemo, useState, type DragEvent, type FormEvent } from "react";
import { errorMessage, type TaskInput } from "../lib/api";
import { STATUS_LABELS } from "../lib/format";
import { Avatar, ErrorBanner, Link, Modal, Spinner } from "../components/ui";
import { pushToast, useApp, useAsync, useRealtimeMessages } from "../state/app";

/** Orders tasks into board columns by position. */
export function groupTasks(tasks: readonly TaskDto[]): Record<TaskStatus, TaskDto[]> {
  const columns = { todo: [], in_progress: [], review: [], done: [] } as Record<TaskStatus, TaskDto[]>;
  for (const t of tasks) columns[t.status].push(t);
  for (const s of TASK_STATUSES) columns[s].sort((a, b) => a.position - b.position);
  return columns;
}

/** Local optimistic position for a task dropped before `beforeId`. */
export function optimisticPosition(column: readonly TaskDto[], beforeId: string | null, movingId: string): number {
  const others = column.filter((t) => t.id !== movingId);
  if (beforeId === null) return (others.at(-1)?.position ?? 0) + 1024;
  const index = others.findIndex((t) => t.id === beforeId);
  if (index < 0) return (others.at(-1)?.position ?? 0) + 1024;
  const after = others[index] as TaskDto;
  const prev = index > 0 ? (others[index - 1] as TaskDto).position : after.position - 2048;
  return (prev + after.position) / 2;
}

function isOverdue(task: TaskDto): boolean {
  if (!task.dueDate || task.status === "done") return false;
  return task.dueDate < new Date().toISOString().slice(0, 10);
}

export function TaskBoard({ workspace, members }: { workspace: WorkspaceDto; members: MemberDto[] }) {
  const { api, toasts } = useApp();
  const tasks = useAsync(() => api.listTasks(workspace.id), [workspace.id]);
  const [editing, setEditing] = useState<TaskDto | "new" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [filter, setFilter] = useState({ text: "", assignee: "", label: "" });
  const canWrite = can(workspace.role, "task.write");

  useRealtimeMessages((msg) => {
    if (msg.type !== "workspace.event" || msg.workspaceId !== workspace.id) return;
    const event = msg.event;
    if (event.kind === "task.upserted") {
      tasks.setData((prev) => [...(prev ?? []).filter((t) => t.id !== event.task.id), event.task]);
    } else if (event.kind === "task.deleted") {
      tasks.setData((prev) => (prev ?? []).filter((t) => t.id !== event.taskId));
    }
  });

  const labels = useMemo(() => [...new Set((tasks.data ?? []).flatMap((t) => t.labels))].sort(), [tasks.data]);
  const visible = useMemo(() => {
    const text = filter.text.trim().toLowerCase();
    return (tasks.data ?? []).filter(
      (t) =>
        (!text || t.title.toLowerCase().includes(text) || t.description.toLowerCase().includes(text)) &&
        (!filter.assignee || (filter.assignee === "none" ? !t.assignee : t.assignee?.id === filter.assignee)) &&
        (!filter.label || t.labels.includes(filter.label)),
    );
  }, [tasks.data, filter]);
  const columns = groupTasks(visible);

  const move = async (taskId: string, status: TaskStatus, beforeId: string | null) => {
    const all = tasks.data ?? [];
    const task = all.find((t) => t.id === taskId);
    if (!task || beforeId === taskId) return;
    const position = optimisticPosition(groupTasks(all)[status], beforeId, taskId);
    tasks.setData((prev) => (prev ?? []).map((t) => (t.id === taskId ? { ...t, status, position } : t)));
    try {
      const saved = await api.moveTask(taskId, status, beforeId);
      tasks.setData((prev) => (prev ?? []).map((t) => (t.id === taskId ? saved : t)));
    } catch (err) {
      pushToast(toasts, { title: "Move failed", body: errorMessage(err), tone: "error" });
      tasks.reload();
    }
  };

  const onDrop = (e: DragEvent, status: TaskStatus, beforeId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const id = e.dataTransfer.getData("text/plain") || dragId;
    setDragId(null);
    if (id) void move(id, status, beforeId);
  };

  if (tasks.error) return <ErrorBanner message={tasks.error} onRetry={tasks.reload} />;
  if (!tasks.data) return <Spinner />;

  return (
    <section>
      <div className="section-header">
        <h2>Tasks</h2>
        {canWrite && (
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            New task
          </button>
        )}
      </div>
      <div className="filters">
        <input placeholder="Filter tasks…" value={filter.text} onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))} aria-label="Filter tasks" />
        <select value={filter.assignee} onChange={(e) => setFilter((f) => ({ ...f, assignee: e.target.value }))} aria-label="Assignee filter">
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {members.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.displayName}
            </option>
          ))}
        </select>
        <select value={filter.label} onChange={(e) => setFilter((f) => ({ ...f, label: e.target.value }))} aria-label="Label filter">
          <option value="">All labels</option>
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="board">
        {TASK_STATUSES.map((status) => (
          <div
            key={status}
            className={`column${dragId ? " droppable" : ""}`}
            onDragOver={(e) => canWrite && e.preventDefault()}
            onDrop={(e) => canWrite && onDrop(e, status, null)}
          >
            <header className="column-header">
              <span>{STATUS_LABELS[status]}</span>
              <span className="count-pill">{columns[status].length}</span>
            </header>
            <ul className="column-cards">
              {columns[status].map((task) => (
                <li
                  key={task.id}
                  className={`task-card priority-${task.priority}${dragId === task.id ? " dragging" : ""}`}
                  draggable={canWrite}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", task.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragId(task.id);
                  }}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => canWrite && e.preventDefault()}
                  onDrop={(e) => canWrite && onDrop(e, status, task.id)}
                >
                  <button type="button" className="task-open" onClick={() => setEditing(task)}>
                    <span className="task-title">{task.title}</span>
                    <span className="task-meta">
                      <span className={`priority priority-${task.priority}`}>{task.priority}</span>
                      {task.dueDate && <span className={isOverdue(task) ? "due overdue" : "due"}>{task.dueDate}</span>}
                      {task.labels.map((l) => (
                        <span key={l} className="label">
                          {l}
                        </span>
                      ))}
                    </span>
                  </button>
                  <div className="task-footer">
                    {task.documentId ? <Link to={`/d/${task.documentId}`}>Linked doc</Link> : <span />}
                    {task.assignee && <Avatar userId={task.assignee.id} name={task.assignee.displayName} size={22} />}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {editing && (
        <TaskModal
          workspace={workspace}
          members={members}
          task={editing === "new" ? null : editing}
          readOnly={!canWrite}
          onClose={() => setEditing(null)}
          onSaved={(task) => {
            tasks.setData((prev) => [...(prev ?? []).filter((t) => t.id !== task.id), task]);
            setEditing(null);
          }}
          onDeleted={(id) => {
            tasks.setData((prev) => (prev ?? []).filter((t) => t.id !== id));
            setEditing(null);
          }}
        />
      )}
    </section>
  );
}

function TaskModal({
  workspace,
  members,
  task,
  readOnly,
  onClose,
  onSaved,
  onDeleted,
}: {
  workspace: WorkspaceDto;
  members: MemberDto[];
  task: TaskDto | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: (task: TaskDto) => void;
  onDeleted: (id: string) => void;
}) {
  const { api } = useApp();
  const docs = useAsync(() => api.listDocuments(workspace.id), [workspace.id]);
  const [form, setForm] = useState({
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.status ?? ("todo" as TaskStatus),
    priority: task?.priority ?? ("medium" as TaskPriority),
    assigneeId: task?.assignee?.id ?? "",
    dueDate: task?.dueDate ?? "",
    labels: task?.labels.join(", ") ?? "",
    documentId: task?.documentId ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input: TaskInput = {
      title: form.title.trim(),
      description: form.description,
      status: form.status,
      priority: form.priority,
      assigneeId: form.assigneeId || null,
      dueDate: form.dueDate || null,
      labels: form.labels
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean),
      documentId: form.documentId || null,
    };
    try {
      onSaved(task ? await api.updateTask(task.id, input) : await api.createTask(workspace.id, input));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!task || !window.confirm("Delete this task?")) return;
    try {
      await api.deleteTask(task.id);
      onDeleted(task.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={task ? "Edit task" : "New task"} onClose={onClose} wide>
      <form className="form" onSubmit={(e) => void save(e)}>
        <fieldset disabled={readOnly || busy}>
          <label>
            Title
            <input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={200} required />
          </label>
          <label>
            Description
            <textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={4} maxLength={10_000} />
          </label>
          <div className="row">
            <label>
              Status
              <select value={form.status} onChange={(e) => set("status", e.target.value as TaskStatus)}>
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Priority
              <select value={form.priority} onChange={(e) => set("priority", e.target.value as TaskPriority)}>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label>
              Assignee
              <select value={form.assigneeId} onChange={(e) => set("assigneeId", e.target.value)}>
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Due date
              <input type="date" value={form.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
            </label>
          </div>
          <label>
            Labels (comma separated)
            <input value={form.labels} onChange={(e) => set("labels", e.target.value)} placeholder="bug, frontend" />
          </label>
          <label>
            Linked document
            <select value={form.documentId} onChange={(e) => set("documentId", e.target.value)}>
              <option value="">None</option>
              {docs.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <ErrorBanner message={error} />
        <div className="form-actions">
          {task && !readOnly && (
            <button type="button" className="danger" onClick={() => void remove()}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button type="submit" className="primary" disabled={busy || !form.title.trim()}>
              {task ? "Save" : "Create"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
