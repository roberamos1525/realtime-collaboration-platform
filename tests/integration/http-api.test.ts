import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, registerUser, startServer, type TestServer } from "../helpers.js";

describe("HTTP API (in-process server)", () => {
  let server: TestServer;
  let staticDir: string;

  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), "rcp-web-"));
    mkdirSync(join(staticDir, "assets"));
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>spa</title>");
    writeFileSync(join(staticDir, "assets", "app.js"), "export {}");
    server = await startServer({ staticDir, http: { corsOrigins: ["https://app.example.test"], metricsToken: "metrics-token-123456" } });
  });
  afterAll(() => server.close());

  describe("platform endpoints", () => {
    it("reports health and readiness", async () => {
      expect((await http(server, "GET", "/healthz")).body).toEqual({ data: { status: "ok" } });
      const ready = await http(server, "GET", "/readyz");
      expect(ready.status).toBe(200);
      expect(ready.body.data).toMatchObject({ status: "ready", realtime: { connections: 0 } });
    });

    it("sets security headers and propagates request ids", async () => {
      const res = await http(server, "GET", "/healthz", { headers: { "X-Request-Id": "trace-abc_123" } });
      expect(res.headers.get("x-request-id")).toBe("trace-abc_123");
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const generated = await http(server, "GET", "/healthz", { headers: { "X-Request-Id": "bad id with spaces" } });
      expect(generated.headers.get("x-request-id")).toMatch(/^req_/);
    });

    it("handles CORS preflight for allowed origins only", async () => {
      const ok = await http(server, "OPTIONS", "/api/workspaces", {
        headers: { Origin: "https://app.example.test", "Access-Control-Request-Method": "POST" },
      });
      expect(ok.status).toBe(204);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
      const denied = await http(server, "OPTIONS", "/api/workspaces", {
        headers: { Origin: "https://evil.example.test", "Access-Control-Request-Method": "POST" },
      });
      expect(denied.status).toBe(403);
    });

    it("protects metrics with a bearer token", async () => {
      expect((await http(server, "GET", "/metrics")).status).toBe(401);
      const res = await http(server, "GET", "/metrics", { headers: { Authorization: "Bearer metrics-token-123456" } });
      expect(res.status).toBe(200);
      expect(String(res.body)).toContain("rcp_http_requests_total");
    });

    it("serves the SPA with history fallback but never for API paths", async () => {
      const page = await http(server, "GET", "/w/some-workspace");
      expect(page.status).toBe(200);
      expect(String(page.body)).toContain("<title>spa</title>");
      const asset = await http(server, "GET", "/assets/app.js");
      expect(asset.headers.get("cache-control")).toContain("immutable");
      const api = await http(server, "GET", "/api/does-not-exist");
      expect(api.status).toBe(404);
      expect(api.body.error.code).toBe("not_found");
    });
  });

  describe("error envelopes and validation", () => {
    it("returns 401 without a token and 405 with Allow", async () => {
      const unauth = await http(server, "GET", "/api/workspaces");
      expect(unauth.status).toBe(401);
      expect(unauth.body.error).toMatchObject({ code: "unauthenticated" });
      expect(unauth.body.error.requestId).toMatch(/^req_/);
      const notAllowed = await http(server, "PUT", "/api/workspaces");
      expect(notAllowed.status).toBe(405);
      expect(notAllowed.headers.get("allow")).toBe("GET, POST");
    });

    it("validates bodies with field-level issues", async () => {
      const res = await http(server, "POST", "/api/auth/register", { body: { email: "nope", username: "x", displayName: "", password: "short" } });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("validation_failed");
      const paths = res.body.error.details.issues.map((i: { path: string }) => i.path);
      expect(paths).toEqual(expect.arrayContaining(["email", "username", "displayName", "password"]));
    });

    it("rejects malformed JSON, wrong media types and oversized bodies", async () => {
      expect((await http(server, "POST", "/api/auth/login", { raw: "{oops", headers: { "Content-Type": "application/json" } })).status).toBe(400);
      expect((await http(server, "POST", "/api/auth/login", { raw: "login=a", headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(415);
      const big = await http(server, "POST", "/api/auth/login", { body: { login: "x".repeat(2 * 1024 * 1024), password: "p" } });
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe("payload_too_large");
    });

    it("rejects malformed path ids", async () => {
      const user = await registerUser(server);
      const res = await http(server, "GET", "/api/workspaces/not*valid", { token: user.accessToken });
      expect(res.status).toBe(422);
    });
  });

  describe("auth lifecycle", () => {
    it("registers, logs in, refreshes with rotation and logs out", async () => {
      const user = await registerUser(server, "lifecycle");
      const me = await http(server, "GET", "/api/auth/me", { token: user.accessToken });
      expect(me.body.data).toMatchObject({ username: "lifecycle", email: "lifecycle@example.test" });
      expect(me.body.data.passwordHash).toBeUndefined();

      const dup = await http(server, "POST", "/api/auth/register", {
        body: { email: "lifecycle@example.test", username: "other1", displayName: "x", password: "integration-password" },
      });
      expect(dup.status).toBe(409);

      const bad = await http(server, "POST", "/api/auth/login", { body: { login: "lifecycle", password: "wrong-password" } });
      expect(bad.status).toBe(401);
      const login = await http(server, "POST", "/api/auth/login", { body: { login: "lifecycle", password: "integration-password" } });
      expect(login.status).toBe(200);

      const refreshed = await http(server, "POST", "/api/auth/refresh", { body: { refreshToken: login.body.data.refreshToken } });
      expect(refreshed.status).toBe(200);
      const reuse = await http(server, "POST", "/api/auth/refresh", { body: { refreshToken: login.body.data.refreshToken } });
      expect(reuse.status).toBe(401);
      // Reuse detection revoked the rotated session too.
      expect((await http(server, "GET", "/api/auth/me", { token: refreshed.body.data.accessToken })).status).toBe(401);

      const logout = await http(server, "POST", "/api/auth/logout", { token: user.accessToken, body: {} });
      expect(logout.status).toBe(204);
      expect((await http(server, "GET", "/api/auth/me", { token: user.accessToken })).status).toBe(401);
    });

    it("changes passwords and revokes other sessions", async () => {
      const user = await registerUser(server, "pwchange");
      const other = await http(server, "POST", "/api/auth/login", { body: { login: "pwchange", password: "integration-password" } });
      const res = await http(server, "POST", "/api/auth/password", {
        token: user.accessToken,
        body: { currentPassword: "integration-password", newPassword: "a brand new password" },
      });
      expect(res.body.data).toEqual({ otherSessionsRevoked: 1 });
      expect((await http(server, "GET", "/api/auth/me", { token: other.body.data.accessToken })).status).toBe(401);
    });
  });

  describe("workspaces, documents, comments, tasks", () => {
    it("runs a full collaboration workflow with role enforcement", async () => {
      const owner = await registerUser(server, "flow_owner");
      const viewer = await registerUser(server, "flow_viewer");
      const stranger = await registerUser(server, "flow_stranger");

      const ws = await http(server, "POST", "/api/workspaces", { token: owner.accessToken, body: { name: "Flow Team", description: "it" } });
      expect(ws.status).toBe(201);
      const wsId: string = ws.body.data.id;
      expect(ws.body.data).toMatchObject({ role: "owner", slug: "flow-team", memberCount: 1 });

      const added = await http(server, "POST", `/api/workspaces/${wsId}/members`, {
        token: owner.accessToken,
        body: { identifier: "flow_viewer@example.test", role: "viewer" },
      });
      expect(added.status).toBe(201);
      expect(added.body.data).toHaveLength(2);

      const doc = await http(server, "POST", `/api/workspaces/${wsId}/documents`, {
        token: owner.accessToken,
        body: { title: "Launch plan", content: "Ship the realtime editor on Friday." },
      });
      expect(doc.status).toBe(201);
      const docId: string = doc.body.data.id;

      // Strangers cannot even see that the workspace exists.
      expect((await http(server, "GET", `/api/workspaces/${wsId}`, { token: stranger.accessToken })).status).toBe(404);
      expect((await http(server, "GET", `/api/documents/${docId}`, { token: stranger.accessToken })).status).toBe(404);

      // Viewers read but cannot write.
      const read = await http(server, "GET", `/api/documents/${docId}`, { token: viewer.accessToken });
      expect(read.body.data).toMatchObject({ text: "Ship the realtime editor on Friday.", role: "viewer" });
      expect((await http(server, "PATCH", `/api/documents/${docId}`, { token: viewer.accessToken, body: { title: "x" } })).status).toBe(403);
      expect(
        (await http(server, "POST", `/api/documents/${docId}/comments`, { token: viewer.accessToken, body: { body: "hello" } })).status,
      ).toBe(403);

      // Promote to commenter; mention the owner.
      await http(server, "PATCH", `/api/workspaces/${wsId}/members/${viewer.user.id}`, { token: owner.accessToken, body: { role: "commenter" } });
      const comment = await http(server, "POST", `/api/documents/${docId}/comments`, {
        token: viewer.accessToken,
        body: { body: "@flow_owner should we add a checklist?" },
      });
      expect(comment.status).toBe(201);
      const resolve = await http(server, "POST", `/api/comments/${comment.body.data.id}/resolve`, { token: owner.accessToken });
      expect(resolve.body.data.resolvedBy).toBe(owner.user.id);

      const inbox = await http(server, "GET", "/api/notifications?unread=true", { token: owner.accessToken });
      expect(inbox.body.data.items[0]).toMatchObject({ kind: "mention", documentId: docId });
      expect(inbox.body.data.unreadCount).toBe(1);
      const count = await http(server, "GET", "/api/notifications/unread-count", { token: owner.accessToken });
      expect(count.body.data.unreadCount).toBe(1);
      await http(server, "POST", "/api/notifications/read-all", { token: owner.accessToken });
      expect((await http(server, "GET", "/api/notifications/unread-count", { token: owner.accessToken })).body.data.unreadCount).toBe(0);

      // Tasks: create, move, filter.
      const task = await http(server, "POST", `/api/workspaces/${wsId}/tasks`, {
        token: owner.accessToken,
        body: { title: "Write checklist", priority: "high", labels: ["docs"], assigneeId: owner.user.id, documentId: docId },
      });
      expect(task.status).toBe(201);
      const moved = await http(server, "POST", `/api/tasks/${task.body.data.id}/move`, { token: owner.accessToken, body: { status: "in_progress" } });
      expect(moved.body.data.status).toBe("in_progress");
      const filtered = await http(server, "GET", `/api/workspaces/${wsId}/tasks?status=in_progress&label=docs`, { token: viewer.accessToken });
      expect(filtered.body.data.map((t: { id: string }) => t.id)).toEqual([task.body.data.id]);
      expect((await http(server, "GET", `/api/workspaces/${wsId}/tasks?status=bogus`, { token: viewer.accessToken })).status).toBe(422);

      // Versions and restore via HTTP.
      const v1 = await http(server, "POST", `/api/documents/${docId}/versions`, { token: owner.accessToken, body: { label: "v1" } });
      expect(v1.status).toBe(201);
      const versions = await http(server, "GET", `/api/documents/${docId}/versions`, { token: viewer.accessToken });
      expect(versions.body.data[0]).toMatchObject({ label: "v1", length: 35 });

      // Search finds the document, comment and task; strangers find nothing.
      const search = await http(server, "GET", "/api/search?q=checklist", { token: viewer.accessToken });
      expect(search.body.data.map((h: { type: string }) => h.type).sort()).toEqual(["comment", "task"]);
      const docSearch = await http(server, "GET", `/api/search?q=realtime%20edit&types=document&workspaceId=${wsId}`, { token: viewer.accessToken });
      expect(docSearch.body.data[0]).toMatchObject({ type: "document", id: docId });
      expect(docSearch.body.data[0].highlights.length).toBeGreaterThan(0);
      expect((await http(server, "GET", "/api/search?q=checklist", { token: stranger.accessToken })).body.data).toEqual([]);

      // Activity feed paginates.
      const activity = await http(server, "GET", `/api/workspaces/${wsId}/activity?limit=3`, { token: viewer.accessToken });
      expect(activity.body.data.items).toHaveLength(3);
      expect(activity.body.data.nextCursor).toBeTruthy();
      const older = await http(server, "GET", `/api/workspaces/${wsId}/activity?limit=50&cursor=${activity.body.data.nextCursor}`, {
        token: viewer.accessToken,
      });
      expect(older.body.data.items.at(-1).verb).toBe("workspace.created");

      // Deleting requires admin; then the document is gone.
      expect((await http(server, "DELETE", `/api/documents/${docId}`, { token: viewer.accessToken })).status).toBe(403);
      expect((await http(server, "DELETE", `/api/documents/${docId}`, { token: owner.accessToken })).status).toBe(204);
      expect((await http(server, "GET", `/api/documents/${docId}`, { token: owner.accessToken })).status).toBe(404);

      // Leaving and deleting the workspace.
      expect((await http(server, "DELETE", `/api/workspaces/${wsId}/members/${viewer.user.id}`, { token: viewer.accessToken })).status).toBe(204);
      expect((await http(server, "DELETE", `/api/workspaces/${wsId}`, { token: owner.accessToken })).status).toBe(204);
      expect((await http(server, "GET", "/api/workspaces", { token: owner.accessToken })).body.data).toEqual([]);
    });

    it("searches users for the member picker", async () => {
      const user = await registerUser(server, "picker_user");
      const res = await http(server, "GET", "/api/users?q=picker", { token: user.accessToken });
      expect(res.body.data).toEqual([{ id: user.user.id, username: "picker_user", displayName: "User picker_user" }]);
      expect((await http(server, "GET", "/api/users?q=p", { token: user.accessToken })).status).toBe(422);
    });
  });
});

describe("rate limiting", () => {
  it("throttles auth endpoints per IP with Retry-After", async () => {
    const server = await startServer({ rateLimit: { auth: { capacity: 3, refillPerSecond: 0.01 } } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        statuses.push((await http(server, "POST", "/api/auth/login", { body: { login: "nobody", password: "whatever" } })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 429, 429]);
      const limited = await http(server, "POST", "/api/auth/login", { body: { login: "nobody", password: "whatever" } });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(limited.body.error.code).toBe("rate_limited");
      // Other endpoints are unaffected by the auth bucket.
      expect((await http(server, "GET", "/healthz")).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
