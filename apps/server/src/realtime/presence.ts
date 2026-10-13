import { colorForUser, type CursorState, type PresencePeer } from "@rcp/shared";

export interface PeerIdentity {
  readonly connectionId: string;
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
}

/**
 * Tracks who is present in which document and where their cursor is.
 * Entries expire when a connection stops sending anything (heartbeats,
 * edits or cursor moves) for longer than the presence timeout.
 */
export class PresenceTracker {
  private readonly docs = new Map<string, Map<string, PresencePeer>>();
  private readonly byConnection = new Map<string, Set<string>>();

  join(documentId: string, identity: PeerIdentity, now: number): PresencePeer {
    const peer: PresencePeer = { ...identity, color: colorForUser(identity.userId), cursor: null, lastSeen: now };
    let peers = this.docs.get(documentId);
    if (!peers) {
      peers = new Map();
      this.docs.set(documentId, peers);
    }
    peers.set(identity.connectionId, peer);
    let docs = this.byConnection.get(identity.connectionId);
    if (!docs) {
      docs = new Set();
      this.byConnection.set(identity.connectionId, docs);
    }
    docs.add(documentId);
    return peer;
  }

  update(documentId: string, connectionId: string, cursor: CursorState | null, now: number): PresencePeer | null {
    const peers = this.docs.get(documentId);
    const current = peers?.get(connectionId);
    if (!peers || !current) return null;
    const next: PresencePeer = { ...current, cursor, lastSeen: now };
    peers.set(connectionId, next);
    return next;
  }

  /** Marks every document entry of a connection as recently seen. */
  touch(connectionId: string, now: number): void {
    for (const documentId of this.byConnection.get(connectionId) ?? []) {
      const peers = this.docs.get(documentId);
      const current = peers?.get(connectionId);
      if (peers && current) peers.set(connectionId, { ...current, lastSeen: now });
    }
  }

  leave(documentId: string, connectionId: string): boolean {
    const peers = this.docs.get(documentId);
    const removed = peers?.delete(connectionId) ?? false;
    if (peers && peers.size === 0) this.docs.delete(documentId);
    const docs = this.byConnection.get(connectionId);
    docs?.delete(documentId);
    if (docs && docs.size === 0) this.byConnection.delete(connectionId);
    return removed;
  }

  /** Removes a connection everywhere; returns the documents it was in. */
  leaveAll(connectionId: string): string[] {
    const docs = [...(this.byConnection.get(connectionId) ?? [])];
    for (const documentId of docs) this.leave(documentId, connectionId);
    return docs;
  }

  peers(documentId: string): PresencePeer[] {
    return [...(this.docs.get(documentId)?.values() ?? [])];
  }

  /** Drops entries not seen within `timeoutMs`; returns what was removed. */
  sweep(now: number, timeoutMs: number): Array<{ documentId: string; connectionId: string }> {
    const expired: Array<{ documentId: string; connectionId: string }> = [];
    for (const [documentId, peers] of this.docs) {
      for (const [connectionId, peer] of peers) {
        if (now - peer.lastSeen > timeoutMs) expired.push({ documentId, connectionId });
      }
    }
    for (const e of expired) this.leave(e.documentId, e.connectionId);
    return expired;
  }

  get documentCount(): number {
    return this.docs.size;
  }
}
