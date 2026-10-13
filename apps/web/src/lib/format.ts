/** Human-friendly relative time ("just now", "5 min ago", "Mar 3"). */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Math.round((now - t) / 1000);
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 7 * 86_400) return `${Math.round(diff / 86_400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const VERBS: Record<string, string> = {
  "workspace.created": "created the workspace",
  "workspace.updated": "updated workspace settings",
  "workspace.transferred": "transferred ownership",
  "member.added": "added a member",
  "member.removed": "removed a member",
  "member.left": "left the workspace",
  "member.role_changed": "changed a member's role",
  "document.created": "created",
  "document.renamed": "renamed",
  "document.deleted": "deleted",
  "document.edited": "edited",
  "version.created": "saved a version of",
  "version.restored": "restored a version of",
  "comment.created": "commented on",
  "comment.replied": "replied in",
  "comment.resolved": "resolved a comment",
  "comment.reopened": "reopened a comment",
  "comment.deleted": "deleted a comment",
  "task.created": "created task",
  "task.updated": "updated task",
  "task.status_changed": "moved task",
  "task.deleted": "deleted task",
};

/** Sentence fragment describing an activity entry. */
export function describeActivity(verb: string, meta: Record<string, unknown>): string {
  const base = VERBS[verb] ?? verb.replace(/[._]/g, " ");
  const str = (k: string): string | null => (typeof meta[k] === "string" ? (meta[k] as string) : null);
  if (verb.startsWith("task.")) {
    const title = str("title");
    const move = str("from") && str("to") ? ` (${str("from")} → ${str("to")})` : "";
    return `${base}${title ? ` “${title}”` : ""}${move}`;
  }
  if (verb === "document.renamed") return `renamed “${str("from") ?? ""}” to “${str("to") ?? ""}”`;
  if (verb.startsWith("document.")) return `${base} “${str("title") ?? "a document"}”`;
  if (verb.startsWith("version.")) return `${base} the document (${str("label") ?? "version"})`;
  if (verb === "comment.created" || verb === "comment.replied") return `${base} “${str("document") ?? "a document"}”`;
  if (verb === "member.added") return `added ${str("username") ?? "a member"} as ${str("role") ?? "member"}`;
  if (verb === "member.role_changed") return `changed a role from ${str("from") ?? "?"} to ${str("to") ?? "?"}`;
  return base;
}

export const STATUS_LABELS = { todo: "To do", in_progress: "In progress", review: "Review", done: "Done" } as const;
