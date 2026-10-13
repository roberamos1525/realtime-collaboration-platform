import type { Core } from "./app.js";

/** Synthetic demo users; all share the password given to {@link seedDemo}. */
export const DEMO_USERS = [
  { username: "alice", displayName: "Alice Andersen", email: "alice@example.test" },
  { username: "bob", displayName: "Bob Baptiste", email: "bob@example.test" },
  { username: "carol", displayName: "Carol Chen", email: "carol@example.test" },
  { username: "dave", displayName: "Dave Duarte", email: "dave@example.test" },
] as const;

const BRIEF = `Product brief: Team Spaces

Goal
Give small teams one place to write specs, discuss them and track the work.

Scope
- Realtime collaborative documents with live cursors
- Threaded comments anchored to text
- A kanban board linked to documents
- Notifications for mentions and assignments

Open questions
- How long should version history be kept?
- Do we need offline editing in the first release?
`;

const NOTES = `Weekly sync — synthetic sample notes

Attendees: Alice, Bob, Carol, Dave

1. Editor latency looks good in the staging environment.
2. Search should rank titles above body text.
3. Carol will draft the onboarding checklist.

Action items
- Bob: finish the presence timeout work
- Alice: review the permissions matrix
`;

const CHECKLIST = `Release checklist

[ ] Run the full test suite
[ ] Build the web client
[ ] Back up the SQLite database
[ ] Smoke test login, editing and search
[ ] Announce the release in the team space
`;

export interface SeedResult {
  readonly created: boolean;
  readonly workspaceId: string | null;
  readonly users: Record<string, string>;
}

/**
 * Creates demo users, a workspace with documents, comments and tasks.
 * Idempotent: does nothing if the demo user "alice" already exists.
 */
export async function seedDemo(core: Core, password: string): Promise<SeedResult> {
  const { services, repos } = core;
  const existing = repos.users.findByUsername("alice");
  if (existing) {
    const ws = repos.workspaces.listForUser(existing.id)[0];
    return { created: false, workspaceId: ws?.id ?? null, users: {} };
  }
  const ids: Record<string, string> = {};
  for (const u of DEMO_USERS) {
    const result = await services.auth.register({ ...u, password }, { ip: null, userAgent: "seed" });
    ids[u.username] = result.user.id;
  }
  const alice = ids.alice as string;
  const ws = services.workspaces.create(alice, { name: "Acme Launch", description: "Demo workspace with synthetic content" });
  services.workspaces.addMember(alice, ws.id, "bob", "editor");
  services.workspaces.addMember(alice, ws.id, "carol", "commenter");
  services.workspaces.addMember(alice, ws.id, "dave", "viewer");

  const brief = services.documents.create(alice, ws.id, { title: "Product brief", content: BRIEF });
  const notes = services.documents.create(ids.bob as string, ws.id, { title: "Weekly sync notes", content: NOTES });
  services.documents.create(alice, ws.id, { title: "Release checklist", content: CHECKLIST });
  services.documents.createVersion(alice, brief.id, "First draft");

  const session = services.sessions.get(brief.id);
  const start = BRIEF.indexOf("Open questions");
  const startKey = session.doc.keyAt(start);
  const endKey = session.doc.keyAt(start + "Open questions".length - 1);
  if (startKey && endKey) {
    const root = services.comments.create(ids.carol as string, brief.id, {
      body: "@alice can we decide on version retention before the review?",
      anchor: { start: startKey, end: endKey, quote: "Open questions" },
    });
    services.comments.create(alice, brief.id, { body: "Good call — let's keep 90 days. @bob does that work for storage?", parentId: root.id });
  }
  services.comments.create(ids.bob as string, notes.id, { body: "Presence timeout is configurable now." });

  const task = (title: string, status: "todo" | "in_progress" | "review" | "done", extra: Record<string, unknown> = {}) =>
    services.tasks.create(alice, ws.id, {
      title,
      description: "",
      status,
      priority: "medium",
      assigneeId: null,
      dueDate: null,
      labels: [],
      documentId: null,
      ...extra,
    });
  task("Write onboarding checklist", "todo", { assigneeId: ids.carol, priority: "high", labels: ["docs"], dueDate: "2026-11-02" });
  task("Presence heartbeat timeouts", "in_progress", { assigneeId: ids.bob, labels: ["realtime"], documentId: notes.id });
  task("Review permissions matrix", "review", { assigneeId: alice, priority: "urgent", labels: ["security"] });
  task("Set up CI pipeline", "done", { labels: ["infra"] });
  task("Decide version retention", "todo", { documentId: brief.id, labels: ["product"] });

  core.services.sessions.flushAll();
  return { created: true, workspaceId: ws.id, users: ids };
}
