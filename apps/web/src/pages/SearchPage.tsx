import { SEARCH_TYPES, type SearchHit, type SearchType } from "@rcp/shared";
import { useState } from "react";
import { relativeTime } from "../lib/format";
import { EmptyState, ErrorBanner, Link, Spinner } from "../components/ui";
import { useApp, useAsync } from "../state/app";

const TYPE_LABEL: Record<SearchType, string> = { document: "Document", comment: "Comment", task: "Task" };

/** Splits a snippet into plain and highlighted parts using hit ranges. */
export function highlightParts(snippet: string, ranges: ReadonlyArray<readonly [number, number]>): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let pos = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < pos || end > snippet.length || end <= start) continue;
    if (start > pos) parts.push({ text: snippet.slice(pos, start), hit: false });
    parts.push({ text: snippet.slice(start, end), hit: true });
    pos = end;
  }
  if (pos < snippet.length) parts.push({ text: snippet.slice(pos), hit: false });
  return parts;
}

function hitLink(hit: SearchHit): string {
  if (hit.type === "task") return `/w/${hit.workspaceId}/tasks`;
  return `/d/${hit.documentId ?? hit.id}`;
}

export function SearchPage({ query }: { query: string }) {
  const { api } = useApp();
  const [types, setTypes] = useState<SearchType[]>([...SEARCH_TYPES]);
  const workspaces = useAsync(() => api.listWorkspaces(), []);
  const [workspaceId, setWorkspaceId] = useState("");
  const results = useAsync(
    () => (query.trim() ? api.search(query, { types, ...(workspaceId ? { workspaceId } : {}) }) : Promise.resolve([])),
    [query, types.join(","), workspaceId],
  );
  const wsName = new Map((workspaces.data ?? []).map((w) => [w.id, w.name]));

  const toggle = (t: SearchType) =>
    setTypes((prev) => (prev.includes(t) ? (prev.length > 1 ? prev.filter((x) => x !== t) : prev) : [...prev, t]));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Search</h1>
          <p className="muted">Results for “{query}” across workspaces you can access.</p>
        </div>
      </div>
      <div className="filters">
        {SEARCH_TYPES.map((t) => (
          <label key={t} className="checkbox">
            <input type="checkbox" checked={types.includes(t)} onChange={() => toggle(t)} />
            {TYPE_LABEL[t]}s
          </label>
        ))}
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="Workspace">
          <option value="">All workspaces</option>
          {workspaces.data?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      <ErrorBanner message={results.error} onRetry={results.reload} />
      {results.loading && <Spinner label="Searching…" />}
      {!results.loading && results.data?.length === 0 && <EmptyState title="No matches">Try fewer or different words.</EmptyState>}
      <ul className="search-results">
        {results.data?.map((hit) => (
          <li key={`${hit.type}:${hit.id}`}>
            <Link to={hitLink(hit)} className="search-hit">
              <span className={`type-pill type-${hit.type}`}>{TYPE_LABEL[hit.type]}</span>
              <span className="hit-main">
                <strong>{hit.title}</strong>
                <span className="hit-snippet">
                  {highlightParts(hit.snippet, hit.highlights).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
                </span>
                <span className="muted small">
                  {wsName.get(hit.workspaceId) ?? "Workspace"} · updated {relativeTime(hit.updatedAt)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
