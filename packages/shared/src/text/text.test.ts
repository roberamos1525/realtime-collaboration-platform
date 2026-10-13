import { describe, expect, it } from "vitest";
import { RgaDocument } from "../crdt/rga.js";
import { applySplice, diffLines, diffText } from "./diff.js";
import { excerpt, extractMentions, USERNAME_PATTERN } from "./mentions.js";

describe("diffText", () => {
  it("detects inserts, deletes and replacements", () => {
    expect(diffText("abc", "abc")).toBeNull();
    expect(diffText("abc", "abXc")).toEqual({ index: 2, deleteCount: 0, insertText: "X" });
    expect(diffText("abc", "ac")).toEqual({ index: 1, deleteCount: 1, insertText: "" });
    expect(diffText("hello world", "hello there")).toEqual({ index: 6, deleteCount: 5, insertText: "there" });
    expect(diffText("", "new")).toEqual({ index: 0, deleteCount: 0, insertText: "new" });
    expect(diffText("old", "")).toEqual({ index: 0, deleteCount: 3, insertText: "" });
  });

  it("uses the caret to disambiguate repeated characters", () => {
    // Typing "a" at the start of "aa" vs. at the end.
    expect(diffText("aa", "aaa", 1)).toEqual({ index: 0, deleteCount: 0, insertText: "a" });
    expect(diffText("aa", "aaa", 3)).toEqual({ index: 2, deleteCount: 0, insertText: "a" });
    expect(diffText("aa", "aaa")).toEqual({ index: 0, deleteCount: 0, insertText: "a" });
    // Backspace of the first "b" in "abb".
    expect(diffText("abb", "ab", 1)).toEqual({ index: 1, deleteCount: 1, insertText: "" });
    // Out-of-range carets are clamped.
    expect(diffText("x", "xy", 99)).toEqual({ index: 1, deleteCount: 0, insertText: "y" });
  });

  it("round-trips random edits", () => {
    let seed = 99;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 300; i++) {
      const base = "abcabc".repeat(1 + Math.floor(rand() * 3));
      const at = Math.floor(rand() * base.length);
      const del = Math.floor(rand() * Math.min(3, base.length - at));
      const ins = "abc".slice(0, Math.floor(rand() * 3));
      const next = base.slice(0, at) + ins + base.slice(at + del);
      const splice = diffText(base, next, at + ins.length);
      if (splice) expect(applySplice(base, splice)).toBe(next);
      else expect(base).toBe(next);
    }
  });
});

describe("diffLines", () => {
  function applyAll(text: string, prev: string, next: string): string {
    let out = text;
    for (const s of diffLines(prev, next)) out = applySplice(out, s);
    return out;
  }

  it("transforms text line by line", () => {
    const prev = "line one\nline two\nline three\n";
    const next = "line one\nline 2\nline three\nline four\n";
    expect(applyAll(prev, prev, next)).toBe(next);
    expect(diffLines(prev, prev)).toEqual([]);
    expect(applyAll("", "", "abc")).toBe("abc");
    expect(applyAll("abc\n", "abc\n", "")).toBe("");
  });

  it("keeps unchanged lines untouched in the CRDT", () => {
    const prev = "keep me\nchange me\nkeep me too\n";
    const next = "keep me\nchanged!\nkeep me too\n";
    const doc = RgaDocument.fromText(prev, "aaa");
    const keepKey = doc.keyAt(0);
    for (const s of diffLines(prev, next)) doc.splice(s.index, s.deleteCount, s.insertText);
    expect(doc.toString()).toBe(next);
    expect(doc.resolveAnchor(keepKey)).toBe(1);
    expect(doc.resolveAnchor(doc.keyAt(next.length - 1))).toBe(next.length);
  });

  it("handles random multi-line edits", () => {
    let seed = 5;
    const rand = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    const words = ["alpha", "beta", "gamma", "delta", ""];
    const make = () =>
      Array.from({ length: Math.floor(rand() * 8) }, () => words[Math.floor(rand() * words.length)] as string).join("\n");
    for (let i = 0; i < 200; i++) {
      const prev = make();
      const next = make();
      expect(applyAll(prev, prev, next)).toBe(next);
    }
  });
});

describe("mentions", () => {
  it("extracts unique, lower-cased usernames", () => {
    expect(extractMentions("hi @Alice and @bob, also @alice!")).toEqual(["alice", "bob"]);
    expect(extractMentions("@carol: please review")).toEqual(["carol"]);
    expect(extractMentions("(@dave.smith)")).toEqual(["dave.smith"]);
  });

  it("ignores e-mail addresses and trailing punctuation", () => {
    expect(extractMentions("mail me at x@example.com")).toEqual([]);
    expect(extractMentions("thanks @erin.")).toEqual(["erin"]);
    expect(extractMentions("no mentions here")).toEqual([]);
  });

  it("validates usernames", () => {
    expect(USERNAME_PATTERN.test("alice")).toBe(true);
    expect(USERNAME_PATTERN.test("a.b-c_d")).toBe(true);
    expect(USERNAME_PATTERN.test("ab")).toBe(false);
    expect(USERNAME_PATTERN.test("bad name")).toBe(false);
    expect(USERNAME_PATTERN.test("trailing.")).toBe(false);
  });

  it("builds excerpts", () => {
    expect(excerpt("  a\n\nb  ")).toBe("a b");
    expect(excerpt("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
