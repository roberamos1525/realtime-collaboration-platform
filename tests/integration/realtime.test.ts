import { CLOSE_CODES, RgaDocument, type ServerMessage } from "@rcp/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentSync } from "../../apps/web/src/lib/doc-sync.js";
import { eventually, http, registerUser, sleep, startServer, tempDbPath, WsClient, type TestServer } from "../helpers.js";

/** A realistic editing client: real WebSocket + the web app's DocumentSync. */
class Editor {
  readonly sync: DocumentSync;
  ws: WsClient;

  private constructor(
    ws: WsClient,
    readonly docId: string,
  ) {
    this.ws = ws;
    this.sync = new DocumentSync(docId, {
      send: (msg) => {
        if (this.ws.ws.readyState !== this.ws.ws.OPEN) return false;
        this.ws.send(msg);
        return true;
      },
      rejoin: (id) => this.ws.send({ type: "doc.join", docId: id }),
    });
    this.attach(ws);
  }

  private attach(ws: WsClient): void {
    this.ws = ws;
    ws.ws.on("message", (data) => this.sync.handle(JSON.parse(data.toString()) as ServerMessage));
  }

  static async open(server: TestServer, token: string, docId: string): Promise<Editor> {
    const ws = await WsClient.connect(server.wsUrl, token);
    const editor = new Editor(ws, docId);
    ws.send({ type: "doc.join", docId });
    await eventually(() => editor.sync.status === "synced");
    return editor;
  }

  /** Opens a new socket and re-joins, like the browser client after a drop. */
  async reconnect(server: TestServer, token: string): Promise<void> {
    const ws = await WsClient.connect(server.wsUrl, token);
    this.attach(ws);
    ws.send({ type: "doc.join", docId: this.docId });
  }

  type(index: number, text: string): void {
    const current = this.sync.text;
    const next = current.slice(0, index) + text + current.slice(index);
    expect(this.sync.applyLocalText(next, index + text.length)).toBe(true);
  }

  erase(index: number, length: number): void {
    const current = this.sync.text;
    expect(this.sync.applyLocalText(current.slice(0, index) + current.slice(index + length), index)).toBe(true);
  }

