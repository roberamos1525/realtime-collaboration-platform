import { analyze, parseQuery, tokenize } from "./analyzer.js";

/**
 * In-memory inverted index with BM25F-style ranking over weighted fields.
 *
 * Each entry has a set of named fields (e.g. title, body). Term frequencies
 * are length-normalised per field, combined with field weights, and scored
 * with BM25 saturation and IDF. A coordination factor favours entries that
 * match more of the query terms, and the last query word also matches as a
 * prefix so results update while typing.
 */

export interface FieldSpec {
  readonly name: string;
  readonly weight: number;
}

interface Entry<M> {
  readonly key: string;
  readonly meta: M;
  readonly lengths: number[];
  readonly tf: Map<string, number[]>;
}

export interface SearchMatch<M> {
  readonly key: string;
  readonly meta: M;
  readonly score: number;
  /** Index terms of the entry that matched the query. */
  readonly matched: string[];
}

export interface SearchOptions<M> {
  readonly limit: number;
  readonly filter?: (meta: M) => boolean;
}

const K1 = 1.2;
const B = 0.75;
const PREFIX_WEIGHT = 0.6;
const MAX_PREFIX_EXPANSIONS = 30;

export class InvertedIndex<M> {
  private readonly entries = new Map<string, Entry<M>>();
  private readonly postings = new Map<string, Set<string>>();
  private readonly totalLengths: number[];
  private sortedTerms: string[] | null = null;

  constructor(readonly fields: readonly FieldSpec[]) {
    this.totalLengths = fields.map(() => 0);
  }

  get size(): number {
    return this.entries.size;
  }

  get termCount(): number {
    return this.postings.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  getMeta(key: string): M | undefined {
    return this.entries.get(key)?.meta;
  }

  /** Adds or replaces an entry. `values` maps field names to text. */
  upsert(key: string, values: Record<string, string>, meta: M): void {
    this.remove(key);
    const lengths: number[] = [];
    const tf = new Map<string, number[]>();
    this.fields.forEach((field, fi) => {
      const terms = analyze(values[field.name] ?? "");
      lengths.push(terms.length);
      this.totalLengths[fi] = (this.totalLengths[fi] as number) + terms.length;
      for (const term of terms) {
        let counts = tf.get(term);
        if (!counts) {
          counts = this.fields.map(() => 0);
          tf.set(term, counts);
        }
        counts[fi] = (counts[fi] as number) + 1;
      }
    });
    for (const term of tf.keys()) {
      let set = this.postings.get(term);
      if (!set) {
        set = new Set();
        this.postings.set(term, set);
        this.sortedTerms = null;
      }
      set.add(key);
    }
    this.entries.set(key, { key, meta, lengths, tf });
  }

  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.lengths.forEach((len, fi) => {
      this.totalLengths[fi] = (this.totalLengths[fi] as number) - len;
    });
    for (const term of entry.tf.keys()) {
      const set = this.postings.get(term);
      if (!set) continue;
      set.delete(key);
      if (set.size === 0) {
        this.postings.delete(term);
        this.sortedTerms = null;
      }
    }
    this.entries.delete(key);
    return true;
  }

  /** Removes every entry whose metadata matches the predicate. */
  removeWhere(predicate: (meta: M, key: string) => boolean): number {
    let n = 0;
    for (const [key, entry] of [...this.entries]) {
      if (predicate(entry.meta, key)) {
        this.remove(key);
        n++;
      }
    }
    return n;
  }

  search(query: string, options: SearchOptions<M>): SearchMatch<M>[] {
    const parsed = parseQuery(query);
    // Weighted query terms: exact terms weight 1, prefix expansions less.
    const queryTerms = new Map<string, number>();
    for (const t of parsed.terms) queryTerms.set(t, 1);
    if (parsed.prefix) {
      for (const t of this.expandPrefix(parsed.prefix)) if (!queryTerms.has(t)) queryTerms.set(t, PREFIX_WEIGHT);
    }
    if (queryTerms.size === 0) return [];
    // Number of distinct user-visible words, for the coordination factor.
    const wanted = Math.max(1, parsed.terms.length);
    const n = this.entries.size;
    const avg = this.totalLengths.map((total) => (n > 0 ? total / n : 0));
    const scores = new Map<string, { score: number; matched: Set<string> }>();

    for (const [term, qWeight] of queryTerms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
      for (const key of posting) {
        const entry = this.entries.get(key) as Entry<M>;
        if (options.filter && !options.filter(entry.meta)) continue;
        const counts = entry.tf.get(term) as number[];
        let weightedTf = 0;
        this.fields.forEach((field, fi) => {
          const tf = counts[fi] as number;
          if (tf === 0) return;
          const norm = 1 - B + B * ((entry.lengths[fi] as number) / ((avg[fi] as number) || 1));
          weightedTf += (field.weight * tf) / norm;
        });
        const termScore = qWeight * idf * ((weightedTf * (K1 + 1)) / (weightedTf + K1));
        const acc = scores.get(key) ?? { score: 0, matched: new Set<string>() };
        acc.score += termScore;
        acc.matched.add(term);
        scores.set(key, acc);
      }
    }

    const results: SearchMatch<M>[] = [];
    for (const [key, { score, matched }] of scores) {
      const exactMatched = parsed.terms.filter((t) => matched.has(t)).length;
      const prefixMatched = parsed.prefix && [...matched].some((t) => queryTerms.get(t) === PREFIX_WEIGHT) ? 1 : 0;
      const coverage = Math.min(1, (exactMatched + (exactMatched < wanted ? prefixMatched : 0)) / wanted);
      results.push({ key, meta: (this.entries.get(key) as Entry<M>).meta, score: score * (0.5 + 0.5 * coverage), matched: [...matched] });
    }
    results.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    return results.slice(0, options.limit);
  }

  private expandPrefix(prefix: string): string[] {
    if (!this.sortedTerms) this.sortedTerms = [...this.postings.keys()].sort();
    const terms = this.sortedTerms;
    let lo = 0;
    let hi = terms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((terms[mid] as string) < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < terms.length && out.length < MAX_PREFIX_EXPANSIONS; i++) {
      const t = terms[i] as string;
      if (!t.startsWith(prefix)) break;
      out.push(t);
    }
    return out;
  }
}

export interface Snippet {
  readonly text: string;
  readonly highlights: Array<[number, number]>;
}

/**
 * Builds a short excerpt around the first matching term, with highlight
 * ranges (relative to the excerpt) for every matching token inside it.
 */
export function buildSnippet(text: string, matchedTerms: readonly string[], maxLength = 180): Snippet {
  const flat = text.replace(/\s+/g, " ").trim();
  const wanted = new Set(matchedTerms);
  const tokens = tokenize(flat).filter((t) => wanted.has(t.term));
  if (flat.length <= maxLength && tokens.length === 0) return { text: flat, highlights: [] };
  const first = tokens[0];
  let start = 0;
  if (first && first.start > maxLength / 3) start = Math.max(0, first.start - Math.floor(maxLength / 3));
  // Snap to a word boundary.
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < start + 20) start = space + 1;
  }
  let end = Math.min(flat.length, start + maxLength);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start + maxLength / 2) end = space;
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const highlights: Array<[number, number]> = [];
  for (const t of tokens) {
    if (t.start >= start && t.end <= end) highlights.push([t.start - start + prefix.length, t.end - start + prefix.length]);
  }
  return { text: `${prefix}${flat.slice(start, end)}${suffix}`, highlights };
}
