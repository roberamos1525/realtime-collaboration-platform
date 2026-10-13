import { describe, expect, it } from "vitest";
import { compareIds, idKey, makeKey, parseKey, randomSiteId } from "./id.js";
import { opSize, rgaOpSchema, type RgaOp } from "./ops.js";
import { RgaDocument, RgaError, applyTextChanges, transformIndex } from "./rga.js";
import { SnapshotError, emptySnapshot } from "./snapshot.js";

describe("ids", () => {
  it("orders by clock then site", () => {
    expect(compareIds({ site: "a", clock: 1 }, { site: "a", clock: 2 })).toBe(-1);
    expect(compareIds({ site: "b", clock: 2 }, { site: "a", clock: 2 })).toBe(1);
    expect(compareIds({ site: "a", clock: 2 }, { site: "a", clock: 2 })).toBe(0);
  });

  it("round-trips keys and rejects malformed ones", () => {
    const key = idKey({ site: "site_1", clock: 42 });
    expect(key).toBe("42@site_1");
    expect(parseKey(key)).toEqual({ site: "site_1", clock: 42 });
    expect(parseKey("abc")).toBeNull();
    expect(parseKey("0@a")).toBeNull();
    expect(parseKey("1@")).toBeNull();
    expect(parseKey("x@a")).toBeNull();
    expect(parseKey("1@bad site")).toBeNull();
  });

  it("generates valid random site ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomSiteId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{12}$/);
  });
});

describe("RgaDocument local editing", () => {
  it("inserts and deletes text", () => {
    const doc = new RgaDocument("a");
    doc.insert(0, "hello");
    doc.insert(5, " world");
    doc.insert(0, ">");
    expect(doc.toString()).toBe(">hello world");
    doc.delete(0, 1);
    doc.delete(5, 6);
    expect(doc.toString()).toBe("hello");
    expect(doc.length).toBe(5);
    expect(doc.stats()).toMatchObject({ visible: 5, tombstones: 7, pending: 0 });
  });

  it("produces compact delete spans", () => {
    const doc = new RgaDocument("a");
    doc.insert(0, "abcdef");
    const op = doc.delete(1, 4);
    expect(op.kind).toBe("delete");
    if (op.kind === "delete") expect(op.spans).toEqual([{ site: "a", clock: 2, length: 4 }]);
    expect(opSize(op)).toBe(4);
  });

  it("validates ranges", () => {
    const doc = RgaDocument.fromText("abc", "a");
    expect(() => doc.insert(4, "x")).toThrow(RgaError);
    expect(() => doc.insert(-1, "x")).toThrow(RgaError);
    expect(() => doc.insert(0, "")).toThrow(RgaError);
    expect(() => doc.delete(2, 2)).toThrow(RgaError);
    expect(() => doc.delete(0, 0)).toThrow(RgaError);
    expect(() => new RgaDocument("bad site")).toThrow(RgaError);
  });

  it("splice returns delete then insert", () => {
    const doc = RgaDocument.fromText("hello world", "a");
    const ops = doc.splice(6, 5, "there");
    expect(ops.map((o) => o.kind)).toEqual(["delete", "insert"]);
    expect(doc.toString()).toBe("hello there");
    expect(doc.splice(0, 0, "")).toEqual([]);
  });

  it("emits ops that pass the wire schema", () => {
    const doc = new RgaDocument("site-1");
    const ops: RgaOp[] = [doc.insert(0, "abc"), doc.delete(1, 1)];
    for (const op of ops) expect(rgaOpSchema.safeParse(op).success).toBe(true);
  });

  it("matches a plain string model under random single-replica edits", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const doc = new RgaDocument("solo");
    let model = "";
    for (let i = 0; i < 500; i++) {
      if (model.length === 0 || rand() < 0.6) {
        const at = Math.floor(rand() * (model.length + 1));
        const text = "xyz".slice(0, 1 + Math.floor(rand() * 3));
        doc.insert(at, text);
        model = model.slice(0, at) + text + model.slice(at);
      } else {
        const at = Math.floor(rand() * model.length);
        const len = 1 + Math.floor(rand() * Math.min(4, model.length - at));
        doc.delete(at, len);
        model = model.slice(0, at) + model.slice(at + len);
      }
      expect(doc.toString()).toBe(model);
    }
  });
});

