/**
 * Identifiers for RGA elements.
 *
 * Every character ever inserted into a document receives a globally unique
 * identifier made of a Lamport timestamp (`clock`) and the id of the replica
 * (`site`) that created it. The pair is totally ordered, which is what lets
 * concurrent insertions at the same position be ordered identically on every
 * replica.
 */
export interface CharId {
  readonly site: string;
  readonly clock: number;
}

/** Maximum length of a site identifier accepted on the wire. */
export const MAX_SITE_LENGTH = 32;

const SITE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidSite(site: string): boolean {
  return SITE_PATTERN.test(site);
}

/** Total order over ids: higher clock wins, ties broken by site id. */
export function compareIds(a: CharId, b: CharId): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
  if (a.site === b.site) return 0;
  return a.site < b.site ? -1 : 1;
}

/** Stable string key for an id, used for map lookups and anchors. */
export function idKey(id: CharId): string {
  return `${id.clock}@${id.site}`;
}

export function makeKey(site: string, clock: number): string {
  return `${clock}@${site}`;
}

/** Parses a key produced by {@link idKey}. Returns null for malformed input. */
export function parseKey(key: string): CharId | null {
  const at = key.indexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  const clockPart = key.slice(0, at);
  const site = key.slice(at + 1);
  if (!/^\d+$/.test(clockPart) || !isValidSite(site)) return null;
  const clock = Number(clockPart);
  if (!Number.isSafeInteger(clock) || clock < 1) return null;
  return { site, clock };
}

const SITE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generates a random site id. Uses `crypto.getRandomValues`, available in
 * browsers and in Node >= 19 as a global.
 */
export function randomSiteId(length = 12): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += SITE_ALPHABET[b % SITE_ALPHABET.length];
  return out;
}
