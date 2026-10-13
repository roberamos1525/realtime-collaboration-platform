import { compareIds, isValidSite, makeKey, randomSiteId, type CharId } from "./id.js";
import { opMaxClock, type DeleteOp, type IdSpan, type InsertOp, type RgaOp } from "./ops.js";
import { SnapshotError, parseSnapshot, type RgaSnapshot } from "./snapshot.js";

/**
 * Replicated Growable Array (RGA) sequence CRDT for plain text.
 *
 * Elements live in a doubly linked list in document order; deleted elements
 * stay in the list as tombstones so concurrent operations that reference them
 * can still be positioned. Concurrent inserts after the same element are
 * ordered by descending id, which every replica computes identically.
 *
 * Delivery model: operations from one site carry contiguous sequence numbers.
 * Out-of-order or not-yet-satisfiable operations are buffered and retried, and
 * duplicates are discarded via the version vector, so any delivery order with
 * eventual delivery converges.
 */

interface RgaNode {
  readonly id: CharId;
  readonly key: string;
  readonly char: string;
  deleted: boolean;
  prev: RgaNode | null;
  next: RgaNode | null;
}

/** A change to the visible text, expressed against the text before it. */
export type TextChange =
  | { readonly kind: "insert"; readonly index: number; readonly text: string }
  | { readonly kind: "delete"; readonly index: number; readonly length: number };

export type ApplyResult =
  | { readonly status: "applied"; readonly changes: TextChange[] }
  | { readonly status: "duplicate"; readonly changes: TextChange[] }
  | { readonly status: "pending"; readonly changes: TextChange[] };

export interface RgaStats {
  readonly visible: number;
  readonly tombstones: number;
  readonly pending: number;
  readonly clock: number;
  readonly sites: number;
}

export interface RgaOptions {
  /** Maximum number of buffered operations before {@link RgaError} is thrown. */
  readonly maxPending?: number;
}

export class RgaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RgaError";
  }
}

const DEFAULT_MAX_PENDING = 10_000;

export class RgaDocument {
  readonly site: string;
  private clock = 0;
  private seq: number;
  private readonly head: RgaNode;
  private readonly nodes = new Map<string, RgaNode>();
  private readonly vv = new Map<string, number>();
  private pending: RgaOp[] = [];
  private visibleCount = 0;
  private tombstoneCount = 0;
  private cachedText: string | null = "";
  private readonly maxPending: number;

  constructor(site: string = randomSiteId(), options: RgaOptions = {}) {
    if (!isValidSite(site)) throw new RgaError(`invalid site id: ${JSON.stringify(site)}`);
    this.site = site;
    this.seq = 0;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.head = { id: { site: "", clock: 0 }, key: "", char: "", deleted: true, prev: null, next: null };
  }

  /** Builds a replica from a snapshot. The new replica gets its own site id. */
  static fromSnapshot(input: RgaSnapshot | unknown, site: string = randomSiteId(), options: RgaOptions = {}): RgaDocument {
    const snapshot = parseSnapshot(input);
    const doc = new RgaDocument(site, options);
    let tail = doc.head;
    let maxClock = 0;
    for (const [runSite, runClock, text, deleted] of snapshot.runs) {
      for (let i = 0; i < text.length; i++) {
        const id: CharId = { site: runSite, clock: runClock + i };
        const key = makeKey(runSite, id.clock);
        if (doc.nodes.has(key)) throw new SnapshotError(`duplicate element ${key}`);
        const node: RgaNode = { id, key, char: text[i] as string, deleted: deleted === 1, prev: tail, next: null };
        tail.next = node;
        tail = node;
        doc.nodes.set(key, node);
        if (node.deleted) doc.tombstoneCount++;
        else doc.visibleCount++;
        if (id.clock > maxClock) maxClock = id.clock;
      }
    }
    if (maxClock > snapshot.clock) throw new SnapshotError("element clock exceeds snapshot clock");
    doc.clock = snapshot.clock;
    for (const [s, n] of Object.entries(snapshot.vv)) doc.vv.set(s, n);
    doc.seq = doc.vv.get(site) ?? 0;
    doc.cachedText = null;
    return doc;
  }

