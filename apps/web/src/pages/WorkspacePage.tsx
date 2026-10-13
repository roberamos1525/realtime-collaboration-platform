import { can, type DocumentDto, type WorkspaceDto } from "@rcp/shared";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { Avatar, EmptyState, ErrorBanner, Link, Modal, RoleBadge, Spinner } from "../components/ui";
import { useApp, useAsync, useRealtimeMessages, useWorkspaceSubscription } from "../state/app";
import { ActivityFeed } from "./ActivityFeed";
import { MembersPanel } from "./MembersPanel";
import { TaskBoard } from "./TaskBoard";

export type WorkspaceTab = "documents" | "tasks" | "activity" | "members";

const TABS: Array<{ id: WorkspaceTab; label: string; path: string }> = [
  { id: "documents", label: "Documents", path: "" },
  { id: "tasks", label: "Tasks", path: "/tasks" },
  { id: "activity", label: "Activity", path: "/activity" },
  { id: "members", label: "Members", path: "/members" },
];

export function WorkspacePage({ workspaceId, tab }: { workspaceId: string; tab: WorkspaceTab }) {
  const { api } = useApp();
  const workspace = useAsync(() => api.getWorkspace(workspaceId), [workspaceId]);
  const members = useAsync(() => api.listMembers(workspaceId), [workspaceId]);
  const [online, setOnline] = useState<string[]>([]);
  useWorkspaceSubscription(workspaceId);
  useRealtimeMessages((msg) => {
    if (msg.type === "workspace.online" && msg.workspaceId === workspaceId) setOnline(msg.userIds);
    if (msg.type === "workspace.event" && msg.workspaceId === workspaceId && msg.event.kind === "members.changed") {
      members.reload();
      workspace.reload();
    }
  });

  if (workspace.error) {
    return (
      <div className="page">
        <ErrorBanner message={workspace.error} onRetry={workspace.reload} />
        <Link to="/">Back to workspaces</Link>
      </div>
    );
  }
  if (!workspace.data) return <Spinner />;
  const ws = workspace.data;
  const memberList = members.data ?? [];
  const onlineMembers = memberList.filter((m) => online.includes(m.user.id));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="breadcrumbs">
            <Link to="/">Workspaces</Link> <span aria-hidden="true">/</span>
          </div>
          <h1>
            {ws.name} <RoleBadge role={ws.role} />
          </h1>
          {ws.description && <p className="muted">{ws.description}</p>}
        </div>
        <div className="online" aria-label="Online members">
          {onlineMembers.map((m) => (
            <Avatar key={m.user.id} userId={m.user.id} name={m.user.displayName} title={`${m.user.displayName} is online`} />
          ))}
          {onlineMembers.length > 0 && <span className="muted small">{onlineMembers.length} online</span>}
        </div>
      </div>
      <nav className="tabs" aria-label="Workspace sections">
        {TABS.map((t) => (
          <Link key={t.id} to={`/w/${workspaceId}${t.path}`} className={t.id === tab ? "tab active" : "tab"}>
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === "documents" && <DocumentsTab workspace={ws} />}
      {tab === "tasks" && <TaskBoard workspace={ws} members={memberList} />}
      {tab === "activity" && <ActivityFeed workspaceId={workspaceId} />}
      {tab === "members" && <MembersPanel workspace={ws} members={memberList} onChanged={members.reload} onLeft={() => navigate("/")} />}
    </div>
  );
}

function DocumentsTab({ workspace }: { workspace: WorkspaceDto }) {
  const { api } = useApp();
  const docs = useAsync(() => api.listDocuments(workspace.id), [workspace.id]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useRealtimeMessages((msg) => {
    if (msg.type !== "workspace.event" || msg.workspaceId !== workspace.id) return;
    const event = msg.event;
    if (event.kind === "document.upserted") {
      docs.setData((prev) => {
        const list = prev ?? [];
        const rest = list.filter((d) => d.id !== event.document.id);
        return [event.document, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    } else if (event.kind === "document.deleted") {
      docs.setData((prev) => (prev ?? []).filter((d) => d.id !== event.documentId));
    }
  });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const doc = await api.createDocument(workspace.id, title.trim());
      navigate(`/d/${doc.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const canCreate = can(workspace.role, "document.create");
  return (
    <section>
      <div className="section-header">
        <h2>Documents</h2>
        {canCreate && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            New document
          </button>
        )}
      </div>
      <ErrorBanner message={docs.error} onRetry={docs.reload} />
      {docs.loading && !docs.data && <Spinner />}
      {docs.data?.length === 0 && <EmptyState title="No documents yet">{canCreate ? "Create the first one." : "Nothing to read here yet."}</EmptyState>}
      <ul className="doc-list">
        {docs.data?.map((d: DocumentDto) => (
          <li key={d.id}>
            <Link to={`/d/${d.id}`} className="doc-row">
              <span className="doc-icon" aria-hidden="true" />
              <span className="doc-main">
                <strong>{d.title}</strong>
                <span className="muted clamp-1">{d.excerpt || "Empty document"}</span>
              </span>
              <time className="muted small" dateTime={d.updatedAt}>
                {relativeTime(d.updatedAt)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
      {creating && (
        <Modal title="New document" onClose={() => setCreating(false)}>
          <form className="form" onSubmit={(e) => void create(e)}>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
            </label>
            <ErrorBanner message={error} />
            <div className="form-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!title.trim()}>
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
