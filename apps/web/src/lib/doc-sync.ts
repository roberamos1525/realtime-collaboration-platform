import {
  RgaDocument,
  diffText,
  makeKey,
  transformIndex,
  type ClientMessage,
  type CursorState,
  type PresencePeer,
  type RgaOp,
  type Role,
  type ServerMessage,
  type TextChange,
} from "@rcp/shared";

export interface Selection {
  readonly start: number;
  readonly end: number;
}

export type SyncStatus = "joining" | "synced" | "resyncing" | "closed" | "error";

export interface DocSyncEvents {
  /** The text changed because of remote operations (or a fresh snapshot). */
  onRemoteText?(text: string, selection: Selection | null): void;
  onPeers?(peers: PresencePeer[]): void;
  onStatus?(status: SyncStatus, detail?: string): void;
  onRole?(role: Role): void;
  onTitle?(title: string): void;
}

export interface Transport {
  send(msg: ClientMessage): boolean;
  rejoin(docId: string): void;
}

const ACK_DELAY_MS = 250;
const MAX_CONSECUTIVE_RESYNCS = 3;

/**
 * Client side of document synchronisation.
 *
 * Keeps a local RGA replica, turns local text edits into operations, applies
 * sequenced remote operations (reporting how the local selection moves),
 * acknowledges sequence numbers, tracks peers' cursors as CRDT anchors and
 * recovers from reconnects/resyncs by rebasing unacknowledged local
 * operations onto the fresh server snapshot.
 */
export class DocumentSync {
  private replica: RgaDocument | null = null;
  private seq = 0;
  private ackedSeq = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Local ops not yet acknowledged by the server, in creation order. */
  private unacked: RgaOp[] = [];
  private readonly peers = new Map<string, PresencePeer>();
  private selection: Selection | null = null;
  private resyncs = 0;
  private statusValue: SyncStatus = "joining";
  role: Role = "viewer";

  constructor(
    readonly docId: string,
    private readonly transport: Transport,
    private readonly events: DocSyncEvents = {},
  ) {}

  get text(): string {
    return this.replica?.toString() ?? "";
  }

  get status(): SyncStatus {
    return this.statusValue;
  }

  get serverSeq(): number {
    return this.seq;
  }

  get pendingCount(): number {
    return this.unacked.length;
  }

  get canEdit(): boolean {
    return this.replica !== null && (this.role === "editor" || this.role === "admin" || this.role === "owner");
  }

  /** Remembers the local selection so remote edits can shift it. */
  setSelection(selection: Selection | null): void {
    this.selection = selection;
  }

  // -------------------------------------------------------------- incoming

  handle(msg: ServerMessage): void {
    if (!("docId" in msg) || msg.docId !== this.docId) return;
    switch (msg.type) {
      case "doc.joined":
        this.onJoined(msg);
        return;
      case "doc.op":
        this.onRemoteOp(msg.op, msg.seq);
        return;
      case "doc.ack":
        this.unacked = this.unacked.filter((op) => !(op.site === this.replica?.site && op.seq <= msg.opSeq));
        // Everything replayed after a resync is now confirmed.
        if (this.unacked.length === 0) this.resyncs = 0;
        this.seq = Math.max(this.seq, msg.seq);
        this.scheduleAck();
        return;
      case "doc.resync":
        this.resync(msg.reason);
        return;
      case "doc.closed":
        this.setStatus("closed", msg.reason);
        return;
      case "doc.meta":
        this.events.onTitle?.(msg.title);
        return;
      case "presence.update":
        this.peers.set(msg.peer.connectionId, msg.peer);
        this.emitPeers();
        return;
      case "presence.leave":
        if (this.peers.delete(msg.connectionId)) this.emitPeers();
        return;
      case "error":
        if (msg.code === "forbidden" || msg.code === "not_found") this.setStatus("error", msg.message);
        return;
    }
  }

  private onJoined(msg: Extract<ServerMessage, { type: "doc.joined" }>): void {
    const previous = this.replica;
    const pending = this.unacked;
    const fresh = RgaDocument.fromSnapshot(msg.snapshot, msg.site);
    this.replica = fresh;
    this.seq = msg.seq;
    this.ackedSeq = msg.seq;
    this.role = msg.role;
    this.unacked = [];
    this.peers.clear();
    for (const p of msg.peers) this.peers.set(p.connectionId, p);
    if (previous && pending.length > 0) this.rebase(previous.site, pending);
    else this.resyncs = 0;
    this.events.onRole?.(msg.role);
    this.setStatus("synced");
    this.emitPeers();
    this.events.onRemoteText?.(this.text, this.clampSelection(this.selection));
  }