  /** Builds a replica containing `text` as if a single site had typed it. */
  static fromText(text: string, site: string = randomSiteId()): RgaDocument {
    const doc = new RgaDocument(site);
    if (text.length > 0) doc.insert(0, text);
    return doc;
  }

  get length(): number {
    return this.visibleCount;
  }

  get lamport(): number {
    return this.clock;
  }

  toString(): string {
    if (this.cachedText === null) {
      const parts: string[] = [];
      for (let n = this.head.next; n; n = n.next) if (!n.deleted) parts.push(n.char);
      this.cachedText = parts.join("");
    }
    return this.cachedText;
  }

  stats(): RgaStats {
    return {
      visible: this.visibleCount,
      tombstones: this.tombstoneCount,
      pending: this.pending.length,
      clock: this.clock,
      sites: this.vv.size,
    };
  }

  versionVector(): Record<string, number> {
    return Object.fromEntries(this.vv);
  }

  /** True when the operation `(site, seq)` has already been integrated. */
  hasSeen(site: string, seq: number): boolean {
    return (this.vv.get(site) ?? 0) >= seq;
  }

  // ---------------------------------------------------------------- local ops

  /** Inserts `text` at visible `index` and returns the operation to broadcast. */
  insert(index: number, text: string): InsertOp {
    if (!Number.isInteger(index) || index < 0 || index > this.visibleCount) {
      throw new RgaError(`insert index ${index} out of range 0..${this.visibleCount}`);
    }
    if (text.length === 0) throw new RgaError("cannot insert empty text");
    const ref = index === 0 ? this.head : this.visibleNodeAt(index - 1);
    const op: InsertOp = {
      kind: "insert",
      site: this.site,
      seq: this.seq + 1,
      clock: this.clock + 1,
      after: ref === this.head ? null : ref.key,
      text,
    };
    this.integrate(op);
    return op;
  }

  /** Deletes `length` visible characters starting at `index`. */
  delete(index: number, length: number): DeleteOp {
    if (!Number.isInteger(index) || !Number.isInteger(length) || length <= 0) {
      throw new RgaError("delete requires a positive integer length");
    }
    if (index < 0 || index + length > this.visibleCount) {
      throw new RgaError(`delete range ${index}+${length} out of range 0..${this.visibleCount}`);
    }
    const spans: IdSpan[] = [];
    let node: RgaNode | null = this.visibleNodeAt(index);
    let remaining = length;
    while (node && remaining > 0) {
      if (!node.deleted) {
        const last = spans[spans.length - 1];
        if (last && last.site === node.id.site && last.clock + last.length === node.id.clock) {
          spans[spans.length - 1] = { ...last, length: last.length + 1 };
        } else {
          spans.push({ site: node.id.site, clock: node.id.clock, length: 1 });
        }
        remaining--;
      }
      node = node.next;
    }
    const op: DeleteOp = { kind: "delete", site: this.site, seq: this.seq + 1, clock: this.clock + 1, spans };
    this.integrate(op);
    return op;
  }

  /**
   * Applies a splice (`deleteCount` chars at `index`, then `insertText`) and
   * returns the generated operations in order.
   */
  splice(index: number, deleteCount: number, insertText: string): RgaOp[] {
    const ops: RgaOp[] = [];
    if (deleteCount > 0) ops.push(this.delete(index, deleteCount));
    if (insertText.length > 0) ops.push(this.insert(index, insertText));
    return ops;
  }

  // --------------------------------------------------------------- remote ops

  /** True when `op` could be integrated right now (in order, deps present). */
  canApply(op: RgaOp): boolean {
    const known = this.vv.get(op.site) ?? 0;
    return op.seq === known + 1 && this.dependenciesPresent(op);
  }

  /**
   * Integrates a remote operation. Operations that arrive early are buffered;
   * integrating one may release buffered operations, whose changes are
   * included in the result in application order.
   */
  apply(op: RgaOp): ApplyResult {
    const known = this.vv.get(op.site) ?? 0;
    if (op.seq <= known) return { status: "duplicate", changes: [] };
    if (op.seq > known + 1 || !this.dependenciesPresent(op)) {
      if (!this.pending.some((p) => p.site === op.site && p.seq === op.seq)) {
        if (this.pending.length >= this.maxPending) {
          throw new RgaError(`pending operation buffer exceeded ${this.maxPending}`);
        }
        this.pending.push(op);
      }
      return { status: "pending", changes: [] };
    }
    const changes = this.integrate(op);
    this.drainPending(changes);
    return { status: "applied", changes };
  }

