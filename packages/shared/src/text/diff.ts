/** A single contiguous replacement turning one string into another. */
export interface Splice {
  readonly index: number;
  readonly deleteCount: number;
  readonly insertText: string;
}

/**
 * Computes the single splice transforming `prev` into `next`.
 *
 * Text inputs report only the new value, so the edit has to be recovered by
 * diffing. Ambiguity (typing "a" into "aa") is resolved with the caret
 * position after the edit: the changed region in `next` always ends at the
 * caret for typing, pasting and both kinds of deletion, which bounds the
 * common suffix.
 */
export function diffText(prev: string, next: string, caretAfter?: number): Splice | null {
  if (prev === next) return null;
  const caret = caretAfter === undefined ? undefined : Math.max(0, Math.min(caretAfter, next.length));
  const maxSuffix = Math.min(prev.length, next.length, caret === undefined ? Number.POSITIVE_INFINITY : next.length - caret);
  let suffix = 0;
  while (suffix < maxSuffix && prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) {
    suffix++;
  }
  const maxPrefix = Math.min(prev.length, next.length) - suffix;
  let prefix = 0;
  while (prefix < maxPrefix && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  return {
    index: prefix,
    deleteCount: prev.length - prefix - suffix,
    insertText: next.slice(prefix, next.length - suffix),
  };
}

/** Applies a splice to a string. */
export function applySplice(text: string, splice: Splice): string {
  return text.slice(0, splice.index) + splice.insertText + text.slice(splice.index + splice.deleteCount);
}

/**
 * Computes a minimal list of splices (applied right-to-left safe order is not
 * required; they are expressed sequentially) that transform `prev` into
 * `next` using line granularity first and character granularity inside the
 * changed block. Used for version restore so that unchanged regions keep
 * their CRDT identity (and therefore comment anchors and cursors).
 */
export function diffLines(prev: string, next: string): Splice[] {
  const a = splitLines(prev);
  const b = splitLines(next);
  const lcs = longestCommonSubsequence(a, b);
  const splices: Splice[] = [];
  let ai = 0;
  let bi = 0;
  let offset = 0; // position in the evolving text
  const flush = (aEnd: number, bEnd: number): void => {
    const removed = a.slice(ai, aEnd).join("");
    const inserted = b.slice(bi, bEnd).join("");
    if (removed.length > 0 || inserted.length > 0) {
      const inner = diffText(removed, inserted);
      if (inner) {
        splices.push({ index: offset + inner.index, deleteCount: inner.deleteCount, insertText: inner.insertText });
      }
    }
    offset += inserted.length;
    ai = aEnd;
    bi = bEnd;
  };
  for (const [ia, ib] of lcs) {
    flush(ia, ib);
    offset += (a[ia] as string).length;
    ai = ia + 1;
    bi = ib + 1;
  }
  flush(a.length, b.length);
  return splices;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split(/(?<=\n)/);
  return parts;
}

/** Classic O(n*m) LCS over lines, bounded to keep worst cases reasonable. */
function longestCommonSubsequence(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > 4_000_000) {
    // Too large for the quadratic table: fall back to matching only the
    // common prefix and suffix lines.
    const pairs: Array<[number, number]> = [];
    let p = 0;
    while (p < n && p < m && a[p] === b[p]) {
      pairs.push([p, p]);
      p++;
    }
    let s = 0;
    const tail: Array<[number, number]> = [];
    while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) {
      tail.unshift([n - 1 - s, m - 1 - s]);
      s++;
    }
    return pairs.concat(tail);
  }
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] as Uint32Array;
    const below = table[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((table[i + 1] as Uint32Array)[j] as number >= ((table[i] as Uint32Array)[j + 1] as number)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