  /**
   * Re-applies local operations the server never integrated on top of a
   * fresh snapshot. Element ids created by the old replica are mapped to the
   * ids the re-issued inserts receive, so later pending ops that reference
   * them still land in the right place.
   */
  private rebase(oldSite: string, pending: RgaOp[]): void {
    const replica = this.replica as RgaDocument;
    const integrated = replica.versionVector()[oldSite] ?? 0;
    const keyMap = new Map<string, string>();
    const mapKey = (key: string): string => keyMap.get(key) ?? key;
    let replayed = 0;
    for (const op of pending) {
      if (op.seq <= integrated) continue;
      if (op.kind === "insert") {
        const after = op.after === null ? null : mapKey(op.after);
        let index = after === null ? 0 : replica.resolveAnchor(after);
        // The reference vanished (collected on the server): keep the text.
        if (index === null) index = replica.length;
        const re = replica.insert(index, op.text);
        for (let i = 0; i < op.text.length; i++) keyMap.set(makeKey(op.site, op.clock + i), makeKey(re.site, re.clock + i));
        this.sendOp(re);
      } else {
        const targets: number[] = [];
        for (const span of op.spans) {
          for (let c = span.clock; c < span.clock + span.length; c++) {
            const key = mapKey(makeKey(span.site, c));
            const at = replica.resolveAnchor(key);
            // resolveAnchor returns the caret after a visible char.
            if (at !== null && replica.keyAt(at - 1) === key) targets.push(at - 1);
          }
        }
        // Delete from the end so earlier indices stay valid.
        for (const index of [...new Set(targets)].sort((a, b) => b - a)) this.sendOp(replica.delete(index, 1));
      }
      replayed++;
    }
    if (replayed > 0) this.resyncs++;
    else this.resyncs = 0;
  }

  private onRemoteOp(op: RgaOp, seq: number): void {
    if (!this.replica) return;
    if (seq <= this.seq) return;
    const result = this.replica.apply(op);
    this.seq = seq;
    if (result.status === "pending") {
      // Server ops arrive in causal order; a gap means we missed something.
      this.resync("missing dependencies");
      return;
    }
    this.scheduleAck();
    if (result.changes.length > 0) this.applyChanges(result.changes);
  }

  private applyChanges(changes: TextChange[]): void {
    if (this.selection) {
      this.selection = {
        start: transformIndex(this.selection.start, changes),
        end: transformIndex(this.selection.end, changes),
      };
    }
    this.events.onRemoteText?.(this.text, this.selection);
  }

  private resync(reason: string): void {
    if (this.resyncs >= MAX_CONSECUTIVE_RESYNCS) {
      this.unacked = [];
      this.setStatus("error", `could not synchronise local changes (${reason}); reloaded the latest version`);
      this.resyncs = 0;
      this.replica = null;
      this.transport.rejoin(this.docId);
      return;
    }
    this.setStatus("resyncing", reason);
    this.transport.rejoin(this.docId);
  }

  // -------------------------------------------------------------- outgoing

  /**
   * Applies a local edit given the textarea's new value and caret. Returns
   * false if the edit was refused (read-only or not yet synced).
   */
  applyLocalText(next: string, caretAfter: number): boolean {
    if (!this.replica || !this.canEdit) return false;
    const splice = diffText(this.replica.toString(), next, caretAfter);
    if (!splice) return true;
    for (const op of this.replica.splice(splice.index, splice.deleteCount, splice.insertText)) this.sendOp(op);
    return true;
  }

  private sendOp(op: RgaOp): void {
    this.unacked.push(op);
    // When offline the op stays queued and is rebased after reconnecting.
    this.transport.send({ type: "doc.op", docId: this.docId, op });
  }

  /** Converts a selection to CRDT anchors and broadcasts it. */
  sendCursor(selection: Selection | null): void {
    if (!this.replica) return;
    const cursor: CursorState | null = selection
      ? { anchor: this.replica.anchorAt(selection.start), head: this.replica.anchorAt(selection.end) }
      : null;
    this.transport.send({ type: "presence.update", docId: this.docId, cursor });
  }

  /** Resolves a peer's anchored cursor into current text offsets. */
  resolveCursor(cursor: CursorState | null): Selection | null {
    if (!cursor || !this.replica) return null;
    const a = this.replica.resolveAnchor(cursor.anchor);
    const h = this.replica.resolveAnchor(cursor.head);
    if (a === null || h === null) return null;
    return { start: Math.min(a, h), end: Math.max(a, h) };
  }

  /** Caret offset of a single anchor (null = document start). */
  resolvePosition(anchor: string | null): number | null {
    return this.replica ? this.replica.resolveAnchor(anchor) : null;
  }

  /** Text offsets covered by an element-key range (comment anchors). */
  resolveRange(startKey: string, endKey: string): Selection | null {
    if (!this.replica) return null;
    const after = this.replica.resolveAnchor(endKey);
    const startAfter = this.replica.resolveAnchor(startKey);
    if (after === null || startAfter === null) return null;
    const startVisible = this.replica.keyAt(startAfter - 1) === startKey;
    const start = startVisible ? startAfter - 1 : startAfter;
    return after >= start ? { start, end: after } : null;
  }

  /** Element keys bounding a selection, for creating anchored comments. */
  anchorRange(selection: Selection): { start: string; end: string } | null {
    if (!this.replica || selection.end <= selection.start) return null;
    const start = this.replica.keyAt(selection.start);
    const end = this.replica.keyAt(selection.end - 1);
    return start && end ? { start, end } : null;
  }

  peerList(): PresencePeer[] {
    return [...this.peers.values()];
  }

  dispose(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private scheduleAck(): void {
    if (this.ackTimer) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.seq > this.ackedSeq && this.transport.send({ type: "doc.ack", docId: this.docId, seq: this.seq })) {
        this.ackedSeq = this.seq;
      }
    }, ACK_DELAY_MS);
  }

  private clampSelection(selection: Selection | null): Selection | null {
    if (!selection) return null;
    const len = this.text.length;
    return { start: Math.min(selection.start, len), end: Math.min(selection.end, len) };
  }

  private emitPeers(): void {
    this.events.onPeers?.(this.peerList());
  }

  private setStatus(status: SyncStatus, detail?: string): void {
    this.statusValue = status;
    this.events.onStatus?.(status, detail);
  }
}
