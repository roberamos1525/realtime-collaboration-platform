/**
 * Text analysis for the search index: tokenisation with source offsets,
 * diacritic folding, stop-word removal and a light English stemmer.
 */

export interface Token {
  /** Normalised (folded, lower-cased, stemmed) term. */
  readonly term: string;
  readonly start: number;
  readonly end: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

export const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our " +
    "she so that the their them then there these they this to was we were what when which who will with you your"
  ).split(" "),
);

/** Lower-cases and strips diacritics ("Café" -> "cafe"). */
export function fold(word: string): string {
  return word
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’]/g, "")
    .toLowerCase();
}

function isConsonant(word: string, i: number): boolean {
  const c = word[i];
  if (c === undefined) return false;
  if ("aeiou".includes(c)) return false;
  if (c === "y") return i === 0 || !isConsonant(word, i - 1);
  return true;
}

function hasVowel(stem: string): boolean {
  for (let i = 0; i < stem.length; i++) if (!isConsonant(stem, i)) return true;
  return false;
}

/** Undo consonant doubling caused by suffixes ("running" -> "run"). */
function undouble(stem: string): string {
  const n = stem.length;
  if (n >= 2 && stem[n - 1] === stem[n - 2] && isConsonant(stem, n - 1) && !"lsz".includes(stem[n - 1] as string)) {
    return stem.slice(0, -1);
  }
  return stem;
}

/**
 * A deliberately small stemmer covering the most common English inflections
 * (plurals, -ing, -ed, -ly, -ment, -ness, -ation). It is applied identically
 * to documents and queries, which is all ranking needs.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);

  if (w.endsWith("ing") && w.length > 5 && hasVowel(w.slice(0, -3))) w = undouble(w.slice(0, -3));
  else if (w.endsWith("ed") && w.length > 4 && hasVowel(w.slice(0, -2))) w = undouble(w.slice(0, -2));

  if (w.endsWith("ational") && w.length > 8) w = `${w.slice(0, -7)}ate`;
  else if (w.endsWith("ation") && w.length > 7) w = `${w.slice(0, -5)}ate`;
  else if (w.endsWith("ness") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ment") && w.length > 7) w = w.slice(0, -4);
  else if (w.endsWith("ly") && w.length > 5) w = w.slice(0, -2);
  return w;
}

/** Normalises one raw word into an index term, or null for stop words. */
export function normalizeTerm(raw: string): string | null {
  const folded = fold(raw);
  if (folded.length === 0 || STOP_WORDS.has(folded)) return null;
  if (folded.length === 1 && !/\d/.test(folded)) return null;
  return stem(folded);
}

/** Tokenises text, keeping offsets into the original string. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    const term = normalizeTerm(match[0]);
    if (term) tokens.push({ term, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Terms of a text (with repetitions), used for indexing. */
export function analyze(text: string): string[] {
  return tokenize(text).map((t) => t.term);
}

export interface ParsedQuery {
  readonly terms: string[];
  /** Folded, un-stemmed last word for prefix (search-as-you-type) matching. */
  readonly prefix: string | null;
}

export function parseQuery(query: string): ParsedQuery {
  const words = [...query.matchAll(WORD)].map((m) => m[0]);
  const terms: string[] = [];
  for (const w of words) {
    const t = normalizeTerm(w);
    if (t && !terms.includes(t)) terms.push(t);
  }
  const last = words.at(-1);
  const trailingSpace = /\s$/.test(query);
  const prefix = last && !trailingSpace ? fold(last) : null;
  return { terms, prefix: prefix && prefix.length >= 2 ? prefix : null };
}
