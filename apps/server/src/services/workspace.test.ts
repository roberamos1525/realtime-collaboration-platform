import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCore, makeUser, makeWorkspace, type TestCore } from "../__tests__/helpers.js";

describe("WorkspaceService and role enforcement", () => {
  let core: TestCore;
  let owner: { id: string; username: string };
  let admin: { id: string; username: string };
  let editor: { id: string; username: string };
  let commenter: { id: string; username: string };
  let viewer: { id: string; username: string };
  let outsider: { id: string; username: string };
  let ws: string;

  beforeEach(async () => {
    core = createTestCore();
    owner = await makeUser(core, "owner1");
    admin = await makeUser(core, "admin1");
    editor = await makeUser(core, "editor1");
    commenter = await makeUser(core, "commenter1");
    viewer = await makeUser(core, "viewer1");
    outsider = await makeUser(core, "outsider1");
    ws = makeWorkspace(core, owner.id, [
      { username: "admin1", role: "admin" },
      { username: "editor1", role: "editor" },
      { username: "commenter1", role: "commenter" },
      { username: "viewer1", role: "viewer" },
    ]);
  });
  afterEach(() => core.close());

  it("lists workspaces with the caller's role and unique slugs", () => {
    const again = core.services.workspaces.create(owner.id, { name: core.services.workspaces.get(owner.id, ws).name, description: "" });
    const list = core.services.workspaces.list(owner.id);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((w) => w.slug)).size).toBe(2);
    expect(again.slug).toMatch(/-2$/);
    expect(core.services.workspaces.list(viewer.id)[0]).toMatchObject({ role: "viewer", memberCount: 5 });
    expect(core.services.workspaces.list(outsider.id)).toEqual([]);
  });

  it("hides workspaces from non-members with not_found", () => {
    expect(() => core.services.workspaces.get(outsider.id, ws)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => core.services.documents.list(outsider.id, ws)).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("enforces the role matrix on documents, comments and tasks", () => {
    const deny = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ code: "forbidden" }));
    deny(() => core.services.documents.create(viewer.id, ws, { title: "x", content: "" }));
    deny(() => core.services.documents.create(commenter.id, ws, { title: "x", content: "" }));
    const doc = core.services.documents.create(editor.id, ws, { title: "Spec", content: "hello" });
    expect(doc.role).toBe("editor");
    deny(() => core.services.comments.create(viewer.id, doc.id, { body: "hi" }));
    expect(core.services.comments.create(commenter.id, doc.id, { body: "hi" }).body).toBe("hi");
    deny(() => core.services.documents.rename(commenter.id, doc.id, "nope"));
    deny(() => core.services.documents.delete(editor.id, doc.id));
    deny(() => core.services.documents.createVersion(commenter.id, doc.id, "v1"));
    const version = core.services.documents.createVersion(editor.id, doc.id, "v1");
    deny(() => core.services.documents.restoreVersion(editor.id, doc.id, version.id));
    deny(() =>
      core.services.tasks.create(commenter.id, ws, {
        title: "t",
        description: "",
        status: "todo",
        priority: "low",
        assigneeId: null,
        dueDate: null,
        labels: [],
        documentId: null,
      }),
    );
    expect(core.services.documents.get(viewer.id, doc.id).text).toBe("hello");
    core.services.documents.delete(admin.id, doc.id);
    expect(() => core.services.documents.get(owner.id, doc.id)).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("manages members according to role-assignment rules", () => {
    const deny = (fn: () => unknown) => expect(fn).toThrow(expect.objectContaining({ code: "forbidden" }));
    deny(() => core.services.workspaces.addMember(editor.id, ws, "outsider1", "viewer"));
    deny(() => core.services.workspaces.addMember(admin.id, ws, "outsider1", "admin"));
    const members = core.services.workspaces.addMember(admin.id, ws, "outsider1", "commenter");
    expect(members.find((m) => m.user.id === outsider.id)?.role).toBe("commenter");
    expect(() => core.services.workspaces.addMember(admin.id, ws, "outsider1", "viewer")).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(() => core.services.workspaces.addMember(admin.id, ws, "ghost", "viewer")).toThrow(expect.objectContaining({ code: "not_found" }));
    deny(() => core.services.workspaces.changeRole(admin.id, ws, owner.id, "viewer"));
    expect(() => core.services.workspaces.changeRole(admin.id, ws, admin.id, "viewer")).toThrow(expect.objectContaining({ code: "bad_request" }));
    core.services.workspaces.changeRole(owner.id, ws, editor.id, "admin");
    expect(core.services.access.roleIn(ws, editor.id)).toBe("admin");
    deny(() => core.services.workspaces.changeRole(admin.id, ws, editor.id, "viewer"));
  });

  it("removes members, lets members leave, and protects the owner", () => {
    const changes: string[] = [];
    core.events.on("membership.changed", (e) => changes.push(e.userId));
    core.services.workspaces.removeMember(viewer.id, ws, viewer.id);
    expect(core.services.access.roleIn(ws, viewer.id)).toBeNull();
    expect(() => core.services.workspaces.removeMember(editor.id, ws, commenter.id)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => core.services.workspaces.removeMember(owner.id, ws, owner.id)).toThrow(/transfer ownership/);
    core.services.workspaces.removeMember(admin.id, ws, commenter.id);
    expect(changes).toEqual([viewer.id, commenter.id]);
  });

  it("unassigns tasks of removed members", () => {
    const task = core.services.tasks.create(owner.id, ws, {
      title: "Assigned",
      description: "",
      status: "todo",
      priority: "low",
      assigneeId: editor.id,
      dueDate: null,
      labels: [],
      documentId: null,
    });
    core.services.workspaces.removeMember(owner.id, ws, editor.id);
    expect(core.services.tasks.get(owner.id, task.id).assignee).toBeNull();
  });

  it("transfers ownership", () => {
    core.services.workspaces.transferOwnership(owner.id, ws, editor.id);
    expect(core.services.access.roleIn(ws, editor.id)).toBe("owner");
    expect(core.services.access.roleIn(ws, owner.id)).toBe("admin");
    expect(core.services.workspaces.get(editor.id, ws).ownerId).toBe(editor.id);
    expect(() => core.services.workspaces.delete(owner.id, ws)).toThrow(expect.objectContaining({ code: "forbidden" }));
    core.services.workspaces.delete(editor.id, ws);
    expect(core.services.workspaces.list(editor.id)).toEqual([]);
  });

  it("updates workspace details and records activity", () => {
    expect(() => core.services.workspaces.update(editor.id, ws, { name: "x" })).toThrow(expect.objectContaining({ code: "forbidden" }));
    const updated = core.services.workspaces.update(admin.id, ws, { description: "New description" });
    expect(updated.description).toBe("New description");
    const feed = core.services.activity.listForWorkspace(viewer.id, ws, 50);
    expect(feed.items[0]?.verb).toBe("workspace.updated");
    expect(feed.items.map((a) => a.verb)).toContain("member.added");
  });

  it("notifies users added to a workspace", () => {
    core.services.workspaces.addMember(owner.id, ws, "outsider1", "viewer");
    const inbox = core.services.notifications.list(outsider.id, { limit: 10, unreadOnly: true });
    expect(inbox.items[0]).toMatchObject({ kind: "member_added", workspaceId: ws });
    expect(inbox.unreadCount).toBe(1);
  });

  it("searches users by prefix", () => {
    expect(core.services.workspaces.searchUsers("edi").map((u) => u.username)).toEqual(["editor1"]);
    expect(core.services.workspaces.searchUsers("%")).toEqual([]);
  });
});
