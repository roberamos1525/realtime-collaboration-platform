import { describe, expect, it } from "vitest";
import { ACTIONS, ROLES, can, canAssignRole, canRemoveMember, isRole, roleAtLeast, type Action, type Role } from "../permissions.js";
import { createCommentSchema, createTaskSchema, registerSchema, searchQuerySchema, updateTaskSchema } from "./api.js";
import { ERROR_STATUS, isApiErrorEnvelope } from "./errors.js";
import { clientMessageSchema, colorForUser, PRESENCE_COLORS } from "./ws.js";

describe("permissions", () => {
  it("orders roles", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("commenter", "editor")).toBe(false);
    expect(isRole("editor")).toBe(true);
    expect(isRole("root")).toBe(false);
  });

  it("grants each action monotonically by role", () => {
    for (const action of Object.keys(ACTIONS) as Action[]) {
      let granted = false;
      for (const role of ROLES) {
        const allowed = can(role, action);
        // Once a role is allowed, every higher role must be too.
        if (granted) expect(allowed, `${role} ${action}`).toBe(true);
        granted ||= allowed;
      }
      expect(can("owner", action)).toBe(true);
    }
    expect(can(null, "document.read")).toBe(false);
  });

  it("encodes the documented matrix", () => {
    const matrix: Array<[Role, Action, boolean]> = [
      ["viewer", "document.read", true],
      ["viewer", "comment.create", false],
      ["commenter", "comment.create", true],
      ["commenter", "document.edit", false],
      ["editor", "document.edit", true],
      ["editor", "task.write", true],
      ["editor", "task.delete", false],
      ["admin", "member.manage", true],
      ["admin", "workspace.delete", false],
      ["owner", "workspace.delete", true],
    ];
    for (const [role, action, expected] of matrix) expect(can(role, action), `${role} ${action}`).toBe(expected);
  });

  it("restricts role assignment", () => {
    expect(canAssignRole("owner", "editor", "admin")).toBe(true);
    expect(canAssignRole("admin", "editor", "admin")).toBe(false);
    expect(canAssignRole("admin", "viewer", "editor")).toBe(true);
    expect(canAssignRole("admin", "admin", "viewer")).toBe(false);
    expect(canAssignRole("admin", null, "commenter")).toBe(true);
    expect(canAssignRole("owner", "owner", "editor")).toBe(false);
    expect(canAssignRole("owner", "editor", "owner")).toBe(false);
    expect(canAssignRole("editor", "viewer", "commenter")).toBe(false);
  });

  it("restricts member removal", () => {
    expect(canRemoveMember("viewer", "viewer", true)).toBe(true);
    expect(canRemoveMember("owner", "owner", true)).toBe(false);
    expect(canRemoveMember("admin", "editor", false)).toBe(true);
    expect(canRemoveMember("admin", "admin", false)).toBe(false);
    expect(canRemoveMember("owner", "admin", false)).toBe(true);
    expect(canRemoveMember("editor", "viewer", false)).toBe(false);
  });
});

describe("api schemas", () => {
  it("normalises registration input", () => {
    const parsed = registerSchema.parse({
      email: "  Alice@Example.COM ",
      username: "alice",
      displayName: " Alice ",
      password: "correct horse battery",
    });
    expect(parsed.email).toBe("alice@example.com");
    expect(parsed.displayName).toBe("Alice");
    expect(registerSchema.safeParse({ email: "nope", username: "a", displayName: "", password: "short" }).success).toBe(
      false,
    );
  });

  it("applies task defaults and dedupes labels", () => {
    const task = createTaskSchema.parse({ title: "Ship it", labels: ["Bug", "bug", "ui"] });
    expect(task).toMatchObject({ status: "todo", priority: "medium", assigneeId: null, labels: ["bug", "ui"] });
    expect(createTaskSchema.safeParse({ title: "x", dueDate: "tomorrow" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({}).success).toBe(false);
    expect(updateTaskSchema.safeParse({ assigneeId: null }).success).toBe(true);
  });

  it("rejects anchored replies", () => {
    const anchor = { start: "1@a", end: "2@a", quote: "hi" };
    expect(createCommentSchema.safeParse({ body: "x", anchor }).success).toBe(true);
    expect(createCommentSchema.safeParse({ body: "x", anchor, parentId: "abcdefgh12" }).success).toBe(false);
  });

  it("parses search type filters", () => {
    expect(searchQuerySchema.parse({ q: "x" }).types).toEqual(["document", "comment", "task"]);
    expect(searchQuerySchema.parse({ q: "x", types: "task,document" }).types).toEqual(["task", "document"]);
    expect(searchQuerySchema.safeParse({ q: "x", types: "user" }).success).toBe(false);
    expect(searchQuerySchema.parse({ q: "x", limit: "5" }).limit).toBe(5);
  });
});

describe("ws protocol", () => {
  it("validates client messages", () => {
    expect(clientMessageSchema.safeParse({ type: "ping", t: 1 }).success).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "doc.op",
        docId: "doc_12345678",
        op: { kind: "insert", site: "s1", seq: 1, clock: 1, after: null, text: "a" },
      }).success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        type: "doc.op",
        docId: "doc_12345678",
        op: { kind: "insert", site: "s 1", seq: 0, clock: 1, after: null, text: "" },
      }).success,
    ).toBe(false);
    expect(clientMessageSchema.safeParse({ type: "unknown" }).success).toBe(false);
    expect(
      clientMessageSchema.safeParse({ type: "presence.update", docId: "doc_12345678", cursor: { anchor: null, head: "3@x" } })
        .success,
    ).toBe(true);
  });

  it("assigns stable presence colours", () => {
    expect(colorForUser("user-1")).toBe(colorForUser("user-1"));
    expect(PRESENCE_COLORS).toContain(colorForUser("someone"));
  });

  it("recognises error envelopes", () => {
    expect(isApiErrorEnvelope({ error: { code: "not_found", message: "x" } })).toBe(true);
    expect(isApiErrorEnvelope({ data: 1 })).toBe(false);
    expect(isApiErrorEnvelope(null)).toBe(false);
    expect(ERROR_STATUS.rate_limited).toBe(429);
  });
});
