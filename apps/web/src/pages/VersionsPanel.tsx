import { can, type Role, type VersionDetailDto } from "@rcp/shared";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import { ErrorBanner, Modal, Spinner } from "../components/ui";
import { useApp, useAsync } from "../state/app";

/** Version history: save named versions, preview them and restore. */
export function VersionsPanel({ documentId, role, onClose }: { documentId: string; role: Role; onClose: () => void }) {
  const { api } = useApp();
  const versions = useAsync(() => api.listVersions(documentId), [documentId]);
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<VersionDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.createVersion(documentId, label.trim());
      setLabel("");
      versions.reload();
    });
  };

  return (
    <Modal title="Version history" onClose={onClose} wide>
      {can(role, "version.create") && (
        <form className="inline-form" onSubmit={save}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Version name, e.g. “Sent for review”" maxLength={120} aria-label="Version name" />
          <button type="submit" className="primary" disabled={busy || !label.trim()}>
            Save version
          </button>
        </form>
      )}
      <ErrorBanner message={versions.error ?? error} />
      {versions.loading && !versions.data && <Spinner />}
      <div className="versions">
        <ul className="version-list">
          {versions.data?.length === 0 && <li className="muted">No saved versions yet.</li>}
          {versions.data?.map((v) => (
            <li key={v.id}>
              <button
                type="button"
                className={preview?.id === v.id ? "version active" : "version"}
                onClick={() => void run(async () => setPreview(await api.getVersion(documentId, v.id)))}
              >
                <strong>{v.label}</strong>
                <span className="muted small">
                  {v.createdBy?.displayName ?? "Unknown"} · {relativeTime(v.createdAt)} · {v.length} chars
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="version-preview">
          {preview ? (
            <>
              <pre>{preview.text || "(empty)"}</pre>
              {can(role, "version.restore") && (
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!window.confirm(`Restore “${preview.label}”? The current text is saved as a version first.`)) return;
                      await api.restoreVersion(documentId, preview.id);
                      onClose();
                    })
                  }
                >
                  Restore this version
                </button>
              )}
            </>
          ) : (
            <p className="muted">Select a version to preview it.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
