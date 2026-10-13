import type { ActivityDto } from "@rcp/shared";
import { useState } from "react";
import { errorMessage } from "../lib/api";
import { describeActivity, relativeTime } from "../lib/format";
import { Avatar, EmptyState, ErrorBanner, Link, Spinner } from "../components/ui";
import { useApp, useAsync, useRealtimeMessages } from "../state/app";

/** Workspace activity with live prepending and cursor-based "load more". */
export function ActivityFeed({ workspaceId }: { workspaceId: string }) {
  const { api } = useApp();
  const first = useAsync(() => api.activity(workspaceId), [workspaceId]);
  const [older, setOlder] = useState<ActivityDto[]>([]);
  const [live, setLive] = useState<ActivityDto[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useRealtimeMessages((msg) => {
    if (msg.type === "workspace.event" && msg.workspaceId === workspaceId && msg.event.kind === "activity") {
      const activity = msg.event.activity;
      setLive((prev) => (prev.some((a) => a.id === activity.id) ? prev : [activity, ...prev].slice(0, 100)));
    }
  });

  const nextCursor = cursor === undefined ? (first.data?.nextCursor ?? null) : cursor;
  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const page = await api.activity(workspaceId, nextCursor);
      setOlder((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const seen = new Set<number>();
  const items = [...live, ...(first.data?.items ?? []), ...older].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));

  return (
    <section>
      <div className="section-header">
        <h2>Activity</h2>
      </div>
      <ErrorBanner message={first.error ?? error} onRetry={first.reload} />
      {first.loading && !first.data && <Spinner />}
      {first.data && items.length === 0 && <EmptyState title="No activity yet" />}
      <ol className="timeline">
        {items.map((a) => (
          <li key={a.id} className="timeline-item">
            {a.actor ? <Avatar userId={a.actor.id} name={a.actor.displayName} size={30} /> : <span className="avatar-placeholder" />}
            <div>
              <div>
                <strong>{a.actor?.displayName ?? "Someone"}</strong> {describeActivity(a.verb, a.meta)}
                {a.documentId && a.verb !== "document.deleted" && (
                  <>
                    {" "}
                    · <Link to={`/d/${a.documentId}`}>open</Link>
                  </>
                )}
              </div>
              <time className="muted small" dateTime={a.createdAt}>
                {relativeTime(a.createdAt)}
              </time>
            </div>
          </li>
        ))}
      </ol>
      {nextCursor && (
        <button type="button" className="secondary block" onClick={() => void loadMore()}>
          Load older activity
        </button>
      )}
    </section>
  );
}
