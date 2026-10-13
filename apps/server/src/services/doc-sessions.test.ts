import { RgaDocument, type RgaOp } from "@rcp/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCore, makeUser, makeWorkspace, type TestCore } from "../__tests__/helpers.js";

/** Simulates a client replica joined through the session manager. */
function joinClient(core: TestCore, docId: string, connectionId: string, userId: string) {
  const { session, participant } = core.services.sessions.join(docId, connectionId, userId);
  const replica = RgaDocument.fromSnapshot(session.doc.snapshot(), participant.site);
  return { replica, participant, session };
}

describe("DocSessionManager", () => {
  let core: TestCore;
  let user: { id: string };
  let docId: string;

  beforeEach(async () => {
    core = createTestCore({ documents: { snapshotEveryOps: 10 } });
    user = await makeUser(core);
    const ws = makeWorkspace(core, user.id);
    docId = core.services.documents.create(user.id, ws, { title: "Doc", content: "hello" }).id;
  });
  afterEach(() => core.close());

  it("sequences client ops and persists them to the op log", () => {
    const a = joinClient(core, docId, "c1", user.id);
    const op = a.replica.insert(5, " world");
    const outcome = core.services.sessions.applyClientOp(docId, "c1", op);
    expect(outcome).toMatchObject({ status: "applied", seq: 1 });
    expect(core.services.sessions.applyClientOp(docId, "c1", op)).toEqual({ status: "duplicate" });
    expect(core.repos.documents.opsAfter(docId, 0)).toHaveLength(1);
    expect(core.services.sessions.currentText(docId)).toEqual({ text: "hello world", headSeq: 1 });
  });

  it("rejects ops from the wrong site, with future clocks or missing dependencies", () => {
    const a = joinClient(core, docId, "c1", user.id);
    const b = joinClient(core, docId, "c2", user.id);
    const fromB = b.replica.insert(0, "x");
    expect(core.services.sessions.applyClientOp(docId, "c1", fromB)).toEqual({ status: "rejected", reason: "site_mismatch" });
    expect(core.services.sessions.applyClientOp(docId, "nobody", fromB)).toEqual({ status: "rejected", reason: "not_joined" });
    const future: RgaOp = { kind: "insert", site: a.participant.site, seq: 1, clock: 10_000, after: null, text: "x" };
    expect(core.services.sessions.applyClientOp(docId, "c1", future)).toEqual({ status: "rejected", reason: "clock_ahead" });
    const gap: RgaOp = { kind: "insert", site: a.participant.site, seq: 2, clock: 6, after: null, text: "x" };
    expect(core.services.sessions.applyClientOp(docId, "c1", gap)).toEqual({ status: "rejected", reason: "missing_dependencies" });
    expect(core.metrics.docOpsRejected.get({ reason: "clock_ahead" })).toBe(1);
  });

  it("reloads state from snapshot plus op log after a restart", () => {
    const a = joinClient(core, docId, "c1", user.id);
    for (const ch of "!!!") core.services.sessions.applyClientOp(docId, "c1", a.replica.insert(a.replica.length, ch));
    // Simulate a crash: forget the in-memory session without compaction.
    core.services.sessions.drop(docId);
    const state = core.repos.documents.loadState(docId);
    expect(state?.snapshotSeq).toBe(0);
    expect(state?.headSeq).toBe(3);
    expect(core.services.sessions.currentText(docId)).toEqual({ text: "hello!!!", headSeq: 3 });
  });

  it("compacts every N ops and trims the log", () => {
    const a = joinClient(core, docId, "c1", user.id);
    for (let i = 0; i < 12; i++) core.services.sessions.applyClientOp(docId, "c1", a.replica.insert(a.replica.length, String(i % 10)));
    const state = core.repos.documents.loadState(docId);
    expect(state?.snapshotSeq).toBe(10);
    expect(core.repos.documents.countOps(docId)).toBe(2);
    expect(core.metrics.docSnapshots.get()).toBe(1);
  });

  it("collects tombstones only when every participant acknowledged the head", () => {
    const a = joinClient(core, docId, "c1", user.id);
    joinClient(core, docId, "c2", user.id);
    const del = core.services.sessions.applyClientOp(docId, "c1", a.replica.delete(0, 5));
    expect(del.status).toBe("applied");
    const session = core.services.sessions.get(docId);
    expect(core.services.sessions.compact(session).collected).toBe(0);
    core.services.sessions.ack(docId, "c1", 1);
    expect(session.isQuiescent()).toBe(false);
    core.services.sessions.ack(docId, "c2", 99);
    expect(session.participants.get("c2")?.ackSeq).toBe(1);
    expect(core.services.sessions.compact(session).collected).toBe(5);
    expect(session.doc.stats().tombstones).toBe(0);
  });

  it("retains tombstones referenced by comment anchors", () => {
    const session = core.services.sessions.get(docId);
    const start = session.doc.keyAt(1) as string;
    const end = session.doc.keyAt(3) as string;
    core.services.comments.create(user.id, docId, { body: "note", anchor: { start, end, quote: "ell" } });
    const a = joinClient(core, docId, "c1", user.id);
    core.services.sessions.applyClientOp(docId, "c1", a.replica.delete(0, 5));
    core.services.sessions.ack(docId, "c1", session.headSeq);
    expect(core.services.sessions.compact(session).collected).toBe(3);
    expect(session.doc.hasElement(start)).toBe(true);
    expect(session.doc.hasElement(end)).toBe(true);
  });

  it("replaces text with server ops and notifies listeners", () => {
    const received: number[] = [];
    core.services.sessions.onServerOps((_s, ops) => received.push(...ops.map((o) => o.seq)));
    const a = joinClient(core, docId, "c1", user.id);
    const ops = core.services.sessions.replaceText(docId, "hello there\nsecond line", user.id);
    expect(ops.length).toBeGreaterThan(0);
    expect(received).toEqual(ops.map((o) => o.seq));
    for (const { op } of ops) a.replica.apply(op);
    expect(a.replica.toString()).toBe("hello there\nsecond line");
    expect(core.services.sessions.replaceText(docId, "hello there\nsecond line", user.id)).toEqual([]);
  });

  it("flushes content for search and evicts idle sessions", async () => {
    const contents: string[] = [];
    core.events.on("document.content", (e) => contents.push(e.content));
    const a = joinClient(core, docId, "c1", user.id);
    core.services.sessions.applyClientOp(docId, "c1", a.replica.insert(0, "Say "));
    await new Promise((r) => setTimeout(r, 120));
    expect(contents).toEqual(["Say hello"]);
    expect(core.repos.documents.findById(docId)?.content).toBe("Say hello");
    core.services.sessions.leave(docId, "c1");
    expect(core.services.sessions.evictIdle()).toBe(0);
    core.manualClock.advance(10 * 60_000);
    expect(core.services.sessions.evictIdle()).toBe(1);
    expect(core.services.sessions.peek(docId)).toBeUndefined();
    expect(core.services.sessions.currentText(docId).text).toBe("Say hello");
  });

  it("records one edit activity per user per window", () => {
    const a = joinClient(core, docId, "c1", user.id);
    for (let i = 0; i < 3; i++) core.services.sessions.applyClientOp(docId, "c1", a.replica.insert(0, "x"));
    const edits = () => core.services.activity.listForDocument(user.id, docId, 50).items.filter((x) => x.verb === "document.edited");
    expect(edits()).toHaveLength(1);
    core.manualClock.advance(11 * 60_000);
    core.services.sessions.applyClientOp(docId, "c1", a.replica.insert(0, "y"));
    expect(edits()).toHaveLength(2);
  });

  it("enforces the maximum document length", () => {
    const a = joinClient(core, docId, "c1", user.id);
    const op = a.replica.insert(0, "x".repeat(20_000));
    let result = core.services.sessions.applyClientOp(docId, "c1", op);
    expect(result.status).toBe("applied");
    for (let i = 0; i < 30 && result.status === "applied"; i++) {
      result = core.services.sessions.applyClientOp(docId, "c1", a.replica.insert(0, "y".repeat(20_000)));
    }
    expect(result).toEqual({ status: "rejected", reason: "document_too_large" });
  });
});

