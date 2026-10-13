import { can, type CommentDto, type Role } from "@rcp/shared";
import { useMemo, useState, type FormEvent } from "react";
import { errorMessage } from "../lib/api";
import { relativeTime } from "../lib/format";
import { Avatar, ErrorBanner } from "../components/ui";
import { useApp, useSessionUser } from "../state/app";

export interface Thread {
  readonly root: CommentDto;
  readonly replies: CommentDto[];
}

/** Groups flat comments into threads (root + chronologically ordered replies). */
export function buildThreads(comments: readonly CommentDto[]): Thread[] {
  const roots = comments.filter((c) => c.parentId === null);
  const byParent = new Map<string, CommentDto[]>();
  for (const c of comments) {
    if (!c.parentId) continue;
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  return roots
    .map((root) => ({ root, replies: (byParent.get(root.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }))
    .sort((a, b) => b.root.createdAt.localeCompare(a.root.createdAt));
}

interface Props {
  readonly documentId: string;
  readonly role: Role;
  readonly comments: readonly CommentDto[];
  readonly activeId: string | null;
  readonly selectionQuote: string | null;
  readonly orphaned: ReadonlySet<string>;
  readonly onActivate: (id: string | null) => void;
  readonly onCreate: (body: string, anchored: boolean) => Promise<void>;
  readonly onChanged: (comment: CommentDto) => void;
  readonly onDeleted: (id: string) => void;
}

export function CommentsPanel({ documentId, role, comments, activeId, selectionQuote, orphaned, onActivate, onCreate, onChanged, onDeleted }: Props) {
  const { api } = useApp();
  const me = useSessionUser();
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const [draft, setDraft] = useState("");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const threads = useMemo(() => buildThreads(comments), [comments]);
  const visible = threads.filter((t) => (filter === "open" ? !t.root.resolvedAt : Boolean(t.root.resolvedAt)));
  const canComment = can(role, "comment.create");

  const guard = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void guard(async () => {
      await onCreate(draft.trim(), selectionQuote !== null);
      setDraft("");
    });
  };

  return (
    <aside className="comments" aria-label="Comments">
      <div className="comments-header">
        <h2>Comments</h2>
        <div className="segmented small">
          <button type="button" className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>
            Open
          </button>
          <button type="button" className={filter === "resolved" ? "active" : ""} onClick={() => setFilter("resolved")}>
            Resolved
          </button>
        </div>
      </div>
      {canComment && (
        <form className="comment-form" onSubmit={submit}>
          {selectionQuote !== null && <blockquote className="quote">“{selectionQuote}”</blockquote>}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={selectionQuote !== null ? "Comment on the selected text… (@ to mention)" : "Add a comment… (select text to anchor it)"}
            rows={3}
            maxLength={5000}
          />
          <button type="submit" className="primary" disabled={!draft.trim()}>
            Comment
          </button>
        </form>
      )}
      <ErrorBanner message={error} />
      {visible.length === 0 && <p className="muted pad">No {filter} comments.</p>}
      <ul className="threads">
        {visible.map(({ root, replies }) => {
          const canResolve = can(role, "comment.resolve") || (root.author?.id === me?.id && canComment);
          return (
            <li
              key={root.id}
              className={`thread${activeId === root.id ? " active" : ""}`}
              onClick={() => onActivate(activeId === root.id ? null : root.id)}
            >
              {root.anchor && (
                <blockquote className={`quote${orphaned.has(root.id) ? " orphaned" : ""}`} title={orphaned.has(root.id) ? "The commented text was deleted" : undefined}>
                  “{root.anchor.quote}”
                </blockquote>
              )}
              {[root, ...replies].map((c) => (
                <div key={c.id} className="comment">
                  {c.author ? <Avatar userId={c.author.id} name={c.author.displayName} size={24} /> : <span className="avatar-placeholder" />}
                  <div className="comment-main">
                    <div className="comment-meta">
                      <strong>{c.author?.displayName ?? "Deleted user"}</strong>
                      <time className="muted small" dateTime={c.createdAt}>
                        {relativeTime(c.createdAt)}
                      </time>
                    </div>
                    <p className="comment-body">{renderMentions(c.body)}</p>
                    {(c.author?.id === me?.id || can(role, "comment.moderate")) && (
                      <button
                        type="button"
                        className="link-button small"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!window.confirm("Delete this comment?")) return;
                          void guard(async () => {
                            await api.deleteComment(c.id);
                            onDeleted(c.id);
                          });
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div className="thread-actions" onClick={(e) => e.stopPropagation()}>
                {canComment && !root.resolvedAt && (
                  <form
                    className="reply-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const body = (replyDrafts[root.id] ?? "").trim();
                      if (!body) return;
                      void guard(async () => {
                        onChanged(await api.createComment(documentId, body, { parentId: root.id }));
                        setReplyDrafts((d) => ({ ...d, [root.id]: "" }));
                      });
                    }}
                  >
                    <input
                      value={replyDrafts[root.id] ?? ""}
                      onChange={(e) => setReplyDrafts((d) => ({ ...d, [root.id]: e.target.value }))}
                      placeholder="Reply…"
                      aria-label="Reply"
                    />
                  </form>
                )}
                {canResolve && (
                  <button
                    type="button"
                    className="secondary small"
                    onClick={() => void guard(async () => onChanged(await api.setCommentResolved(root.id, !root.resolvedAt)))}
                  >
                    {root.resolvedAt ? "Reopen" : "Resolve"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/** Renders @mentions in bold without using innerHTML. */
function renderMentions(body: string) {
  const parts = body.split(/(@[A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_])/g);
  return parts.map((part, i) =>
    part.startsWith("@") ? (
      <strong key={i} className="mention">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
