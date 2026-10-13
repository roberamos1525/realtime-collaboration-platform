import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  CLOSE_CODES,
  MAX_WS_MESSAGE_BYTES,
  can,
  clientMessageSchema,
  type ClientMessage,
  type Role,
  type ServerMessage,
} from "@rcp/shared";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { AuthContext, AuthService } from "../auth/auth-service.js";
import type { AppConfig } from "../core/config.js";
import { AppError } from "../core/errors.js";
import type { EventBus } from "../core/events.js";
import type { Logger } from "../core/logger.js";
import type { AppMetrics } from "../core/metrics.js";
import { RateLimiter } from "../core/rate-limiter.js";
import { newId, type Clock } from "../core/util.js";
import type { AccessControl } from "../services/context.js";
import type { DocSessionManager } from "../services/doc-sessions.js";
import { PresenceTracker } from "./presence.js";

interface JoinedDoc {
  readonly workspaceId: string;
  role: Role;
  readonly site: string;
}

interface Connection {
  readonly id: string;
  readonly ws: WebSocket;
  readonly ip: string;
  auth: AuthContext | null;
  readonly docs: Map<string, JoinedDoc>;
  readonly workspaces: Set<string>;
  alive: boolean;
  violations: number;
  authTimer: NodeJS.Timeout | null;
}

export interface GatewayDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: AppMetrics;
  readonly events: EventBus;
  readonly clock: Clock;
  readonly auth: AuthService;
  readonly access: AccessControl;
  readonly sessions: DocSessionManager;
}

const MAX_VIOLATIONS = 20;

/**
 * WebSocket endpoint (`/ws`). Clients authenticate with their access token in
 * the first message, then join documents (CRDT sync + presence) and subscribe
 * to workspaces (tasks, comments, activity, online users). Every message is
 * schema-validated, rate limited and authorised against the member's current
 * role, which is re-evaluated whenever memberships change.
 */
export class RealtimeGateway {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Connection>();
  private readonly byUser = new Map<string, Set<Connection>>();
  private readonly docRooms = new Map<string, Set<Connection>>();
  private readonly workspaceRooms = new Map<string, Set<Connection>>();
  readonly presence = new PresenceTracker();
  private readonly limiter: RateLimiter;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly logger: Logger;