  close(): void {
    this.sync.dispose();
    this.ws.close();
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("realtime collaboration over WebSockets", () => {
  let server: TestServer;
  let owner: Awaited<ReturnType<typeof registerUser>>;
  let editorUser: Awaited<ReturnType<typeof registerUser>>;
  let viewerUser: Awaited<ReturnType<typeof registerUser>>;
  let wsId: string;

  const newDoc = async (content = "") => {
    const res = await http(server, "POST", `/api/workspaces/${wsId}/documents`, { token: owner.accessToken, body: { title: "Live doc", content } });
    return res.body.data.id as string;
  };

  beforeAll(async () => {
    server = await startServer({ realtime: { heartbeatIntervalMs: 1000, presenceTimeoutMs: 2500, authTimeoutMs: 600 } });
    owner = await registerUser(server, "rt_owner");
    editorUser = await registerUser(server, "rt_editor");
    viewerUser = await registerUser(server, "rt_viewer");
    wsId = (await http(server, "POST", "/api/workspaces", { token: owner.accessToken, body: { name: "Realtime" } })).body.data.id;
    await http(server, "POST", `/api/workspaces/${wsId}/members`, { token: owner.accessToken, body: { identifier: "rt_editor", role: "editor" } });
    await http(server, "POST", `/api/workspaces/${wsId}/members`, { token: owner.accessToken, body: { identifier: "rt_viewer", role: "viewer" } });
  });
  afterAll(() => server.close());

  describe("connection handling", () => {
    it("closes unauthenticated connections after the auth timeout", async () => {
      const client = await WsClient.open(server.wsUrl);
      expect(await client.waitClose()).toBe(CLOSE_CODES.authTimeout);
    });

    it("rejects invalid tokens and non-auth first messages", async () => {
      const bad = await WsClient.open(server.wsUrl);
      bad.send({ type: "auth", token: "definitely-not-a-jwt" });
      expect(await bad.waitClose()).toBe(CLOSE_CODES.authFailed);
      const early = await WsClient.open(server.wsUrl);
      early.send({ type: "ping", t: 1 });
      expect(await early.waitClose()).toBe(CLOSE_CODES.authFailed);
    });

    it("rejects cross-site origins during the upgrade", async () => {
      await expect(WsClient.open(server.wsUrl, { Origin: "https://evil.example.test" })).rejects.toThrow(/403/);
    });

    it("validates messages and answers pings", async () => {
      const client = await WsClient.connect(server.wsUrl, owner.accessToken);
      client.sendRaw("not json");
      expect((await client.next("error")).code).toBe("bad_request");
      client.send({ type: "doc.join", docId: "x" });
      expect((await client.next("error")).code).toBe("validation_failed");
      client.send({ type: "ping", t: 42 });
      expect((await client.next("pong")).t).toBe(42);
      client.send({ type: "doc.join", docId: "doc_doesnotexist000" });
      expect(await client.next("error")).toMatchObject({ code: "not_found", docId: "doc_doesnotexist000" });
      client.close();
    });

    it("closes sockets when their session is revoked", async () => {
      const login = await http(server, "POST", "/api/auth/login", { body: { login: "rt_editor", password: "integration-password" } });
      const client = await WsClient.connect(server.wsUrl, login.body.data.accessToken);
      await http(server, "POST", "/api/auth/logout", { token: login.body.data.accessToken, body: {} });
      expect(await client.waitClose()).toBe(CLOSE_CODES.sessionRevoked);
    });
  });

  describe("document synchronisation", () => {
    it("relays raw CRDT ops between two clients and acknowledges the sender", async () => {
      const docId = await newDoc("hello");
      const a = await WsClient.connect(server.wsUrl, owner.accessToken);
      const b = await WsClient.connect(server.wsUrl, editorUser.accessToken);
      a.send({ type: "doc.join", docId });
      b.send({ type: "doc.join", docId });
      const joinedA = await a.next("doc.joined");
      const joinedB = await b.next("doc.joined");
      expect(joinedA.role).toBe("owner");
      const replicaA = RgaDocument.fromSnapshot(joinedA.snapshot, joinedA.site);
      const replicaB = RgaDocument.fromSnapshot(joinedB.snapshot, joinedB.site);
      const op = replicaA.insert(5, " world");
      a.send({ type: "doc.op", docId, op });
      const ack = await a.next("doc.ack");
      expect(ack).toMatchObject({ seq: 1, opSeq: 1 });
      const relayed = await b.next("doc.op");
      expect(relayed.seq).toBe(1);
      replicaB.apply(relayed.op);
      expect(replicaB.toString()).toBe("hello world");

      // Ops must use the site the server assigned to this connection.
      const spoofed = replicaB.insert(0, "x");
      a.send({ type: "doc.op", docId, op: spoofed });
      expect((await a.next("doc.resync")).reason).toBe("site_mismatch");
      a.close();
      b.close();
    });

    it("converges three clients typing concurrently (random edits)", async () => {
      const docId = await newDoc("The quick brown fox.");
      const editors = await Promise.all([
        Editor.open(server, owner.accessToken, docId),
        Editor.open(server, editorUser.accessToken, docId),
        Editor.open(server, owner.accessToken, docId),
      ]);
      const rand = mulberry32(2024);
      for (let round = 0; round < 40; round++) {
        for (const e of editors) {
          const len = e.sync.text.length;
          if (len > 0 && rand() < 0.3) {
            const at = Math.floor(rand() * len);
            e.erase(at, Math.min(1 + Math.floor(rand() * 3), len - at));
          } else {
            e.type(Math.floor(rand() * (len + 1)), "abc ".slice(0, 1 + Math.floor(rand() * 4)));
          }
        }
        if (round % 5 === 0) await sleep(5);
      }
      await eventually(() => editors.every((e) => e.sync.pendingCount === 0), 8000);
      await eventually(() => new Set(editors.map((e) => e.sync.text)).size === 1, 8000);
      const doc = await http(server, "GET", `/api/documents/${docId}`, { token: owner.accessToken });
      expect(doc.body.data.text).toBe(editors[0]?.sync.text);
      expect(doc.body.data.headSeq).toBeGreaterThanOrEqual(120);
      for (const e of editors) e.close();
    });

    it("lets viewers read live but refuses their edits", async () => {
      const docId = await newDoc("read only");
      const viewer = await Editor.open(server, viewerUser.accessToken, docId);
      expect(viewer.sync.role).toBe("viewer");
      expect(viewer.sync.applyLocalText("read only!", 10)).toBe(false);
      // A crafted op is refused server-side as well.
      const op = RgaDocument.fromText("x", "attacker").insert(0, "y");
      viewer.ws.send({ type: "doc.op", docId, op });
      expect((await viewer.ws.next("error")).code).toBe("forbidden");
      const writer = await Editor.open(server, owner.accessToken, docId);
      writer.type(9, "!");
      await eventually(() => viewer.sync.text === "read only!");
      viewer.close();
      writer.close();
    });

    it("rebases offline edits after a reconnect", async () => {
      const docId = await newDoc("base");
      const online = await Editor.open(server, owner.accessToken, docId);
      const flaky = await Editor.open(server, editorUser.accessToken, docId);
      flaky.ws.ws.terminate();
      await sleep(50);
      flaky.type(4, " offline");
      online.type(0, "online ");
      await eventually(() => online.sync.pendingCount === 0);
      // Reconnect: new socket, same DocumentSync instance (pending edits kept).
      expect(flaky.sync.pendingCount).toBe(1);
      await flaky.reconnect(server, editorUser.accessToken);
      await eventually(() => online.sync.text === "online base offline" && flaky.sync.text === "online base offline", 6000);
      online.close();
      flaky.close();
    });

    it("broadcasts version restores as ordinary operations", async () => {
      const docId = await newDoc("draft one\nkeep this line\n");
      const watcher = await Editor.open(server, editorUser.accessToken, docId);
      const v1 = await http(server, "POST", `/api/documents/${docId}/versions`, { token: owner.accessToken, body: { label: "one" } });
      watcher.erase(0, 9);
      watcher.type(0, "draft two");
      await eventually(() => watcher.sync.pendingCount === 0);
      const restored = await http(server, "POST", `/api/documents/${docId}/versions/${v1.body.data.id}/restore`, { token: owner.accessToken });
      expect(restored.body.data.text).toBe("draft one\nkeep this line\n");
      await eventually(() => watcher.sync.text === "draft one\nkeep this line\n");
      watcher.close();
    });
  });

  describe("presence", () => {
    it("shares cursors as CRDT anchors and removes peers on disconnect", async () => {
      const docId = await newDoc("presence text");
      const a = await Editor.open(server, owner.accessToken, docId);
      const b = await Editor.open(server, editorUser.accessToken, docId);
      expect(b.sync.peerList().map((p) => p.username)).toEqual(["rt_owner"]);
      b.sync.sendCursor({ start: 9, end: 13 });
      await eventually(() => a.sync.peerList().some((p) => p.cursor !== null));
      const peer = a.sync.peerList().find((p) => p.username === "rt_editor");
      expect(a.sync.resolveCursor(peer?.cursor ?? null)).toEqual({ start: 9, end: 13 });
      // Concurrent typing before the cursor shifts it.
      a.type(0, ">> ");
      expect(a.sync.resolveCursor(peer?.cursor ?? null)).toEqual({ start: 12, end: 16 });
      b.close();
      await eventually(() => a.sync.peerList().length === 0);
      a.close();
    });

    it("expires silent peers after the presence timeout", async () => {
      const docId = await newDoc("timeout");
      const watcher = await WsClient.connect(server.wsUrl, owner.accessToken);
      watcher.send({ type: "doc.join", docId });
      await watcher.next("doc.joined");
      const silent = await WsClient.connect(server.wsUrl, editorUser.accessToken);
      silent.send({ type: "doc.join", docId });
      const joined = await watcher.next((m) => m.type === "presence.update");
      const keepAlive = setInterval(() => watcher.send({ type: "ping", t: Date.now() }), 400);
      try {
        // `silent` answers protocol pings automatically but sends no app messages.
        const leave = await watcher.next((m) => m.type === "presence.leave", 6000);
        expect(leave).toMatchObject({ docId, connectionId: (joined as { peer: { connectionId: string } }).peer.connectionId });
      } finally {
        clearInterval(keepAlive);
        silent.close();
        watcher.close();
      }
    });
  });

  describe("workspace events and notifications", () => {
    it("pushes task, comment and activity events plus online users", async () => {
      const client = await WsClient.connect(server.wsUrl, editorUser.accessToken);
      client.send({ type: "workspace.subscribe", workspaceId: wsId });
      const online = await client.next("workspace.online");
      expect(online.userIds).toContain(editorUser.user.id);
      const task = await http(server, "POST", `/api/workspaces/${wsId}/tasks`, {
        token: owner.accessToken,
        body: { title: "Realtime task", assigneeId: editorUser.user.id },
      });
      const upsert = await client.next((m) => m.type === "workspace.event" && m.event.kind === "task.upserted");
      expect(upsert).toMatchObject({ event: { task: { id: task.body.data.id, title: "Realtime task" } } });
      const notification = await client.next("notification");
      expect(notification.notification.kind).toBe("task_assigned");
      expect(notification.unreadCount).toBeGreaterThan(0);
      await client.next((m) => m.type === "workspace.event" && m.event.kind === "activity");
      await http(server, "DELETE", `/api/tasks/${task.body.data.id}`, { token: owner.accessToken });
      await client.next((m) => m.type === "workspace.event" && m.event.kind === "task.deleted");
      client.send({ type: "workspace.subscribe", workspaceId: "ws_doesnotexist00" });
      expect((await client.next("error")).code).toBe("not_found");
      client.close();
    });

    it("pushes mention notifications to every connection of the user", async () => {
      const docId = await newDoc("mention target");
      const tab1 = await WsClient.connect(server.wsUrl, owner.accessToken);
      const tab2 = await WsClient.connect(server.wsUrl, owner.accessToken);
      await http(server, "POST", `/api/documents/${docId}/comments`, { token: editorUser.accessToken, body: { body: "hey @rt_owner" } });
      const [n1, n2] = await Promise.all([tab1.next("notification"), tab2.next("notification")]);
      expect(n1.notification.kind).toBe("mention");
      expect(n2.notification.id).toBe(n1.notification.id);
      tab1.close();
      tab2.close();
    });

    it("evicts members from documents when their access is revoked", async () => {
      const temp = await registerUser(server, "rt_temp");
      await http(server, "POST", `/api/workspaces/${wsId}/members`, { token: owner.accessToken, body: { identifier: "rt_temp", role: "editor" } });
      const docId = await newDoc("private soon");
      const client = await WsClient.connect(server.wsUrl, temp.accessToken);
      client.send({ type: "doc.join", docId });
      await client.next("doc.joined");
      await http(server, "DELETE", `/api/workspaces/${wsId}/members/${temp.user.id}`, { token: owner.accessToken });
      expect(await client.next("doc.closed")).toMatchObject({ docId, reason: "access revoked" });
      client.send({ type: "doc.join", docId });
      expect((await client.next("error")).code).toBe("not_found");
      client.close();
    });

    it("downgrades edit rights live when a role changes", async () => {
      const temp = await registerUser(server, "rt_demoted");
      await http(server, "POST", `/api/workspaces/${wsId}/members`, { token: owner.accessToken, body: { identifier: "rt_demoted", role: "editor" } });
      const docId = await newDoc("abc");
      const editor = await Editor.open(server, temp.accessToken, docId);
      await http(server, "PATCH", `/api/workspaces/${wsId}/members/${temp.user.id}`, { token: owner.accessToken, body: { role: "viewer" } });
      await sleep(50);
      editor.type(3, "d");
      expect((await editor.ws.next("error")).code).toBe("forbidden");
      editor.close();
    });
  });
});

describe("persistence across restarts", () => {
  it("keeps document state written over WebSockets after the server restarts", async () => {
    const databasePath = tempDbPath();
    const first = await startServer({ databasePath, documents: { snapshotEveryOps: 10 } });
    const user = await registerUser(first, "persist_user");
    const wsRes = await http(first, "POST", "/api/workspaces", { token: user.accessToken, body: { name: "Persist" } });
    const docRes = await http(first, "POST", `/api/workspaces/${wsRes.body.data.id}/documents`, {
      token: user.accessToken,
      body: { title: "Durable", content: "" },
    });
    const docId: string = docRes.body.data.id;
    const editor = await Editor.open(first, user.accessToken, docId);
    for (let i = 0; i < 25; i++) editor.type(editor.sync.text.length, `${i % 10}`);
    await eventually(() => editor.sync.pendingCount === 0);
    editor.close();
    await first.close();

    const second = await startServer({ databasePath });
    try {
      const login = await http(second, "POST", "/api/auth/login", { body: { login: "persist_user", password: "integration-password" } });
      const doc = await http(second, "GET", `/api/documents/${docId}`, { token: login.body.data.accessToken });
      expect(doc.body.data.text).toBe("0123456789012345678901234");
      const search = await http(second, "GET", "/api/search?q=durable", { token: login.body.data.accessToken });
      expect(search.body.data[0]?.id).toBe(docId);
    } finally {
      await second.close();
    }
  });
});
