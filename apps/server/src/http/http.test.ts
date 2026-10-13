import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../core/config.js";
import { readJsonBody } from "./context.js";
import { Router } from "./router.js";
import { applySecurityHeaders, clientIp, handleCors } from "./security.js";
import { StaticFiles } from "./static.js";

function fakeRequest(body: string, headers: Record<string, string> = {}, method = "POST"): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(stream, { headers, method, url: "/", socket: { remoteAddress: "10.0.0.1" } });
  queueMicrotask(() => {
    if (body) (stream as unknown as PassThrough).write(body);
    (stream as unknown as PassThrough).end();
  });
  return stream;
}

class FakeResponse extends Writable {
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  ended = false;
  setHeader(name: string, value: string | number): void {
    this.headers[name.toLowerCase()] = String(value);
  }
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  override end(...args: unknown[]): this {
    this.ended = true;
    return super.end(...(args as []));
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString();
  }
}

describe("Router", () => {
  const noop = () => null;
  const router = new Router()
    .get("/api/workspaces", noop)
    .post("/api/workspaces", noop)
    .get("/api/workspaces/:id/members/:userId", noop)
    .delete("/api/tasks/:id", noop);

  it("matches params and trailing slashes", () => {
    const m = router.match("GET", "/api/workspaces/ws_1/members/usr%202/");
    expect(m).toMatchObject({ kind: "found", params: { id: "ws_1", userId: "usr 2" } });
  });

  it("distinguishes 404 from 405", () => {
    expect(router.match("GET", "/api/nothing")).toEqual({ kind: "not_found" });
    expect(router.match("PUT", "/api/workspaces")).toEqual({ kind: "method_not_allowed", allowed: ["GET", "POST"] });
    expect(router.match("GET", "/api/tasks/%E0%A4%A")).toEqual({ kind: "method_not_allowed", allowed: ["DELETE"] });
    expect(router.match("DELETE", "/api/tasks/%E0%A4%A")).toEqual({ kind: "not_found" });
  });

  it("rejects duplicate routes and lists routes", () => {
    expect(() => router.get("/api/workspaces", noop)).toThrow(/duplicate/);
    expect(router.list()).toContainEqual({ method: "DELETE", pattern: "/api/tasks/:id", auth: true });
  });
});

describe("readJsonBody", () => {
  it("parses JSON bodies", async () => {
    await expect(readJsonBody(fakeRequest('{"a":1}', { "content-type": "application/json" }), 100)).resolves.toEqual({ a: 1 });
    await expect(readJsonBody(fakeRequest(""), 100)).resolves.toBeUndefined();
  });

  it("enforces size limits, media type and syntax", async () => {
    await expect(readJsonBody(fakeRequest("x".repeat(10), { "content-length": "500" }), 100)).rejects.toMatchObject({
      code: "payload_too_large",
    });
    await expect(readJsonBody(fakeRequest("x".repeat(200), { "content-type": "application/json" }), 100)).rejects.toMatchObject({
      code: "payload_too_large",
    });
    await expect(readJsonBody(fakeRequest("{}", { "content-type": "text/plain" }), 100)).rejects.toMatchObject({
      code: "unsupported_media_type",
    });
    await expect(readJsonBody(fakeRequest("{oops", { "content-type": "application/json" }), 100)).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

describe("security middleware", () => {
  const config = { ...defaultConfig("test"), http: { ...defaultConfig("test").http, corsOrigins: ["https://app.test"], hsts: true } };

  it("sets security headers", () => {
    const res = new FakeResponse();
    applySecurityHeaders(res as unknown as ServerResponse, config);
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["strict-transport-security"]).toContain("max-age");
  });

  it("answers preflights only for allowed origins", () => {
    const ok = new FakeResponse();
    const handled = handleCors(
      { method: "OPTIONS", headers: { origin: "https://app.test", "access-control-request-method": "POST" } } as unknown as IncomingMessage,
      ok as unknown as ServerResponse,
      config,
    );
    expect(handled).toBe(true);
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("https://app.test");
    const bad = new FakeResponse();
    handleCors(
      { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } } as unknown as IncomingMessage,
      bad as unknown as ServerResponse,
      config,
    );
    expect(bad.statusCode).toBe(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const simple = new FakeResponse();
    expect(handleCors({ method: "GET", headers: { origin: "https://app.test" } } as unknown as IncomingMessage, simple as unknown as ServerResponse, config)).toBe(
      false,
    );
    expect(simple.headers.vary).toBe("Origin");
  });

  it("honours X-Forwarded-For only behind a trusted proxy", () => {
    const req = { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.2" }, socket: { remoteAddress: "10.0.0.2" } } as unknown as IncomingMessage;
    expect(clientIp(req, true)).toBe("203.0.113.9");
    expect(clientIp(req, false)).toBe("10.0.0.2");
  });
});

describe("StaticFiles", () => {
  const root = mkdtempSync(join(tmpdir(), "rcp-static-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<html>app</html>");
  writeFileSync(join(root, "assets", "app-123.js"), "console.log(1)");
  writeFileSync(join(tmpdir(), "rcp-outside.txt"), "secret");
  const files = new StaticFiles(root);
  const get = (path: string, method = "GET") => {
    const res = new FakeResponse();
    const handled = files.serve({ method } as IncomingMessage, res as unknown as ServerResponse, path);
    return { handled, res };
  };

  it("serves assets with immutable caching", async () => {
    const { handled, res } = get("/assets/app-123.js");
    expect(handled).toBe(true);
    await new Promise((r) => res.on("finish", r));
    expect(res.text).toBe("console.log(1)");
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("falls back to index.html for client routes but not for missing files", async () => {
    const { handled, res } = get("/workspaces/abc");
    expect(handled).toBe(true);
    await new Promise((r) => res.on("finish", r));
    expect(res.text).toContain("app");
    expect(get("/missing.png").handled).toBe(false);
    expect(get("/", "POST").handled).toBe(false);
    expect(get("/", "HEAD").res.ended).toBe(true);
  });

  it("blocks path traversal", () => {
    expect(get("/../rcp-outside.txt").handled).toBe(false);
    expect(get("/%2e%2e/rcp-outside.txt").handled).toBe(false);
    expect(get("/%E0%A4%A").handled).toBe(false);
  });
});
