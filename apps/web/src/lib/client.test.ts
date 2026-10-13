import { CLOSE_CODES, type AuthResult, type ServerMessage } from "@rcp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, errorMessage, type KeyValueStorage } from "./api";
import { describeActivity, initials, relativeTime } from "./format";
import { buildOverlay, withAlpha } from "./overlay";
import { matchPath, queryParam, resolveRoute } from "./router";
import { RealtimeClient, type SocketLike } from "./socket";
import { createStore } from "./store";

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function authResult(token: string, expiresInMs = 900_000): AuthResult {
  return {
    user: { id: "usr_1", username: "alice", displayName: "Alice", email: "a@example.test", createdAt: "2026-01-01T00:00:00Z" },
    accessToken: token,
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    refreshToken: `refresh-${token}`,
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

describe("ApiClient", () => {
  it("unwraps data envelopes and persists sessions", async () => {
    const storage = new MemoryStorage();
    const fetchMock = vi.fn(async () => json(200, { data: authResult("tok-1") }));
    const api = new ApiClient({ fetch: fetchMock as unknown as typeof fetch, storage });
    const user = await api.login("alice", "pw");
    expect(user.username).toBe("alice");
    expect(JSON.parse(storage.getItem("rcp.session") as string).accessToken).toBe("tok-1");
    expect(new ApiClient({ fetch: fetchMock as unknown as typeof fetch, storage }).currentSession?.user.id).toBe("usr_1");
  });

  it("converts error envelopes into ApiError with field messages", async () => {
    const fetchMock = vi.fn(async () =>
      json(422, { error: { code: "validation_failed", message: "request validation failed", details: { issues: [{ path: "title", message: "Required" }] } } }),
    );
    const api = new ApiClient({ fetch: fetchMock as unknown as typeof fetch, storage: null });
    const err = await api.createWorkspace("").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("validation_failed");
    expect(errorMessage(err)).toBe("title: Required");
    expect(errorMessage(new Error("plain"))).toBe("plain");
  });

  it("refreshes once on 401 and retries, coalescing concurrent refreshes", async () => {
    const storage = new MemoryStorage();
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/auth/refresh")) {
        refreshCalls++;
        return json(200, { data: authResult("tok-2") });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer tok-2" ? json(200, { data: ["ok"] }) : json(401, { error: { code: "token_expired", message: "expired" } });
    });
    const api = new ApiClient({ fetch: fetchMock as unknown as typeof fetch, storage });
    api.setSession(authResult("tok-1"));
    const [a, b] = await Promise.all([api.listWorkspaces(), api.listWorkspaces()]);
    expect(a).toEqual(["ok"]);
    expect(b).toEqual(["ok"]);
    expect(refreshCalls).toBe(1);
    expect(api.currentSession?.accessToken).toBe("tok-2");
  });

  it("clears the session when refresh fails", async () => {
    const fetchMock = vi.fn(async () => json(401, { error: { code: "unauthenticated", message: "nope" } }));
    const api = new ApiClient({ fetch: fetchMock as unknown as typeof fetch, storage: new MemoryStorage() });
    api.setSession(authResult("tok-1"));
    const changes: Array<string | null> = [];
    api.onSessionChange((s) => changes.push(s?.accessToken ?? null));
    await expect(api.listWorkspaces()).rejects.toBeInstanceOf(ApiError);
    expect(api.currentSession).toBeNull();
    expect(changes).toEqual([null]);
  });

  it("refreshes proactively before handing out nearly expired tokens", async () => {
    const fetchMock = vi.fn(async () => json(200, { data: authResult("fresh") }));
    const api = new ApiClient({ fetch: fetchMock as unknown as typeof fetch, storage: null });
    api.setSession(authResult("stale", 10_000));
    expect(await api.freshAccessToken()).toBe("fresh");
    expect(await api.freshAccessToken()).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports network failures and handles 204 responses", async () => {
    const failing = new ApiClient({ fetch: (async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch, storage: null });
    await expect(failing.listWorkspaces()).rejects.toMatchObject({ code: "network" });
    const empty = new ApiClient({ fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch, storage: null });
    await expect(empty.deleteTask("tsk_12345678")).resolves.toBeUndefined();
  });

  it("encodes search parameters", async () => {
    const fetchMock = vi.fn(async (_url: string) => json(200, { data: [] }));
    const api = new ApiClient({ fetch: fetchMock as unknown as typeof fetch, storage: null });
    await api.search("a&b c", { workspaceId: "ws_12345678", types: ["task", "comment"] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/search?q=a%26b+c&limit=30&workspaceId=ws_12345678&types=task%2Ccomment");
  });
});

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  get parsed() {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
}

describe("RealtimeClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (onAuthLost = vi.fn()) =>
    new RealtimeClient({
      url: "ws://test/ws",
      getToken: async () => "token-123",
      createSocket: (url) => new FakeSocket(url),
      onAuthLost,
      random: () => 0,
    });

  it("authenticates first, then replays subscriptions once ready", async () => {
    const client = make();
    client.retainDoc("doc_a0000001");
    client.retainWorkspace("ws_a0000001");
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    expect(socket.parsed).toEqual([{ type: "auth", token: "token-123" }]);
    expect(client.send({ type: "ping", t: 1 })).toBe(false);
    socket.receive({ type: "ready", userId: "u", connectionId: "c", heartbeatMs: 5000 });
    expect(client.status).toBe("open");
    expect(socket.parsed.map((m) => m.type)).toEqual(["auth", "doc.join", "workspace.subscribe"]);
    vi.advanceTimersByTime(5000);
    expect(socket.parsed.at(-1)?.type).toBe("ping");
  });

  it("reference-counts subscriptions", async () => {
    const client = make();
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0] as FakeSocket;
    socket.open();
    socket.receive({ type: "ready", userId: "u", connectionId: "c", heartbeatMs: 5000 });
    const release1 = client.retainDoc("doc_a0000001");
    const release2 = client.retainDoc("doc_a0000001");
    release1();
    expect(socket.parsed.filter((m) => m.type === "doc.leave")).toHaveLength(0);
    release2();
    expect(socket.parsed.filter((m) => m.type === "doc.leave")).toHaveLength(1);
    expect(socket.parsed.filter((m) => m.type === "doc.join")).toHaveLength(1);
  });

  it("reconnects with exponential backoff and stops on session revocation", async () => {
    const onAuthLost = vi.fn();
    const client = make(onAuthLost);
    const statuses: string[] = [];
    client.onStatus((s) => statuses.push(s));
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    (FakeSocket.instances[0] as FakeSocket).serverClose(1006);
    expect(statuses).toContain("reconnecting");
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    (FakeSocket.instances[1] as FakeSocket).serverClose(1006);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);
    (FakeSocket.instances[2] as FakeSocket).serverClose(CLOSE_CODES.sessionRevoked);
    expect(onAuthLost).toHaveBeenCalled();
    expect(client.status).toBe("closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("does not reconnect after an explicit disconnect and gives up without a token", async () => {
    const client = make();
    client.connect();
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    const onAuthLost = vi.fn();
    const noToken = new RealtimeClient({ url: "ws://x", getToken: async () => null, createSocket: (u) => new FakeSocket(u), onAuthLost });
    noToken.connect();
    await vi.waitFor(() => expect(onAuthLost).toHaveBeenCalled());
    expect(noToken.status).toBe("closed");
  });
});

describe("overlay", () => {
  it("splits text by highlight boundaries and inserts carets", () => {
    const pieces = buildOverlay(
      "hello world",
      [
        { id: "a", from: 0, to: 5, color: "#ff0000", kind: "selection" },
        { id: "b", from: 3, to: 8, color: "#00ff00", kind: "comment" },
      ],
      [{ id: "c1", at: 6, color: "#0000ff", label: "Bob" }],
    );
    expect(pieces.map((p) => (p.kind === "caret" ? `|${p.caret.label}` : `${p.text}[${p.highlights.map((h) => h.id).join("")}]`))).toEqual([
      "hel[a]",
      "lo[ab]",
      " [b]",
      "|Bob",
      "wo[b]",
      "rld[]",
    ]);
  });

  it("clamps out-of-range input and drops empty highlights", () => {
    const pieces = buildOverlay("abc", [{ id: "x", from: 2, to: 2, color: "#000000", kind: "comment" }], [{ id: "c", at: 99, color: "#000000", label: "Z" }]);
    expect(pieces).toEqual([
      { kind: "text", text: "abc", highlights: [] },
      { kind: "caret", caret: { id: "c", at: 3, color: "#000000", label: "Z" } },
    ]);
    expect(withAlpha("#3e63dd", 0.5)).toBe("rgba(62, 99, 221, 0.5)");
    expect(withAlpha("red", 0.5)).toBe("red");
  });
});

describe("router", () => {
  it("matches patterns with params", () => {
    expect(matchPath("/w/:id/tasks", "/w/ws_1/tasks")).toEqual({ id: "ws_1" });
    expect(matchPath("/w/:id", "/w/ws_1/tasks")).toBeNull();
    expect(matchPath("/d/:id", "/d/a%20b?x=1")).toEqual({ id: "a b" });
    expect(matchPath("/d/:id", "/d/%E0%A4%A")).toBeNull();
    expect(matchPath("/", "/")).toEqual({});
  });

  it("resolves routes in order and reads query params", () => {
    const routes = [
      { name: "doc", pattern: "/d/:id" },
      { name: "search", pattern: "/search" },
    ] as const;
    expect(resolveRoute(routes, "/search")).toEqual({ name: "search", params: {} });
    expect(resolveRoute(routes, "/nope")).toBeNull();
    expect(queryParam("/search?q=hello%20world", "q")).toBe("hello world");
    expect(queryParam("/search", "q")).toBeNull();
  });
});

describe("store and formatting", () => {
  it("notifies subscribers of changes only", () => {
    const store = createStore({ count: 0, name: "x" });
    const calls = vi.fn();
    const off = store.subscribe(calls);
    store.set({ count: 1 });
    store.set((s) => s);
    expect(store.get()).toEqual({ count: 1, name: "x" });
    expect(calls).toHaveBeenCalledTimes(1);
    off();
    store.set({ count: 2 });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("formats relative times, initials and activity", () => {
    const now = Date.parse("2026-05-10T12:00:00Z");
    expect(relativeTime("2026-05-10T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-05-10T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-05-10T07:00:00Z", now)).toBe("5 h ago");
    expect(relativeTime("2026-05-08T12:00:00Z", now)).toBe("2 d ago");
    expect(relativeTime("garbage", now)).toBe("");
    expect(initials("Ada Lovelace King")).toBe("AK");
    expect(initials(" ")).toBe("?");
    expect(describeActivity("task.status_changed", { title: "Ship", from: "todo", to: "done" })).toBe('moved task “Ship” (todo → done)');
    expect(describeActivity("document.renamed", { from: "A", to: "B" })).toBe("renamed “A” to “B”");
    expect(describeActivity("member.added", { username: "bob", role: "editor" })).toBe("added bob as editor");
    expect(describeActivity("custom.verb_x", {})).toBe("custom verb x");
  });
});