describe("DocumentService versions", () => {
  it("creates, lists and restores versions through CRDT ops", async () => {
    const core = createTestCore();
    try {
      const owner = await makeUser(core);
      const editor = await makeUser(core, "versioneditor");
      const ws = makeWorkspace(core, owner.id, [{ username: "versioneditor", role: "editor" }]);
      const doc = core.services.documents.create(editor.id, ws, { title: "Plan", content: "v1 line\nshared line\n" });
      const v1 = core.services.documents.createVersion(owner.id, doc.id, "First");
      core.services.sessions.replaceText(doc.id, "v2 line\nshared line\nextra\n", owner.id);
      expect(core.services.documents.getVersion(owner.id, doc.id, v1.id).text).toBe("v1 line\nshared line\n");
      core.services.notifications.markAllRead(editor.id);
      const restored = core.services.documents.restoreVersion(owner.id, doc.id, v1.id);
      expect(restored.text).toBe("v1 line\nshared line\n");
      const versions = core.services.documents.listVersions(owner.id, doc.id);
      expect(versions.map((v) => v.label)).toEqual(["Before restoring “First”", "First"]);
      expect(versions[0]?.length).toBe("v2 line\nshared line\nextra\n".length);
      expect(core.services.notifications.list(editor.id, { limit: 5, unreadOnly: true }).items[0]?.kind).toBe("document_restored");
      expect(() => core.services.documents.getVersion(owner.id, doc.id, "ver_doesnotexist")).toThrow(/not found/);
    } finally {
      core.close();
    }
  });
});