  /** Drops buffered operations that can never be applied (e.g. after resync). */
  clearPending(): number {
    const n = this.pending.length;
    this.pending = [];
    return n;
  }

  // --------------------------------------------------------------- positions

  /** Key of the visible character at `index`, or null when out of range. */
  keyAt(index: number): string | null {
    if (index < 0 || index >= this.visibleCount) return null;
    return this.visibleNodeAt(index).key;
  }

  /**
   * Converts a caret position into a stable anchor: the key of the character
   * immediately before the caret, or null for the document start.
   */
  anchorAt(index: number): string | null {
    if (index <= 0) return null;
    return this.keyAt(Math.min(index, this.visibleCount) - 1);
  }

  /**
   * Resolves an anchor produced by {@link anchorAt} back into a caret
   * position. If the anchored character was deleted the caret lands where the
   * character used to be. Unknown anchors (e.g. garbage collected) resolve to
   * null.
   */
  resolveAnchor(anchor: string | null): number | null {
    if (anchor === null) return 0;
    const node = this.nodes.get(anchor);
    if (!node) return null;
    let index = 0;
    for (let n = this.head.next; n && n !== node; n = n.next) if (!n.deleted) index++;
    return node.deleted ? index : index + 1;
  }

  /** Whether an element with this key exists (visible or tombstone). */
  hasElement(key: string): boolean {
    return this.nodes.has(key);
  }

  // ---------------------------------------------------------- serialization

  snapshot(): RgaSnapshot {
    const runs: Array<[string, number, string, 0 | 1]> = [];
    let current: [string, number, string, 0 | 1] | null = null;
    for (let n = this.head.next; n; n = n.next) {
      const deleted: 0 | 1 = n.deleted ? 1 : 0;
      if (
        current &&
        current[0] === n.id.site &&
        current[1] + current[2].length === n.id.clock &&
        current[3] === deleted
      ) {
        current[2] += n.char;
      } else {
        current = [n.id.site, n.id.clock, n.char, deleted];
        runs.push(current);
      }
    }
    return { version: 1, clock: this.clock, vv: this.versionVector(), runs };
  }

  /**
   * Removes tombstones. Safe only at a quiescent point: every replica that may
   * still send operations has integrated every operation this replica has
   * integrated. At such a point all future operations carry clocks greater
   * than any existing element and never reference a tombstone, so dropping
   * tombstones cannot change where future elements are placed.
   *
   * @param retain keys of tombstones to keep (e.g. comment anchors)
   * @returns number of tombstones removed
   */
  collectGarbage(retain?: ReadonlySet<string>): number {
    let removed = 0;
    let node = this.head.next;
    while (node) {
      const next: RgaNode | null = node.next;
      if (node.deleted && !retain?.has(node.key)) {
        const prev = node.prev as RgaNode;
        prev.next = next;
        if (next) next.prev = prev;
        this.nodes.delete(node.key);
        removed++;
      }
      node = next;
    }
    this.tombstoneCount -= removed;
    return removed;
  }

  // ---------------------------------------------------------------- internals

  private visibleNodeAt(index: number): RgaNode {
    let i = 0;
    for (let n = this.head.next; n; n = n.next) {
      if (n.deleted) continue;
      if (i === index) return n;
      i++;
    }
    throw new RgaError(`visible index ${index} out of range`);
  }

  private dependenciesPresent(op: RgaOp): boolean {
    if (op.kind === "insert") return op.after === null || this.nodes.has(op.after);
    for (const span of op.spans) {
      for (let c = span.clock; c < span.clock + span.length; c++) {
        if (!this.nodes.has(makeKey(span.site, c))) return false;
      }
    }
    return true;
  }