  constructor(private readonly deps: GatewayDeps) {
    this.logger = deps.logger.child({ component: "gateway" });
    this.limiter = new RateLimiter(deps.config.rateLimit.ws, deps.clock);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES, perMessageDeflate: false });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    this.heartbeat = setInterval(() => this.tick(), deps.config.realtime.heartbeatIntervalMs);
    this.heartbeat.unref();
    deps.metrics.wsConnections.collect(() => this.connections.size);
    this.subscribe();
  }

  // ---------------------------------------------------------------- upgrade

  /** Handles an HTTP upgrade request; returns false if the path is not ours. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return false;
    if (!this.originAllowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      this.logger.warn("websocket origin rejected", { origin: req.headers.origin });
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    return true;
  }

  /** Cross-site WebSocket hijacking protection: browsers always send Origin. */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (this.deps.config.http.corsOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const conn: Connection = {
      id: newId("conn", 12),
      ws,
      ip: req.socket.remoteAddress ?? "unknown",
      auth: null,
      docs: new Map(),
      workspaces: new Set(),
      alive: true,
      violations: 0,
      authTimer: null,
    };
    this.connections.set(conn.id, conn);
    conn.authTimer = setTimeout(() => this.close(conn, CLOSE_CODES.authTimeout, "authentication timeout"), this.deps.config.realtime.authTimeoutMs);
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.close(conn, CLOSE_CODES.invalidMessage, "binary frames are not supported");
        return;
      }
      this.onMessage(conn, data);
    });
    ws.on("close", () => this.cleanup(conn));
    ws.on("error", (err) => this.logger.debug("websocket error", { connectionId: conn.id, err }));
  }

  // --------------------------------------------------------------- messages

  private onMessage(conn: Connection, data: RawData): void {
    conn.alive = true;
    const rate = this.limiter.take(conn.id);
    if (!rate.allowed) {
      this.deps.metrics.rateLimited.inc({ scope: "ws" });
      this.send(conn, { type: "error", code: "rate_limited", message: "too many messages" });
      if (++conn.violations > MAX_VIOLATIONS) this.close(conn, CLOSE_CODES.rateLimited, "rate limit exceeded");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.violation(conn, "bad_request", "message is not valid JSON");
      return;
    }
    const parsed = clientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.violation(conn, "validation_failed", parsed.error.issues[0]?.message ?? "invalid message");
      return;
    }
    const msg = parsed.data;
    this.deps.metrics.wsMessagesIn.inc({ type: msg.type });
    if (!conn.auth) {
      if (msg.type !== "auth") {
        this.close(conn, CLOSE_CODES.authFailed, "authenticate first");
        return;
      }
      this.authenticate(conn, msg.token);
      return;
    }
    this.presence.touch(conn.id, this.deps.clock.now());
    try {
      this.dispatch(conn, msg);
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      if (!appErr) this.logger.error("websocket handler failed", { type: msg.type, err });
      this.send(conn, {
        type: "error",
        code: appErr?.code ?? "internal",
        message: appErr?.message ?? "internal error",
        ...("docId" in msg ? { docId: msg.docId } : {}),
      });
    }
  }

  private dispatch(conn: Connection, msg: ClientMessage): void {
    switch (msg.type) {
      case "auth":
        this.send(conn, { type: "error", code: "bad_request", message: "already authenticated" });
        return;
      case "ping":
        this.send(conn, { type: "pong", t: msg.t });
        return;
      case "doc.join":
        this.joinDoc(conn, msg.docId);
        return;
      case "doc.leave":
        this.leaveDoc(conn, msg.docId, true);
        return;
      case "doc.op":
        this.applyOp(conn, msg.docId, msg.op);
        return;
      case "doc.ack":
        if (conn.docs.has(msg.docId)) this.deps.sessions.ack(msg.docId, conn.id, msg.seq);
        return;
      case "presence.update": {
        if (!conn.docs.has(msg.docId)) throw new AppError("not_found", "join the document first");
        const peer = this.presence.update(msg.docId, conn.id, msg.cursor, this.deps.clock.now());
        if (peer) this.broadcastDoc(msg.docId, { type: "presence.update", docId: msg.docId, peer }, conn);
        return;
      }
      case "workspace.subscribe": {
        const user = conn.auth as AuthContext;
        this.deps.access.requireWorkspace(user.user.id, msg.workspaceId, "workspace.read");
        conn.workspaces.add(msg.workspaceId);
        this.room(this.workspaceRooms, msg.workspaceId).add(conn);
        this.broadcastOnline(msg.workspaceId);
        return;
      }
      case "workspace.unsubscribe":
        this.unsubscribeWorkspace(conn, msg.workspaceId);
        return;
    }
  }

  private authenticate(conn: Connection, token: string): void {
    let auth: AuthContext;
    try {
      auth = this.deps.auth.authenticate(token);
    } catch (err) {
      const code = err instanceof AppError ? err.code : "unauthenticated";
      this.send(conn, { type: "error", code, message: "authentication failed" });
      this.close(conn, CLOSE_CODES.authFailed, "authentication failed");
      return;
    }
    const existing = this.byUser.get(auth.user.id);
    if (existing && existing.size >= this.deps.config.realtime.maxConnectionsPerUser) {
      this.send(conn, { type: "error", code: "rate_limited", message: "too many open connections" });
      this.close(conn, CLOSE_CODES.rateLimited, "too many connections");
      return;
    }
    if (conn.authTimer) clearTimeout(conn.authTimer);
    conn.authTimer = null;
    conn.auth = auth;
    this.room(this.byUser, auth.user.id).add(conn);
    this.send(conn, { type: "ready", userId: auth.user.id, connectionId: conn.id, heartbeatMs: this.deps.config.realtime.heartbeatIntervalMs });
  }

  private joinDoc(conn: Connection, docId: string): void {
    const user = (conn.auth as AuthContext).user;
    const { document, role } = this.deps.access.requireDocument(user.id, docId, "document.read");
    if (conn.docs.has(docId)) this.leaveDoc(conn, docId, false);
    const { session, participant } = this.deps.sessions.join(docId, conn.id, user.id);
    conn.docs.set(docId, { workspaceId: document.workspaceId, role, site: participant.site });
    this.room(this.docRooms, docId).add(conn);
    const peer = this.presence.join(
      docId,
      { connectionId: conn.id, userId: user.id, username: user.username, displayName: user.displayName },
      this.deps.clock.now(),
    );
    this.send(conn, {
      type: "doc.joined",
      docId,
      site: participant.site,
      snapshot: session.doc.snapshot(),
      seq: session.headSeq,
      role,
      peers: this.presence.peers(docId).filter((p) => p.connectionId !== conn.id),
    });
    this.broadcastDoc(docId, { type: "presence.update", docId, peer }, conn);
  }

  private leaveDoc(conn: Connection, docId: string, notifyPeers: boolean): void {
    if (!conn.docs.delete(docId)) return;
    this.deps.sessions.leave(docId, conn.id);
    this.docRooms.get(docId)?.delete(conn);
    if (this.docRooms.get(docId)?.size === 0) this.docRooms.delete(docId);
    if (this.presence.leave(docId, conn.id) && notifyPeers) {
      this.broadcastDoc(docId, { type: "presence.leave", docId, connectionId: conn.id });
    }
  }

  private applyOp(conn: Connection, docId: string, op: Extract<ClientMessage, { type: "doc.op" }>["op"]): void {
    const joined = conn.docs.get(docId);
    if (!joined) throw new AppError("not_found", "join the document first");
    if (!can(joined.role, "document.edit")) {
      this.deps.metrics.docOpsRejected.inc({ reason: "forbidden" });
      throw new AppError("forbidden", `your role (${joined.role}) cannot edit this document`);
    }
    const outcome = this.deps.sessions.applyClientOp(docId, conn.id, op);
    if (outcome.status === "applied") {
      this.send(conn, { type: "doc.ack", docId, seq: outcome.seq, opSeq: op.seq });
      this.broadcastDoc(docId, { type: "doc.op", docId, op, seq: outcome.seq, userId: (conn.auth as AuthContext).user.id }, conn);
    } else if (outcome.status === "rejected") {
      this.logger.info("op rejected; asking client to resync", { docId, connectionId: conn.id, reason: outcome.reason });
      this.send(conn, { type: "doc.resync", docId, reason: outcome.reason });
    }
  }

  private unsubscribeWorkspace(conn: Connection, workspaceId: string): void {
    if (!conn.workspaces.delete(workspaceId)) return;
    const room = this.workspaceRooms.get(workspaceId);
    room?.delete(conn);
    if (room?.size === 0) this.workspaceRooms.delete(workspaceId);
    this.broadcastOnline(workspaceId);
  }

  // ---------------------------------------------------------- domain events

  private subscribe(): void {
    const { events } = this.deps;
    const toWorkspace = (workspaceId: string, event: Extract<ServerMessage, { type: "workspace.event" }>["event"]) =>
      this.broadcastWorkspace(workspaceId, { type: "workspace.event", workspaceId, event });
    this.unsubscribers.push(
      events.on("task.upserted", ({ task }) => toWorkspace(task.workspaceId, { kind: "task.upserted", task })),
      events.on("task.deleted", (e) => toWorkspace(e.workspaceId, { kind: "task.deleted", taskId: e.taskId })),
      events.on("comment.upserted", ({ comment }) => toWorkspace(comment.workspaceId, { kind: "comment.upserted", comment })),
      events.on("comment.deleted", (e) => toWorkspace(e.workspaceId, { kind: "comment.deleted", commentId: e.commentId, documentId: e.documentId })),
      events.on("document.upserted", ({ document }) => {
        toWorkspace(document.workspaceId, { kind: "document.upserted", document });
        this.broadcastDoc(document.id, { type: "doc.meta", docId: document.id, title: document.title });
      }),
      events.on("document.deleted", (e) => {
        toWorkspace(e.workspaceId, { kind: "document.deleted", documentId: e.documentId });
        this.closeDocRoom(e.documentId, "document deleted");
      }),
      events.on("activity.created", ({ activity }) => toWorkspace(activity.workspaceId, { kind: "activity", activity })),
      events.on("notification.created", (e) => {
        for (const conn of this.byUser.get(e.userId) ?? []) {
          this.send(conn, { type: "notification", notification: e.notification, unreadCount: e.unreadCount });
        }
      }),
      events.on("membership.changed", (e) => {
        this.reauthorize(e.userId, e.workspaceId);
        toWorkspace(e.workspaceId, { kind: "members.changed" });
      }),
      events.on("workspace.deleted", (e) => {
        for (const conn of [...(this.workspaceRooms.get(e.workspaceId) ?? [])]) this.unsubscribeWorkspace(conn, e.workspaceId);
        for (const conn of this.connections.values()) {
          for (const [docId, joined] of [...conn.docs]) {
            if (joined.workspaceId === e.workspaceId) {
              this.send(conn, { type: "doc.closed", docId, reason: "workspace deleted" });
              this.leaveDoc(conn, docId, true);
            }
          }
        }
      }),
      events.on("session.revoked", (e) => {
        for (const conn of this.connections.values()) {
          if (conn.auth?.sessionId === e.sessionId) this.close(conn, CLOSE_CODES.sessionRevoked, "session revoked");
        }
      }),
    );
    this.unsubscribers.push(
      this.deps.sessions.onServerOps((session, ops, actorId) => {
        for (const { op, seq } of ops) {
          this.broadcastDoc(session.id, { type: "doc.op", docId: session.id, op, seq, userId: actorId ?? "system" });
        }
      }),
    );
  }

  /** Re-checks a user's role after a membership change and evicts if needed. */
  private reauthorize(userId: string, workspaceId: string): void {
    const role = this.deps.access.roleIn(workspaceId, userId);
    for (const conn of this.byUser.get(userId) ?? []) {
      for (const [docId, joined] of [...conn.docs]) {
        if (joined.workspaceId !== workspaceId) continue;
        if (!role) {
          this.send(conn, { type: "doc.closed", docId, reason: "access revoked" });
          this.leaveDoc(conn, docId, true);
        } else {
          joined.role = role;
        }
      }
      if (!role && conn.workspaces.has(workspaceId)) this.unsubscribeWorkspace(conn, workspaceId);
    }
  }

  private closeDocRoom(docId: string, reason: string): void {
    for (const conn of [...(this.docRooms.get(docId) ?? [])]) {
      this.send(conn, { type: "doc.closed", docId, reason });
      this.leaveDoc(conn, docId, false);
    }
  }

  // ---------------------------------------------------------------- helpers

  private room<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    return set;
  }

  private send(conn: Connection, msg: ServerMessage): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > this.deps.config.realtime.maxBufferedBytes) {
      this.logger.warn("terminating slow websocket consumer", { connectionId: conn.id });
      conn.ws.terminate();
      return;
    }
    conn.ws.send(JSON.stringify(msg));
    this.deps.metrics.wsMessagesOut.inc();
  }

  private broadcastDoc(docId: string, msg: ServerMessage, except?: Connection): void {
    for (const conn of this.docRooms.get(docId) ?? []) if (conn !== except) this.send(conn, msg);
  }

  private broadcastWorkspace(workspaceId: string, msg: ServerMessage): void {
    for (const conn of this.workspaceRooms.get(workspaceId) ?? []) this.send(conn, msg);
  }

  private broadcastOnline(workspaceId: string): void {
    const room = this.workspaceRooms.get(workspaceId);
    const userIds = [...new Set([...(room ?? [])].map((c) => c.auth?.user.id).filter((id): id is string => !!id))];
    this.broadcastWorkspace(workspaceId, { type: "workspace.online", workspaceId, userIds });
  }

  private violation(conn: Connection, code: "bad_request" | "validation_failed", message: string): void {
    this.send(conn, { type: "error", code, message });
    if (++conn.violations > MAX_VIOLATIONS) this.close(conn, CLOSE_CODES.invalidMessage, "too many invalid messages");
  }

  private close(conn: Connection, code: number, reason: string): void {
    if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CONNECTING) conn.ws.close(code, reason);
    this.cleanup(conn);
  }

  private cleanup(conn: Connection): void {
    if (!this.connections.delete(conn.id)) return;
    if (conn.authTimer) clearTimeout(conn.authTimer);
    for (const docId of [...conn.docs.keys()]) this.leaveDoc(conn, docId, true);
    for (const workspaceId of [...conn.workspaces]) this.unsubscribeWorkspace(conn, workspaceId);
    if (conn.auth) {
      const set = this.byUser.get(conn.auth.user.id);
      set?.delete(conn);
      if (set?.size === 0) this.byUser.delete(conn.auth.user.id);
    }
    this.limiter.reset(conn.id);
  }

  /** Heartbeat: ping sockets, drop dead ones, expire stale presence. */
  tick(): void {
    for (const conn of [...this.connections.values()]) {
      if (!conn.alive) {
        this.logger.debug("heartbeat timeout", { connectionId: conn.id });
        conn.ws.terminate();
        this.cleanup(conn);
        continue;
      }
      conn.alive = false;
      if (conn.ws.readyState === conn.ws.OPEN) conn.ws.ping();
    }
    const expired = this.presence.sweep(this.deps.clock.now(), this.deps.config.realtime.presenceTimeoutMs);
    for (const { documentId, connectionId } of expired) {
      this.broadcastDoc(documentId, { type: "presence.leave", docId: documentId, connectionId });
    }
  }

  stats(): { connections: number; users: number; documents: number } {
    return { connections: this.connections.size, users: this.byUser.size, documents: this.docRooms.size };
  }

  async shutdown(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const off of this.unsubscribers) off();
    for (const conn of [...this.connections.values()]) this.close(conn, CLOSE_CODES.shuttingDown, "server shutting down");
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
