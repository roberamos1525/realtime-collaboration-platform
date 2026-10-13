import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthResult, ClientMessage, ServerMessage } from "@rcp/shared";
import WebSocket from "ws";
import { createApp, type App } from "../apps/server/src/app.js";
import { deepMerge, type ConfigOverrides } from "../apps/server/src/core/config.js";
import { createLogger } from "../apps/server/src/core/logger.js";
import { testConfig } from "../apps/server/src/__tests__/helpers.js";

export interface TestServer {
  readonly app: App;
  readonly baseUrl: string;
  readonly wsUrl: string;
  close(): Promise<void>;
}

/** Starts the full HTTP + WebSocket server on an ephemeral port. */
export async function startServer(overrides: ConfigOverrides = {}): Promise<TestServer> {
  const config = deepMerge(
    testConfig({
      rateLimit: { global: { capacity: 10_000, refillPerSecond: 10_000 }, auth: { capacity: 1000, refillPerSecond: 1000 }, ws: { capacity: 10_000, refillPerSecond: 10_000 } },
    }),
    overrides,
  );
  const app = createApp(config, { logger: createLogger("silent") });
  const address = await app.listen(0, "127.0.0.1");
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    close: () => app.close(),
  };
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rcp-it-")), "db.sqlite");
}

export interface HttpResult<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export async function http<T = any>(
  server: { baseUrl: string },
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.raw !== undefined) body = options.raw;
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Type"] ??= "application/json";
  }
  const res = await fetch(`${server.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

let userCounter = 0;

export async function registerUser(server: TestServer, username = `it_user${++userCounter}`): Promise<AuthResult & { username: string }> {
  const res = await http<{ data: AuthResult }>(server, "POST", "/api/auth/register", {
    body: { email: `${username}@example.test`, username, displayName: `User ${username}`, password: "integration-password" },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body.data, username };
}

/** WebSocket test client with a message queue and predicate waits. */
export class WsClient {
  readonly messages: ServerMessage[] = [];
  private waiters: Array<{ predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  closeCode: number | null = null;
  private closeWaiters: Array<(code: number) => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(msg);
      const waiter = this.waiters.find((w) => w.predicate(msg));
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(msg);
      }
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      for (const w of this.closeWaiters) w(code);
      this.closeWaiters = [];
    });
  }

  static async open(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
    const ws = new WebSocket(url, { headers });
    const client = new WsClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return client;
  }

  static async connect(url: string, token: string): Promise<WsClient> {
    const client = await WsClient.open(url);
    client.send({ type: "auth", token });
    await client.next((m) => m.type === "ready");
    return client;
  }

  send(msg: ClientMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  /** Resolves with the first already-received or future message matching. */
  next<T extends ServerMessage["type"]>(
    predicate: ((m: ServerMessage) => boolean) | T,
    timeoutMs = 4000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const pred = typeof predicate === "string" ? (m: ServerMessage) => m.type === predicate : predicate;
    const existing = this.messages.find(pred);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`timed out waiting for message (${typeof predicate === "string" ? predicate : "predicate"})`));
      }, timeoutMs);
      const done = (m: ServerMessage) => {
        clearTimeout(timer);
        const idx = this.messages.indexOf(m);
        if (idx >= 0) this.messages.splice(idx, 1);
        resolve(m as Extract<ServerMessage, { type: T }>);
      };
      this.waiters.push({ predicate: pred, resolve: done });
    });
  }

  waitClose(timeoutMs = 4000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls until `check` returns true or the timeout elapses. */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 4000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error("condition not met in time");
}