  private integrate(op: RgaOp): TextChange[] {
    const changes = op.kind === "insert" ? this.integrateInsert(op) : this.integrateDelete(op);
    this.vv.set(op.site, op.seq);
    if (op.site === this.site) this.seq = op.seq;
    const maxClock = opMaxClock(op);
    if (maxClock > this.clock) this.clock = maxClock;
    if (changes.length > 0) this.cachedText = null;
    return changes;
  }

  private integrateInsert(op: InsertOp): TextChange[] {
    const ref = op.after === null ? this.head : this.nodes.get(op.after);
    if (!ref) throw new RgaError(`missing reference ${op.after}`);
    if (this.nodes.has(makeKey(op.site, op.clock))) {
      throw new RgaError(`element ${makeKey(op.site, op.clock)} already exists`);
    }
    // Skip over elements inserted concurrently after `ref` that win the tie
    // (larger id), together with their descendants (which have even larger
    // clocks). The first element with a smaller id marks the insert point.
    const firstId: CharId = { site: op.site, clock: op.clock };
    let left = ref;
    let right = ref.next;
    while (right && compareIds(right.id, firstId) > 0) {
      left = right;
      right = right.next;
    }
    let index = 0;
    for (let n = this.head.next; n && n !== right; n = n.next) if (!n.deleted) index++;

    for (let i = 0; i < op.text.length; i++) {
      const id: CharId = { site: op.site, clock: op.clock + i };
      const node: RgaNode = { id, key: makeKey(id.site, id.clock), char: op.text[i] as string, deleted: false, prev: left, next: right };
      left.next = node;
      if (right) right.prev = node;
      this.nodes.set(node.key, node);
      left = node;
    }
    this.visibleCount += op.text.length;
    return [{ kind: "insert", index, text: op.text }];
  }

  private integrateDelete(op: DeleteOp): TextChange[] {
    const targets = new Set<RgaNode>();
    for (const span of op.spans) {
      for (let c = span.clock; c < span.clock + span.length; c++) {
        const node = this.nodes.get(makeKey(span.site, c));
        if (!node) throw new RgaError(`missing delete target ${makeKey(span.site, c)}`);
        if (!node.deleted) targets.add(node);
      }
    }
    if (targets.size === 0) return [];
    const changes: TextChange[] = [];
    let index = 0;
    let runStart = 0;
    let runLength = 0;
    let remaining = targets.size;
    for (let n = this.head.next; n && remaining > 0; n = n.next) {
      if (n.deleted) continue;
      if (targets.has(n)) {
        if (runLength === 0) runStart = index;
        runLength++;
        n.deleted = true;
        remaining--;
        continue;
      }
      if (runLength > 0) {
        changes.push({ kind: "delete", index: runStart, length: runLength });
        runLength = 0;
      }
      index++;
    }
    if (runLength > 0) changes.push({ kind: "delete", index: runStart, length: runLength });
    this.visibleCount -= targets.size;
    this.tombstoneCount += targets.size;
    return changes;
  }

  private drainPending(changes: TextChange[]): void {
    let progressed = true;
    while (progressed && this.pending.length > 0) {
      progressed = false;
      const still: RgaOp[] = [];
      for (const op of this.pending) {
        const known = this.vv.get(op.site) ?? 0;
        if (op.seq <= known) {
          progressed = true;
          continue;
        }
        if (op.seq === known + 1 && this.dependenciesPresent(op)) {
          changes.push(...this.integrate(op));
          progressed = true;
        } else {
          still.push(op);
        }
      }
      this.pending = still;
    }
  }
}

/** Applies a list of text changes to a plain string (used by UIs and tests). */
export function applyTextChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (const c of changes) {
    out = c.kind === "insert" ? out.slice(0, c.index) + c.text + out.slice(c.index) : out.slice(0, c.index) + out.slice(c.index + c.length);
  }
  return out;
}

/** Shifts a caret position through a list of text changes. */
export function transformIndex(position: number, changes: readonly TextChange[], stickToEnd = false): number {
  let pos = position;
  for (const c of changes) {
    if (c.kind === "insert") {
      if (c.index < pos || (c.index === pos && stickToEnd)) pos += c.text.length;
    } else if (c.index < pos) {
      pos -= Math.min(c.length, pos - c.index);
    }
  }
  return pos;
}
