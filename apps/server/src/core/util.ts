import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Random URL-safe identifier with a type prefix, e.g. `doc_3fK9…`. */
export function newId(prefix: string, length = 16): string {
  const bytes = randomBytes(length);
  let out = `${prefix}_`;
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Injectable time source so tests can control expiry and timeouts. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  constructor(private current = Date.parse("2026-01-01T00:00:00Z")) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Lowercase, ASCII-only slug used for workspace URLs. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "workspace";
}

/** Opaque pagination cursor helpers (base64url encoded JSON tuple). */
export function encodeCursor(parts: ReadonlyArray<string | number>): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): Array<string | number> | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string" || typeof p === "number")) return parsed;
  } catch {
    // fall through
  }
  return null;
}
