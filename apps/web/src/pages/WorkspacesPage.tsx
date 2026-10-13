import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { EmptyState, ErrorBanner, Link, Modal, RoleBadge, Spinner } from "../components/ui";
import { useApp, useAsync } from "../state/app";

export function WorkspacesPage() {
  const { api } = useApp();
  const workspaces = useAsync(() => api.listWorkspaces(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const ws = await api.createWorkspace(name.trim(), description.trim());
      navigate(`/w/${ws.id}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Workspaces</h1>
          <p className="muted">Spaces you belong to and your role in each.</p>
        </div>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          New workspace
        </button>
      </div>
      <ErrorBanner message={workspaces.error} onRetry={workspaces.reload} />
      {workspaces.loading && !workspaces.data && <Spinner />}
      {workspaces.data?.length === 0 && (
        <EmptyState title="No workspaces yet">Create one to start writing documents and tracking tasks with your team.</EmptyState>
      )}
      <div className="card-grid">
        {workspaces.data?.map((ws) => (
          <Link key={ws.id} to={`/w/${ws.id}`} className="card workspace-card">
            <div className="card-title">
              <strong>{ws.name}</strong>
              <RoleBadge role={ws.role} />
            </div>
            <p className="muted clamp-2">{ws.description || "No description"}</p>
            <div className="card-meta">
              <span>
                {ws.memberCount} member{ws.memberCount === 1 ? "" : "s"}
              </span>
              <span>Updated {relativeTime(ws.updatedAt)}</span>
            </div>
          </Link>
        ))}
      </div>
      {creating && (
        <Modal title="New workspace" onClose={() => setCreating(false)}>
          <form className="form" onSubmit={(e) => void create(e)}>
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={80} required />
            </label>
            <label>
              Description
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} />
            </label>
            <ErrorBanner message={error} />
            <div className="form-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={name.trim().length < 2}>
                Create
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