describe("RgaDocument remote integration", () => {
  it("orders concurrent inserts at the same position deterministically", () => {
    const base = RgaDocument.fromText("ac", "base");
    const a = RgaDocument.fromSnapshot(base.snapshot(), "aaa");
    const b = RgaDocument.fromSnapshot(base.snapshot(), "bbb");
    const opA = a.insert(1, "X");
    const opB = b.insert(1, "Y");
    a.apply(opB);
    b.apply(opA);
    expect(a.toString()).toBe(b.toString());
    // Equal clocks: the larger site id wins and is placed first.
    expect(a.toString()).toBe("aYXc");
  });

  it("keeps runs of concurrent typing contiguous (no interleaving)", () => {
    const base = RgaDocument.fromText("[]", "base");
    const a = RgaDocument.fromSnapshot(base.snapshot(), "aaa");
    const b = RgaDocument.fromSnapshot(base.snapshot(), "bbb");
    const opsA = [a.insert(1, "h"), a.insert(2, "i")];
    const opsB = [b.insert(1, "y"), b.insert(2, "o")];
    for (const op of opsB) a.apply(op);
    for (const op of opsA) b.apply(op);
    expect(a.toString()).toBe(b.toString());
    expect(["[hiyo]", "[yohi]"]).toContain(a.toString());
  });

  it("returns visible text changes for remote ops", () => {
    const a = new RgaDocument("aaa");
    const b = new RgaDocument("bbb");
    const ins = a.insert(0, "hello");
    const r1 = b.apply(ins);
    expect(r1).toEqual({ status: "applied", changes: [{ kind: "insert", index: 0, text: "hello" }] });
    const del = a.delete(1, 3);
    const r2 = b.apply(del);
    expect(r2.changes).toEqual([{ kind: "delete", index: 1, length: 3 }]);
    expect(applyTextChanges("hello", [...r1.changes, ...r2.changes].slice(1))).toBe("ho");
  });

  it("splits a delete of non-contiguous visible chars into several changes", () => {
    const a = RgaDocument.fromText("abcdef", "aaa");
    const b = RgaDocument.fromSnapshot(a.snapshot(), "bbb");
    // b inserts in the middle; a deletes around it without seeing it.
    b.apply(b.insert(3, "XY"));
    const insFromB = b.insert(3, "Z");
    const del = a.delete(1, 4); // removes b c d e
    a.apply(insFromB);
    const c = RgaDocument.fromSnapshot(b.snapshot(), "ccc");
    const result = c.apply(del);
    expect(result.status).toBe("applied");
    expect(c.toString()).toBe("aZXYf");
    expect(result.changes).toEqual([
      { kind: "delete", index: 1, length: 2 },
      { kind: "delete", index: 4, length: 2 },
    ]);
  });

  it("ignores duplicates and buffers out-of-order ops", () => {
    const a = new RgaDocument("aaa");
    const b = new RgaDocument("bbb");
    const op1 = a.insert(0, "ab");
    const op2 = a.insert(2, "cd");
    const op3 = a.delete(0, 1);
    expect(b.apply(op3).status).toBe("pending");
    expect(b.apply(op2).status).toBe("pending");
    expect(b.stats().pending).toBe(2);
    const res = b.apply(op1);
    expect(res.status).toBe("applied");
    expect(applyTextChanges("", res.changes)).toBe("bcd");
    expect(b.toString()).toBe("bcd");
    expect(b.apply(op2).status).toBe("duplicate");
    expect(b.stats().pending).toBe(0);
  });

  it("buffers ops whose causal dependencies come from another site", () => {
    const a = new RgaDocument("aaa");
    const b = new RgaDocument("bbb");
    const c = new RgaDocument("ccc");
    const opA = a.insert(0, "x");
    b.apply(opA);
    const opB = b.insert(1, "y");
    expect(c.canApply(opB)).toBe(false);
    expect(c.apply(opB).status).toBe("pending");
    c.apply(opA);
    expect(c.toString()).toBe("xy");
  });

  it("handles concurrent deletes of the same character", () => {
    const base = RgaDocument.fromText("abc", "base");
    const a = RgaDocument.fromSnapshot(base.snapshot(), "aaa");
    const b = RgaDocument.fromSnapshot(base.snapshot(), "bbb");
    const da = a.delete(1, 1);
    const db = b.delete(1, 1);
    expect(a.apply(db).changes).toEqual([]);
    expect(b.apply(da).changes).toEqual([]);
    expect(a.toString()).toBe("ac");
    expect(b.toString()).toBe("ac");
  });

  it("advances the Lamport clock past remote ops", () => {
    const a = new RgaDocument("aaa");
    const b = new RgaDocument("bbb");
    for (let i = 0; i < 5; i++) b.apply(a.insert(0, "abc"));
    b.apply(a.insert(0, "z"));
    expect(b.lamport).toBe(a.lamport);
    const op = b.insert(0, "q");
    expect(op.clock).toBe(a.lamport + 1);
  });

  it("limits the pending buffer", () => {
    const b = new RgaDocument("bbb", { maxPending: 2 });
    const a = new RgaDocument("aaa");
    a.insert(0, "a");
    const ops = [a.insert(1, "b"), a.insert(2, "c"), a.insert(3, "d")];
    b.apply(ops[0] as RgaOp);
    b.apply(ops[1] as RgaOp);
    expect(() => b.apply(ops[2] as RgaOp)).toThrow(/pending/);
    expect(b.clearPending()).toBe(2);
  });
});

