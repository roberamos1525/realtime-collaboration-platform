import { CLOSE_CODES, type ClientMessage, type ServerMessage } from "@rcp/shared";

/** The subset of the browser WebSocket API the client relies on. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface RealtimeClientOptions {
  readonly url: string;
  readonly getToken: () => Promise<string | null>;
  readonly createSocket?: (url: string) => SocketLike;
  /** Called when the server says the session is gone (e.g. logout elsewhere). */
  readonly onAuthLost?: () => void;
  readonly heartbeatMs?: number;
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
}

const OPEN = 1;

/**
 * Resilient WebSocket client: authenticates with the access token as the
 * first frame, sends heartbeats, reconnects with exponential backoff and
 * jitter, and replays document/workspace subscriptions after reconnecting so
 * callers can treat the connection as always-on.
 */
export class RealtimeClient {
  private socket: SocketLike | null = null;
  private statusValue: ConnectionStatus = "idle";
  private ready = false;
  private attempts = 0;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly docs = new Map<string, number>();
  private readonly workspaces = new Map<string, number>();
  private readonly createSocket: (url: string) => SocketLike;

  constructor(private readonly options: RealtimeClientOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  get isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.open();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "client disconnect");
    }
    this.setStatus("closed");
  }

  /** Sends a message if authenticated; returns false when it was not sent. */
  send(msg: ClientMessage): boolean {
    if (!this.ready || !this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  on(listener: (msg: ServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Keeps a document joined (ref-counted) across reconnects. */
  retainDoc(docId: string): () => void {
    const count = this.docs.get(docId) ?? 0;
    this.docs.set(docId, count + 1);
    if (count === 0) this.send({ type: "doc.join", docId });
    return () => {
      const n = (this.docs.get(docId) ?? 1) - 1;
      if (n <= 0) {
        this.docs.delete(docId);
        this.send({ type: "doc.leave", docId });
      } else {
        this.docs.set(docId, n);
      }
    };
  }

  /** Keeps a workspace subscription (ref-counted) across reconnects. */
  retainWorkspace(workspaceId: string): () => void {
    const count = this.workspaces.get(workspaceId) ?? 0;
    this.workspaces.set(workspaceId, count + 1);
    if (count === 0) this.send({ type: "workspace.subscribe", workspaceId });
    return () => {
      const n = (this.workspaces.get(workspaceId) ?? 1) - 1;
      if (n <= 0) {
        this.workspaces.delete(workspaceId);
        this.send({ type: "workspace.unsubscribe", workspaceId });
      } else {
        this.workspaces.set(workspaceId, n);
      }
    };
  }

  /** Requests a fresh snapshot for a joined document (used for resync). */
  rejoin(docId: string): void {
    if (this.docs.has(docId)) this.send({ type: "doc.join", docId });
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const token = await this.options.getToken();
    if (this.stopped) return;
    if (!token) {
      this.options.onAuthLost?.();
      this.disconnect();
      return;
    }
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token } satisfies ClientMessage));
    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onerror = () => {
      // The close handler performs recovery.
    };
    socket.onclose = (ev) => this.handleClose(ev.code);
  }

  private handleMessage(data: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.ready = true;
      this.attempts = 0;
      this.setStatus("open");
      this.startHeartbeat(msg.heartbeatMs);
      for (const docId of this.docs.keys()) this.send({ type: "doc.join", docId });
      for (const workspaceId of this.workspaces.keys()) this.send({ type: "workspace.subscribe", workspaceId });
    }
    for (const listener of [...this.listeners]) listener(msg);
  }

  private handleClose(code: number): void {
    this.ready = false;
    this.socket = null;
    this.clearTimers();
    if (this.stopped) return;
    if (code === CLOSE_CODES.sessionRevoked) {
      this.options.onAuthLost?.();
      this.disconnect();
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const max = this.options.maxBackoffMs ?? 30_000;
    const base = Math.min(max, 500 * 2 ** this.attempts);
    const jitter = (this.options.random ?? Math.random)() * base * 0.3;
    this.attempts++;
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, base + jitter);
  }

  private startHeartbeat(serverInterval: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval = Math.max(1000, Math.min(this.options.heartbeatMs ?? serverInterval, serverInterval));
    this.heartbeatTimer = setInterval(() => this.send({ type: "ping", t: Date.now() }), interval);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.statusValue) return;
    this.statusValue = status;
    for (const l of [...this.statusListeners]) l(status);
  }
}

/** ws:// or wss:// URL of the realtime endpoint for the current page. */
export function defaultSocketUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}
