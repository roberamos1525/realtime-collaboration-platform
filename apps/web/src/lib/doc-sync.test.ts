import { RgaDocument, randomSiteId, type ClientMessage, type RgaOp, type ServerMessage } from "@rcp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSync, type Selection } from "./doc-sync";

const DOC = "doc_test0001";

/**
 * Deterministic stand-in for the server: sequences ops, acks senders and
 * relays to others. Messages sit in per-client queues until flushed, which
 * lets tests create genuinely concurrent edits.
 */
class FakeServer {
  doc: RgaDocument;
  seq = 0;
  readonly clients = new Map<string, { sync: DocumentSync; site: string; inbox: ServerMessage[]; online: boolean }>();
  readonly received: ClientMessage[] = [];
  /** Rejects the next `rejectCount` ops with `rejectReason`. */
  rejectCount = 0;
  rejectReason = "invalid";

  constructor(text: string) {
    this.doc = RgaDocument.fromText(text, "init");
  }

  connect(name: string, role: "editor" | "viewer" = "editor", events: ConstructorParameters<typeof DocumentSync>[2] = {}): DocumentSync {
    const sync = new DocumentSync(
      DOC,
      {
        send: (msg) => {
          const c = this.clients.get(name);
          if (!c?.online) return false;
          this.received.push(msg);
          this.handle(name, msg, role);
          return true;
        },
        rejoin: () => this.join(name, role),
      },
      events,
    );
    this.clients.set(name, { sync, site: "", inbox: [], online: true });
    this.join(name, role);
    return sync;
  }

  join(name: string, role: "editor" | "viewer"): void {
    const c = this.clients.get(name);
    if (!c || !c.online) return;
    c.site = `c${randomSiteId(6)}`;
    c.inbox.push({ type: "doc.joined", docId: DOC, site: c.site, snapshot: this.doc.snapshot(), seq: this.seq, role, peers: [] });
  }

  private handle(name: string, msg: ClientMessage, role: string): void {
    const c = this.clients.get(name);
    if (!c || msg.type !== "doc.op") return;
    if (role === "viewer") {
      c.inbox.push({ type: "error", code: "forbidden", message: "read only", docId: DOC });
      return;
    }
    const op = msg.op as RgaOp;
    if (this.rejectCount > 0 || op.site !== c.site || !this.doc.canApply(op)) {
      this.rejectCount = Math.max(0, this.rejectCount - 1);
      c.inbox.push({ type: "doc.resync", docId: DOC, reason: this.rejectReason });
      return;
    }
    this.doc.apply(op);
    const seq = ++this.seq;
    c.inbox.push({ type: "doc.ack", docId: DOC, seq, opSeq: op.seq });
    for (const [other, oc] of this.clients) if (other !== name) oc.inbox.push({ type: "doc.op", docId: DOC, op, seq, userId: other });
  }

  /** Delivers queued messages until every inbox is empty. */
  flush(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (const c of this.clients.values()) {
        if (!c.online) continue;
        const batch = c.inbox.splice(0);
        for (const m of batch) c.sync.handle(m);
        if (batch.length) progress = true;
      }
    }
  }

  setOnline(name: string, online: boolean): void {
    const c = this.clients.get(name);
    if (c) {
      c.online = online;
      if (!online) c.inbox = [];
    }
  }
}

function edit(sync: DocumentSync, index: number, insert: string, remove = 0): void {
  const t = sync.text;
  expect(sync.applyLocalText(t.slice(0, index) + insert + t.slice(index + remove), index + insert.length)).toBe(true);
}