describe("anchors", () => {
  it("resolves caret anchors through concurrent edits", () => {
    const doc = RgaDocument.fromText("hello world", "aaa");
    const anchor = doc.anchorAt(6); // caret before "w"
    expect(anchor).toBe(makeKey("aaa", 6));
    doc.insert(0, ">> ");
    expect(doc.resolveAnchor(anchor)).toBe(9);
    doc.delete(3, 6); // delete "hello " including the anchored space
    expect(doc.toString()).toBe(">> world");
    expect(doc.resolveAnchor(anchor)).toBe(3);
    expect(doc.resolveAnchor(null)).toBe(0);
    expect(doc.anchorAt(0)).toBeNull();
    expect(doc.resolveAnchor("999@zzz")).toBeNull();
  });

  it("returns keys of visible characters", () => {
    const doc = RgaDocument.fromText("ab", "aaa");
    expect(doc.keyAt(1)).toBe("2@aaa");
    expect(doc.keyAt(2)).toBeNull();
    expect(doc.hasElement("1@aaa")).toBe(true);
  });
});

describe("snapshots and garbage collection", () => {
  it("round-trips through snapshots with run compression", () => {
    const doc = new RgaDocument("aaa");
    doc.insert(0, "hello world");
    doc.delete(5, 6);
    doc.insert(5, "!");
    const snap = doc.snapshot();
    expect(snap.runs).toEqual([
      ["aaa", 1, "hello", 0],
      ["aaa", 13, "!", 0],
      ["aaa", 6, " world", 1],
    ]);
    const copy = RgaDocument.fromSnapshot(JSON.parse(JSON.stringify(snap)), "bbb");
    expect(copy.toString()).toBe("hello!");
    expect(copy.lamport).toBe(doc.lamport);
    expect(copy.versionVector()).toEqual({ aaa: 2 + 1 });
  });

  it("restores own sequence numbers when reusing a site id", () => {
    const doc = new RgaDocument("aaa");
    doc.insert(0, "x");
    const copy = RgaDocument.fromSnapshot(doc.snapshot(), "aaa");
    const op = copy.insert(1, "y");
    expect(op.seq).toBe(2);
  });

  it("rejects corrupt snapshots", () => {
    expect(() => RgaDocument.fromSnapshot({ version: 2 })).toThrow(SnapshotError);
    expect(() =>
      RgaDocument.fromSnapshot({ version: 1, clock: 1, vv: {}, runs: [["a", 1, "ab", 0]] }),
    ).toThrow(/exceeds/);
    expect(() =>
      RgaDocument.fromSnapshot({ version: 1, clock: 5, vv: {}, runs: [["a", 1, "a", 0], ["a", 1, "b", 0]] }),
    ).toThrow(/duplicate/);
    expect(RgaDocument.fromSnapshot(emptySnapshot()).toString()).toBe("");
  });

  it("collects tombstones while retaining requested anchors", () => {
    const doc = RgaDocument.fromText("abcdef", "aaa");
    doc.delete(1, 3);
    const keep = new Set([makeKey("aaa", 3)]);
    expect(doc.collectGarbage(keep)).toBe(2);
    expect(doc.stats().tombstones).toBe(1);
    expect(doc.hasElement(makeKey("aaa", 3))).toBe(true);
    expect(doc.toString()).toBe("aef");
    expect(doc.collectGarbage()).toBe(1);
    expect(doc.snapshot().runs).toEqual([
      ["aaa", 1, "a", 0],
      ["aaa", 5, "ef", 0],
    ]);
  });

  it("rejects duplicate inserts after their tombstones were collected", () => {
    const a = new RgaDocument("aaa");
    const b = new RgaDocument("bbb");
    const ins = a.insert(0, "abc");
    const del = a.delete(0, 3);
    b.apply(ins);
    b.apply(del);
    b.collectGarbage();
    expect(b.apply(ins).status).toBe("duplicate");
    expect(b.toString()).toBe("");
  });
});

describe("text change helpers", () => {
  it("transforms caret positions", () => {
    const changes = [
      { kind: "insert", index: 0, text: "ab" },
      { kind: "delete", index: 5, length: 3 },
    ] as const;
    expect(transformIndex(0, changes)).toBe(0);
    expect(transformIndex(0, changes, true)).toBe(2);
    expect(transformIndex(4, changes)).toBe(6 - 1);
    expect(transformIndex(10, changes)).toBe(9);
  });
});
