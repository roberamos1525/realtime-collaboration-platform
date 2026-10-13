import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCore, makeUser, makeWorkspace, type TestCore } from "../__tests__/helpers.js";
import type { CreateTaskInput } from "./task-service.js";

const baseTask: CreateTaskInput = {
  title: "Task",
  description: "",
  status: "todo",
  priority: "medium",
  assigneeId: null,
  dueDate: null,
  labels: [],
  documentId: null,
};

describe("comments, mentions and notifications", () => {
  let core: TestCore;
  let alice: { id: string };
  let bob: { id: string };
  let carol: { id: string };
  let ws: string;
  let docId: string;

  beforeEach(async () => {
    core = createTestCore();
    alice = await makeUser(core, "alice");
    bob = await makeUser(core, "bob");
    carol = await makeUser(core, "carol");
    await makeUser(core, "mallory");
    ws = makeWorkspace(core, alice.id, [
      { username: "bob", role: "editor" },
      { username: "carol", role: "commenter" },
    ]);
    docId = core.services.documents.create(alice.id, ws, { title: "Spec", content: "The quick brown fox" }).id;
    // Start each test with empty inboxes ("added to workspace" notices).
    for (const u of [bob, carol]) core.services.notifications.markAllRead(u.id);
  });
  afterEach(() => core.close());

  it("anchors comments to CRDT ids that follow concurrent edits", () => {
    const session = core.services.sessions.get(docId);
    const start = session.doc.keyAt(4) as string;
    const end = session.doc.keyAt(8) as string;
    const comment = core.services.comments.create(bob.id, docId, { body: "Is it quick?", anchor: { start, end, quote: "quick" } });
    expect(comment.anchor).toEqual({ start, end, quote: "quick" });
    session.doc.insert(0, ">> ");
    expect(session.doc.resolveAnchor(start)).toBe(8);
    expect(() =>
      core.services.comments.create(bob.id, docId, { body: "bad", anchor: { start: "999@nobody", end, quote: "" } }),
    ).toThrow(/does not exist/);
    expect(() => core.services.comments.create(bob.id, docId, { body: "reversed", anchor: { start: end, end: start, quote: "" } })).toThrow(
      /invalid/,
    );
  });

  it("notifies mentioned members only, and thread participants on replies", () => {
    const root = core.services.comments.create(carol.id, docId, { body: "@alice @mallory @ghost thoughts?" });
    expect(core.services.notifications.list(alice.id, { limit: 10, unreadOnly: false }).items[0]).toMatchObject({
      kind: "mention",
      documentId: docId,
      entityId: root.id,
    });
    const mallory = core.repos.users.findByUsername("mallory");
    expect(core.services.notifications.unreadCount(mallory?.id as string)).toBe(0);

    const reply = core.services.comments.create(bob.id, docId, { body: "Looks good", parentId: root.id });
    expect(reply.parentId).toBe(root.id);
    const carolInbox = core.services.notifications.list(carol.id, { limit: 10, unreadOnly: true });
    expect(carolInbox.items[0]?.kind).toBe("comment_reply");
    // Replying to a reply attaches to the root thread.
    const nested = core.services.comments.create(alice.id, docId, { body: "agreed", parentId: reply.id });
    expect(nested.parentId).toBe(root.id);
    expect(core.services.notifications.unreadCount(bob.id)).toBe(1);
  });

  it("only notifies newly added mentions when editing", () => {
    const c = core.services.comments.create(carol.id, docId, { body: "ping @alice" });
    expect(core.services.notifications.unreadCount(alice.id)).toBe(1);
    core.services.comments.update(carol.id, c.id, "ping @alice and @bob");
    expect(core.services.notifications.unreadCount(alice.id)).toBe(1);
    expect(core.services.notifications.unreadCount(bob.id)).toBe(1);
    expect(() => core.services.comments.update(bob.id, c.id, "hijack")).toThrow(/author/);
  });

  it("resolves and reopens threads with permission checks", () => {
    const root = core.services.comments.create(carol.id, docId, { body: "fix typo" });
    const reply = core.services.comments.create(bob.id, docId, { body: "on it", parentId: root.id });
    expect(() => core.services.comments.setResolved(bob.id, reply.id, true)).toThrow(/top-level/);
    const resolved = core.services.comments.setResolved(bob.id, root.id, true);
    expect(resolved.resolvedBy).toBe(bob.id);
    expect(core.services.comments.setResolved(bob.id, root.id, true).resolvedAt).toBe(resolved.resolvedAt);
    // The commenter authored the thread, so they may reopen it.
    expect(core.services.comments.setResolved(carol.id, root.id, false).resolvedAt).toBeNull();
    const other = core.services.comments.create(bob.id, docId, { body: "bob's thread" });
    expect(() => core.services.comments.setResolved(carol.id, other.id, true)).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("deletes threads with their replies", () => {
    const deleted: string[] = [];
    core.events.on("comment.deleted", (e) => deleted.push(e.commentId));
    const root = core.services.comments.create(carol.id, docId, { body: "root" });
    const reply = core.services.comments.create(bob.id, docId, { body: "reply", parentId: root.id });
    expect(() => core.services.comments.delete(bob.id, root.id)).toThrow(expect.objectContaining({ code: "forbidden" }));
    core.services.comments.delete(alice.id, root.id);
    expect(deleted.sort()).toEqual([root.id, reply.id].sort());
    expect(core.services.comments.list(alice.id, docId)).toEqual([]);
  });

  it("paginates notifications and tracks read state", () => {
    for (let i = 0; i < 5; i++) {
      core.manualClock.advance(1000);
      core.services.comments.create(carol.id, docId, { body: `@alice note ${i}` });
    }
    const page1 = core.services.notifications.list(alice.id, { limit: 2, unreadOnly: false });
    expect(page1.items).toHaveLength(2);
    expect(page1.items[0]?.body).toContain("note 4");
    const page2 = core.services.notifications.list(alice.id, { limit: 2, unreadOnly: false, cursor: page1.nextCursor as string });
    expect(page2.items[0]?.body).toContain("note 2");
    const page3 = core.services.notifications.list(alice.id, { limit: 2, unreadOnly: false, cursor: page2.nextCursor as string });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const first = page1.items[0]?.id as string;
    expect(core.services.notifications.markRead(alice.id, first).unreadCount).toBe(4);
    expect(core.services.notifications.list(alice.id, { limit: 10, unreadOnly: true }).items).toHaveLength(4);
    expect(core.services.notifications.markUnread(alice.id, first).unreadCount).toBe(5);
    expect(() => core.services.notifications.markRead(bob.id, first)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(core.services.notifications.markAllRead(alice.id)).toEqual({ updated: 5, unreadCount: 0 });
  });

  it("pushes notification events with unread counts", () => {
    const pushed: number[] = [];
    core.events.on("notification.created", (e) => pushed.push(e.unreadCount));
    core.services.comments.create(carol.id, docId, { body: "@alice one" });
    core.services.comments.create(carol.id, docId, { body: "@alice two" });
    core.services.comments.create(alice.id, docId, { body: "@alice self-mention is ignored" });
    expect(pushed).toEqual([1, 2]);
  });
});

describe("tasks", () => {
  let core: TestCore;
  let owner: { id: string };
  let editor: { id: string };
  let ws: string;

  beforeEach(async () => {
    core = createTestCore();
    owner = await makeUser(core, "towner");
    editor = await makeUser(core, "teditor");
    await makeUser(core, "tstranger");
    ws = makeWorkspace(core, owner.id, [{ username: "teditor", role: "editor" }]);
    core.services.notifications.markAllRead(editor.id);
  });
  afterEach(() => core.close());

  it("creates tasks at the end of a column and orders moves", () => {
    const a = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "A" });
    const b = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "B" });
    const c = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "C" });
    expect(a.position).toBeLessThan(b.position);
    core.services.tasks.move(editor.id, c.id, "todo", a.id);
    expect(core.services.tasks.list(owner.id, ws, { status: "todo" }).map((t) => t.title)).toEqual(["C", "A", "B"]);
    core.services.tasks.move(editor.id, a.id, "done", null);
    expect(core.services.tasks.list(owner.id, ws, { status: "done" }).map((t) => t.title)).toEqual(["A"]);
    expect(() => core.services.tasks.move(editor.id, a.id, "todo", a.id)).toThrow(/before itself/);
    expect(() => core.services.tasks.move(editor.id, b.id, "review", c.id)).toThrow(/target column/);
    const verbs = core.services.activity.listForWorkspace(owner.id, ws, 5).items.map((x) => x.verb);
    expect(verbs[0]).toBe("task.status_changed");
  });

  it("renumbers a column when fractional gaps are exhausted", () => {
    const a = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "A" });
    const b = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "B" });
    const c = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "C" });
    // Repeatedly insert between A and the item right after it.
    let before = b.id;
    for (let i = 0; i < 60; i++) {
      const moved = i % 2 === 0 ? c : b;
      core.services.tasks.move(owner.id, moved.id, "todo", before);
      before = moved.id;
    }
    const order = core.services.tasks.list(owner.id, ws, { status: "todo" });
    expect(order).toHaveLength(3);
    expect(new Set(order.map((t) => t.position)).size).toBe(3);
    expect(order[0]?.id).toBe(a.id);
  });

  it("validates assignees and linked documents and notifies assignees", () => {
    const stranger = core.repos.users.findByUsername("tstranger");
    expect(() => core.services.tasks.create(owner.id, ws, { ...baseTask, assigneeId: stranger?.id as string })).toThrow(/member/);
    const otherWs = makeWorkspace(core, owner.id);
    const foreignDoc = core.services.documents.create(owner.id, otherWs, { title: "Elsewhere", content: "" });
    expect(() => core.services.tasks.create(owner.id, ws, { ...baseTask, documentId: foreignDoc.id })).toThrow(/belong/);
    const task = core.services.tasks.create(owner.id, ws, { ...baseTask, assigneeId: editor.id, dueDate: "2026-04-01" });
    const inbox = core.services.notifications.list(editor.id, { limit: 5, unreadOnly: true });
    expect(inbox.items[0]).toMatchObject({ kind: "task_assigned", entityId: task.id });
    expect(inbox.items[0]?.body).toContain("due 2026-04-01");
  });

  it("updates fields, filters, and enforces delete rights", () => {
    const own = core.services.tasks.create(editor.id, ws, { ...baseTask, title: "Mine", labels: ["ui"] });
    const theirs = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "Theirs", labels: ["backend"] });
    const updated = core.services.tasks.update(editor.id, own.id, { priority: "urgent", status: "review", labels: ["ui", "bug"] });
    expect(updated).toMatchObject({ priority: "urgent", status: "review", labels: ["ui", "bug"] });
    expect(core.services.tasks.list(owner.id, ws, { label: "bug" }).map((t) => t.id)).toEqual([own.id]);
    expect(core.services.tasks.list(owner.id, ws, { assigneeId: editor.id })).toEqual([]);
    expect(() => core.services.tasks.delete(editor.id, theirs.id)).toThrow(expect.objectContaining({ code: "forbidden" }));
    core.services.tasks.delete(editor.id, own.id);
    core.services.tasks.delete(owner.id, theirs.id);
    expect(core.services.tasks.list(owner.id, ws, {})).toEqual([]);
    expect(() => core.services.tasks.get(owner.id, own.id)).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("emits realtime events for task changes", () => {
    const events: string[] = [];
    core.events.on("task.upserted", (e) => events.push(`up:${e.task.title}`));
    core.events.on("task.deleted", () => events.push("deleted"));
    const t = core.services.tasks.create(owner.id, ws, { ...baseTask, title: "Live" });
    core.services.tasks.update(owner.id, t.id, { title: "Live 2" });
    core.services.tasks.delete(owner.id, t.id);
    expect(events).toEqual(["up:Live", "up:Live 2", "deleted"]);
  });
});

describe("activity feed", () => {
  it("paginates newest first per workspace and document", async () => {
    const core = createTestCore();
    try {
      const u = await makeUser(core);
      const ws = makeWorkspace(core, u.id);
      const doc = core.services.documents.create(u.id, ws, { title: "D", content: "" });
      for (let i = 0; i < 4; i++) core.services.documents.rename(u.id, doc.id, `D${i}`);
      const page = core.services.activity.listForWorkspace(u.id, ws, 3);
      expect(page.items.map((a) => a.meta.to)).toEqual(["D3", "D2", "D1"]);
      const next = core.services.activity.listForWorkspace(u.id, ws, 3, page.nextCursor as string);
      expect(next.items.map((a) => a.verb)).toEqual(["document.renamed", "document.created", "workspace.created"]);
      expect(next.nextCursor).toBeNull();
      const docFeed = core.services.activity.listForDocument(u.id, doc.id, 10);
      expect(docFeed.items).toHaveLength(5);
      expect(docFeed.items[0]?.actor?.id).toBe(u.id);
    } finally {
      core.close();
    }
  });
});