describe("DocumentSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins with a snapshot and reports text and role", () => {
    const server = new FakeServer("hello");
    const onRemoteText = vi.fn();
    const onRole = vi.fn();
    const sync = server.connect("a", "editor", { onRemoteText, onRole });
    expect(sync.status).toBe("joining");
    server.flush();
    expect(sync.status).toBe("synced");
    expect(sync.text).toBe("hello");
    expect(onRemoteText).toHaveBeenCalledWith("hello", null);
    expect(onRole).toHaveBeenCalledWith("editor");
    expect(sync.canEdit).toBe(true);
  });

  it("converges concurrent edits from two clients", () => {
    const server = new FakeServer("abc");
    const a = server.connect("a");
    const b = server.connect("b");
    server.flush();
    edit(a, 0, "X");
    edit(b, 3, "Y");
    edit(b, 1, "", 1);
    server.flush();
    expect(a.text).toBe(b.text);
    expect(a.text).toBe(server.doc.toString());
    expect(a.text).toBe("XacY");
    expect(a.pendingCount).toBe(0);
  });

  it("moves the local selection through remote edits", () => {
    const server = new FakeServer("hello world");
    const seen: Array<Selection | null> = [];
    const a = server.connect("a", "editor", { onRemoteText: (_t, sel) => seen.push(sel) });
    const b = server.connect("b");
    server.flush();
    a.setSelection({ start: 6, end: 11 });
    edit(b, 0, ">> ");
    server.flush();
    expect(seen.at(-1)).toEqual({ start: 9, end: 14 });
  });

  it("acknowledges the latest sequence after a short delay", () => {
    const server = new FakeServer("");
    const a = server.connect("a");
    const b = server.connect("b");
    server.flush();
    edit(b, 0, "hi");
    server.flush();
    expect(server.received.filter((m) => m.type === "doc.ack")).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(server.received.filter((m) => m.type === "doc.ack").map((m) => (m as { seq: number }).seq)).toEqual([1, 1]);
    expect(a.serverSeq).toBe(1);
  });

  it("refuses local edits for viewers", () => {
    const server = new FakeServer("locked");
    const v = server.connect("v", "viewer");
    server.flush();
    expect(v.canEdit).toBe(false);
    expect(v.applyLocalText("unlocked", 8)).toBe(false);
    expect(v.text).toBe("locked");
  });

  it("rebases unacknowledged edits made while offline", () => {
    const server = new FakeServer("base");
    const a = server.connect("a");
    const b = server.connect("b");
    server.flush();
    server.setOnline("a", false);
    edit(a, 4, " one");
    edit(a, 8, " two");
    edit(a, 0, "", 1);
    expect(a.pendingCount).toBe(3);
    edit(b, 0, ">");
    server.flush();
    server.setOnline("a", true);
    server.join("a", "editor");
    server.flush();
    expect(a.text).toBe(">ase one two");
    expect(b.text).toBe(a.text);
    expect(server.doc.toString()).toBe(a.text);
    expect(a.pendingCount).toBe(0);
  });

  it("resyncs when the server rejects an op and replays it", () => {
    const server = new FakeServer("abc");
    const statuses: string[] = [];
    const a = server.connect("a", "editor", { onStatus: (s) => statuses.push(s) });
    server.flush();
    server.rejectCount = 1;
    server.rejectReason = "missing_dependencies";
    edit(a, 3, "d");
    server.flush();
    expect(statuses).toContain("resyncing");
    expect(a.status).toBe("synced");
    expect(server.doc.toString()).toBe("abcd");
    expect(a.text).toBe("abcd");
  });

  it("gives up after repeated failed resyncs and reloads the server state", () => {
    const server = new FakeServer("abc");
    const details: string[] = [];
    const a = server.connect("a", "editor", { onStatus: (s, d) => s === "error" && d && details.push(d) });
    server.flush();
    server.rejectCount = 100;
    server.rejectReason = "document_too_large";
    edit(a, 3, "x");
    server.flush();
    expect(details[0]).toMatch(/could not synchronise.*document_too_large/);
    expect(a.status).toBe("synced");
    expect(a.pendingCount).toBe(0);
    expect(a.text).toBe("abc");
    // Once the server accepts ops again, editing works normally.
    server.rejectCount = 0;
    edit(a, 0, "z");
    server.flush();
    expect(server.doc.toString()).toBe("zabc");
  });

  it("tracks peers and resolves their anchored cursors", () => {
    const server = new FakeServer("presence");
    const a = server.connect("a");
    server.flush();
    const peer = {
      connectionId: "conn_1",
      userId: "u1",
      username: "bob",
      displayName: "Bob",
      color: "#30a46c",
      cursor: { anchor: "2@init", head: "4@init" },
      lastSeen: 0,
    };
    a.handle({ type: "presence.update", docId: DOC, peer });
    expect(a.peerList()).toHaveLength(1);
    expect(a.resolveCursor(peer.cursor)).toEqual({ start: 2, end: 4 });
    expect(a.resolvePosition(null)).toBe(0);
    a.handle({ type: "presence.leave", docId: DOC, connectionId: "conn_1" });
    expect(a.peerList()).toHaveLength(0);
    // Messages for other documents are ignored.
    a.handle({ type: "presence.update", docId: "doc_other0001", peer });
    expect(a.peerList()).toHaveLength(0);
  });

  it("maps selections to comment anchors and back", () => {
    const server = new FakeServer("annotate me");
    const a = server.connect("a");
    server.flush();
    const range = a.anchorRange({ start: 0, end: 8 });
    expect(range).toEqual({ start: "1@init", end: "8@init" });
    edit(a, 0, "please ");
    expect(a.resolveRange(range?.start as string, range?.end as string)).toEqual({ start: 7, end: 15 });
    edit(a, 7, "", 2);
    expect(a.resolveRange(range?.start as string, range?.end as string)).toEqual({ start: 7, end: 13 });
    expect(a.anchorRange({ start: 3, end: 3 })).toBeNull();
  });

  it("broadcasts cursor positions as anchors", () => {
    const server = new FakeServer("cursor");
    const a = server.connect("a");
    server.flush();
    a.sendCursor({ start: 1, end: 3 });
    a.sendCursor(null);
    const updates = server.received.filter((m) => m.type === "presence.update");
    expect(updates).toEqual([
      { type: "presence.update", docId: DOC, cursor: { anchor: "1@init", head: "3@init" } },
      { type: "presence.update", docId: DOC, cursor: null },
    ]);
  });

  it("reports closed documents and title changes", () => {
    const server = new FakeServer("x");
    const onTitle = vi.fn();
    const a = server.connect("a", "editor", { onTitle });
    server.flush();
    a.handle({ type: "doc.meta", docId: DOC, title: "Renamed" });
    expect(onTitle).toHaveBeenCalledWith("Renamed");
    a.handle({ type: "doc.closed", docId: DOC, reason: "access revoked" });
    expect(a.status).toBe("closed");
  });
});
