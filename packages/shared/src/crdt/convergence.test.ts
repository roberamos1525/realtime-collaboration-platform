import { describe, expect, it } from "vitest";
import type { RgaOp } from "./ops.js";
import { RgaDocument, applyTextChanges } from "./rga.js";

/** Small deterministic PRNG so failures are reproducible from the seed. */
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

interface Replica {
  doc: RgaDocument;
  /** Text maintained purely from emitted TextChanges (what a UI would show). */
  mirror: string;
  inbox: RgaOp[];
}

const ALPHABET = "abcdefghij \n";

function randomEdit(rand: () => number, r: Replica): RgaOp[] {
  const len = r.doc.length;
  if (len === 0 || rand() < 0.65) {
    const at = Math.floor(rand() * (len + 1));
    let text = "";
    const n = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    const op = r.doc.insert(at, text);
    r.mirror = r.mirror.slice(0, at) + text + r.mirror.slice(at);
    return [op];
  }
  const at = Math.floor(rand() * len);
  const count = 1 + Math.floor(rand() * Math.min(5, len - at));
  const op = r.doc.delete(at, count);
  r.mirror = r.mirror.slice(0, at) + r.mirror.slice(at + count);
  return [op];
}

function shuffle<T>(rand: () => number, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
}

function deliverSome(rand: () => number, replicas: Replica[], fraction: number): void {
  for (const r of replicas) {
    if (r.inbox.length === 0) continue;
    shuffle(rand, r.inbox);
    const take = Math.ceil(r.inbox.length * fraction);
    const batch = r.inbox.splice(0, take);
    for (const op of batch) {
      const result = r.doc.apply(op);
      r.mirror = applyTextChanges(r.mirror, result.changes);
      // Occasionally the network duplicates a message.
      if (rand() < 0.05) r.inbox.push(op);
    }
  }
}

function deliverAll(rand: () => number, replicas: Replica[]): void {
  let guard = 0;
  while (replicas.some((r) => r.inbox.length > 0)) {
    deliverSome(rand, replicas, 1);
    if (++guard > 1000) throw new Error("delivery did not terminate");
  }
}

function broadcast(replicas: Replica[], from: Replica, ops: RgaOp[]): void {
  for (const r of replicas) if (r !== from) r.inbox.push(...ops);
}

function assertConverged(replicas: Replica[], seed: number): void {
  const first = replicas[0] as Replica;
  const expected = first.doc.toString();
  for (const r of replicas) {
    expect(r.doc.stats().pending, `seed ${seed}: pending ops remain`).toBe(0);
    expect(r.doc.toString(), `seed ${seed}: replica text diverged`).toBe(expected);
    expect(r.mirror, `seed ${seed}: change stream diverged from replica`).toBe(expected);
  }
}

function makeReplicas(count: number): Replica[] {
  return Array.from({ length: count }, (_, i) => ({ doc: new RgaDocument(`site${i}`), mirror: "", inbox: [] }));
}

describe("RGA convergence (property-based)", () => {
  const seeds = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);

  it.each(seeds)("random concurrent edits with reordering and duplication converge (seed %i)", (seed) => {
    const rand = mulberry32(seed);
    const replicas = makeReplicas(2 + Math.floor(rand() * 4));
    for (let round = 0; round < 60; round++) {
      for (const r of replicas) {
        if (rand() < 0.7) broadcast(replicas, r, randomEdit(rand, r));
      }
      deliverSome(rand, replicas, rand());
    }
    deliverAll(rand, replicas);
    assertConverged(replicas, seed);
  });

  it.each(seeds.slice(0, 15))("converges when replicas garbage-collect at quiescent points (seed %i)", (seed) => {
    const rand = mulberry32(seed);
    const replicas = makeReplicas(3);
    for (let phase = 0; phase < 4; phase++) {
      for (let round = 0; round < 25; round++) {
        for (const r of replicas) if (rand() < 0.8) broadcast(replicas, r, randomEdit(rand, r));
        deliverSome(rand, replicas, rand());
      }
      deliverAll(rand, replicas);
      assertConverged(replicas, seed);
      // Quiescent: only some replicas collect, which must not break future merges.
      for (const r of replicas) if (rand() < 0.5) r.doc.collectGarbage();
    }
    assertConverged(replicas, seed);
  });

  it.each(seeds.slice(0, 10))("late joiners bootstrapped from snapshots converge (seed %i)", (seed) => {
    const rand = mulberry32(seed);
    const replicas = makeReplicas(2);
    for (let round = 0; round < 30; round++) {
      for (const r of replicas) if (rand() < 0.8) broadcast(replicas, r, randomEdit(rand, r));
      deliverSome(rand, replicas, 0.5);
    }
    deliverAll(rand, replicas);
    const source = replicas[0] as Replica;
    const joiner: Replica = {
      doc: RgaDocument.fromSnapshot(JSON.parse(JSON.stringify(source.doc.snapshot())), `join${seed % 1000}`),
      mirror: source.doc.toString(),
      inbox: [],
    };
    replicas.push(joiner);
    for (let round = 0; round < 30; round++) {
      for (const r of replicas) if (rand() < 0.8) broadcast(replicas, r, randomEdit(rand, r));
      deliverSome(rand, replicas, rand());
    }
    deliverAll(rand, replicas);
    assertConverged(replicas, seed);
  });

  it("is commutative for every permutation of three concurrent ops", () => {
    const base = RgaDocument.fromText("0123", "base");
    const ops: RgaOp[] = [];
    const a = RgaDocument.fromSnapshot(base.snapshot(), "aa");
    const b = RgaDocument.fromSnapshot(base.snapshot(), "bb");
    const c = RgaDocument.fromSnapshot(base.snapshot(), "cc");
    ops.push(a.insert(2, "A"), b.delete(1, 2), c.insert(2, "C"));
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const results = perms.map((perm) => {
      const r = RgaDocument.fromSnapshot(base.snapshot(), "zz");
      for (const i of perm) r.apply(ops[i] as RgaOp);
      return r.toString();
    });
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("0CA3");
  });
});
