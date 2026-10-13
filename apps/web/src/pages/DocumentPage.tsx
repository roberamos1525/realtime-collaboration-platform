import { can, type CommentDto, type PresencePeer, type Role } from "@rcp/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { CollaborativeEditor, type CommentRange, type EditorHandle } from "../components/CollaborativeEditor";
import { Avatar, ErrorBanner, Link, RoleBadge, Spinner } from "../components/ui";
import { errorMessage } from "../lib/api";
import { DocumentSync, type Selection, type SyncStatus } from "../lib/doc-sync";
import { navigate } from "../lib/router";
import { pushToast, useApp, useAsync, useRealtimeMessages, useWorkspaceSubscription } from "../state/app";
import { CommentsPanel } from "./CommentsPanel";
import { VersionsPanel } from "./VersionsPanel";

const CURSOR_THROTTLE_MS = 60;

const STATUS_TEXT: Record<SyncStatus, string> = {
  joining: "Connecting…",
  synced: "Saved",
  resyncing: "Resynchronising…",
  closed: "Closed",
  error: "Sync error",
};

export function DocumentPage({ documentId }: { documentId: string }) {
  const { api, realtime, toasts } = useApp();
  const meta = useAsync(() => api.getDocument(documentId), [documentId]);
  const comments = useAsync(() => api.listComments(documentId), [documentId]);
  const editor = useRef<EditorHandle>(null);
  const [text, setText] = useState<string | null>(null);
  const [peers, setPeers] = useState<PresencePeer[]>([]);
  const [status, setStatus] = useState<{ status: SyncStatus; detail?: string }>({ status: "joining" });
  const [role, setRole] = useState<Role | null>(null);
  const [title, setTitle] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [pending, setPending] = useState(0);
  const lastCursorSent = useRef(0);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sync = useMemo(
    () =>
      new DocumentSync(
        documentId,
        { send: (msg) => realtime.send(msg), rejoin: (id) => realtime.rejoin(id) },
        {
          onRemoteText: (next, sel) => {
            setText(next);
            editor.current?.setText(next, sel);
          },
          onPeers: setPeers,
          onStatus: (s, detail) => setStatus(detail ? { status: s, detail } : { status: s }),
          onRole: setRole,
          onTitle: setTitle,
        },
      ),
    [documentId, realtime],
  );

  useEffect(() => {
    const off = realtime.on((msg) => {
      sync.handle(msg);
      if (msg.type === "doc.ack" || msg.type === "doc.joined") setPending(sync.pendingCount);
    });
    const release = realtime.retainDoc(documentId);
    return () => {
      off();
      release();
      sync.dispose();
      if (cursorTimer.current) clearTimeout(cursorTimer.current);
    };
  }, [documentId, realtime, sync]);

  useEffect(() => {
    if (meta.data) setTitle(meta.data.title);
  }, [meta.data]);

  useEffect(() => {
    if (status.status === "error" && status.detail) pushToast(toasts, { title: "Document sync", body: status.detail, tone: "error" });
    if (status.status === "closed") pushToast(toasts, { title: "Document closed", body: status.detail ?? "", tone: "error" });
  }, [status, toasts]);

  useWorkspaceSubscription(meta.data?.workspaceId ?? null);
  useRealtimeMessages((msg) => {
    if (msg.type !== "workspace.event") return;
    const event = msg.event;
    if (event.kind === "comment.upserted" && event.comment.documentId === documentId) {
      comments.setData((prev) => [...(prev ?? []).filter((c) => c.id !== event.comment.id), event.comment]);
    } else if (event.kind === "comment.deleted" && event.documentId === documentId) {
      comments.setData((prev) => (prev ?? []).filter((c) => c.id !== event.commentId && c.parentId !== event.commentId));
    } else if (event.kind === "document.deleted" && event.documentId === documentId) {
      pushToast(toasts, { title: "Document deleted", tone: "error" });
      navigate(`/w/${msg.workspaceId}`);
    }
  });

  const effectiveRole = role ?? meta.data?.role ?? "viewer";
  const readOnly = !can(effectiveRole, "document.edit") || status.status !== "synced";

  const sendCursor = (sel: Selection | null) => {
    setSelection(sel);
    sync.setSelection(sel);
    const now = Date.now();
    if (cursorTimer.current) clearTimeout(cursorTimer.current);
    const wait = Math.max(0, CURSOR_THROTTLE_MS - (now - lastCursorSent.current));
    cursorTimer.current = setTimeout(() => {
      lastCursorSent.current = Date.now();
      sync.sendCursor(sel);
    }, wait);
  };

  const commentRanges: CommentRange[] = useMemo(() => {
    if (text === null) return [];
    const ranges: CommentRange[] = [];
    for (const c of comments.data ?? []) {
      if (!c.anchor || c.parentId || c.resolvedAt) continue;
      const range = sync.resolveRange(c.anchor.start, c.anchor.end);
      if (range && range.end > range.start) ranges.push({ id: c.id, start: range.start, end: range.end, active: c.id === activeComment });
    }
    return ranges;
  }, [comments.data, text, sync, activeComment]);

  const orphaned = useMemo(() => {
    const visible = new Set(commentRanges.map((r) => r.id));
    return new Set((comments.data ?? []).filter((c) => c.anchor && !c.parentId && !visible.has(c.id)).map((c) => c.id));
  }, [comments.data, commentRanges]);

  const selectionQuote = selection && selection.end > selection.start && text ? text.slice(selection.start, selection.end).slice(0, 300) : null;

  const createComment = async (body: string, anchored: boolean) => {
    const range = anchored && selection ? sync.anchorRange(selection) : null;
    const created: CommentDto = await api.createComment(
      documentId,
      body,
      range && selectionQuote !== null ? { anchor: { ...range, quote: selectionQuote } } : {},
    );
    comments.setData((prev) => [...(prev ?? []).filter((c) => c.id !== created.id), created]);
    setActiveComment(created.id);
  };

  const rename = async () => {
    const next = title.trim();
    if (!meta.data || !next || next === meta.data.title) return;
    try {
      const updated = await api.renameDocument(documentId, next);
      meta.setData((prev) => (prev ? { ...prev, title: updated.title } : prev));
    } catch (err) {
      pushToast(toasts, { title: "Rename failed", body: errorMessage(err), tone: "error" });
      setTitle(meta.data.title);
    }
  };

  const removeDocument = async () => {
    if (!meta.data || !window.confirm(`Delete “${meta.data.title}”? This cannot be undone from the UI.`)) return;
    try {
      await api.deleteDocument(documentId);
      navigate(`/w/${meta.data.workspaceId}`);
    } catch (err) {
      pushToast(toasts, { title: "Delete failed", body: errorMessage(err), tone: "error" });
    }
  };

  if (meta.error) {
    return (
      <div className="page">
        <ErrorBanner message={meta.error} onRetry={meta.reload} />
        <Link to="/">Back to workspaces</Link>
      </div>
    );
  }
  if (!meta.data) return <Spinner />;

  const uniquePeers = [...new Map(peers.map((p) => [p.userId, p])).values()];

  return (
    <div className="doc-page">
      <div className="doc-header">
        <div className="doc-title-block">
          <div className="breadcrumbs">
            <Link to={`/w/${meta.data.workspaceId}`}>← Workspace</Link>
          </div>
          <input
            className="doc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            readOnly={!can(effectiveRole, "document.rename")}
            aria-label="Document title"
            maxLength={200}
          />
        </div>
        <div className="doc-toolbar">
          <div className="presence" aria-label="People in this document">
            {uniquePeers.map((p) => (
              <span key={p.userId} className="presence-avatar" style={{ boxShadow: `0 0 0 2px ${p.color}` }}>
                <Avatar userId={p.userId} name={p.displayName} size={28} title={`${p.displayName} is here`} />
              </span>
            ))}
          </div>
          <span className={`sync-status sync-${status.status}`} title={status.detail}>
            {status.status === "synced" && pending > 0 ? "Saving…" : STATUS_TEXT[status.status]}
          </span>
          <RoleBadge role={effectiveRole} />
          <button type="button" className="secondary" onClick={() => setShowVersions(true)}>
            History
          </button>
          {can(effectiveRole, "document.delete") && (
            <button type="button" className="danger-link" onClick={() => void removeDocument()}>
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="doc-body">
        <div className="doc-editor-pane">
          {text === null ? (
            <Spinner label="Loading document…" />
          ) : (
            <CollaborativeEditor
              ref={editor}
              sync={sync}
              text={text}
              peers={peers}
              comments={commentRanges}
              readOnly={readOnly}
              onLocalChange={(next) => {
                setText(next);
                setPending(sync.pendingCount);
              }}
              onSelection={sendCursor}
            />
          )}
          {!can(effectiveRole, "document.edit") && <p className="muted small pad">You have {effectiveRole} access: editing is disabled.</p>}
        </div>
        <CommentsPanel
          documentId={documentId}
          role={effectiveRole}
          comments={comments.data ?? []}
          activeId={activeComment}
          selectionQuote={selectionQuote}
          orphaned={orphaned}
          onActivate={(id) => {
            setActiveComment(id);
            const range = commentRanges.find((r) => r.id === id);
            if (range) editor.current?.focusRange(range.start, range.end);
          }}
          onCreate={createComment}
          onChanged={(c) => comments.setData((prev) => [...(prev ?? []).filter((x) => x.id !== c.id), c])}
          onDeleted={(id) => comments.setData((prev) => (prev ?? []).filter((c) => c.id !== id && c.parentId !== id))}
        />
      </div>
      {showVersions && <VersionsPanel documentId={documentId} role={effectiveRole} onClose={() => setShowVersions(false)} />}
    </div>
  );
}
