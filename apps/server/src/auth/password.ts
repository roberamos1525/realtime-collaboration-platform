import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with scrypt. Stored format:
 *   scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>
 * Parameters are stored with the hash so the cost can be raised later and old
 * hashes upgraded on the next successful login (see {@link needsRehash}).
 */

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export function defaultParams(cost: number): ScryptParams {
  return { N: cost, r: 8, p: 1 };
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string, params: ScryptParams): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  const salt = Buffer.from(parts[4] as string, "base64url");
  const key = Buffer.from(parts[5] as string, "base64url");
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { params: { N, r, p }, salt, key };
}

/** Constant-time verification. Malformed hashes never verify. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.params);
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}

/** True when the stored hash uses different parameters than `params`. */
export function needsRehash(stored: string, params: ScryptParams): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.params.N !== params.N || parsed.params.r !== params.r || parsed.params.p !== params.p;
}
