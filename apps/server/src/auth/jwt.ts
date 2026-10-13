import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../core/errors.js";

/**
 * Minimal HS256 JSON Web Token implementation (RFC 7519) on top of
 * node:crypto. Only the HS256 algorithm is accepted, which rules out
 * algorithm-confusion attacks such as `alg: none`.
 */

export interface AccessClaims {
  readonly sub: string;
  readonly sid: string;
  readonly typ: "access";
  readonly iss: string;
  readonly iat: number;
  readonly exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const CLOCK_SKEW_SECONDS = 30;

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

export function signAccessToken(
  claims: { sub: string; sid: string },
  secret: string,
  options: { issuer: string; ttlSeconds: number; nowMs: number },
): { token: string; expiresAt: number } {
  const iat = Math.floor(options.nowMs / 1000);
  const exp = iat + options.ttlSeconds;
  const payload: AccessClaims = { sub: claims.sub, sid: claims.sid, typ: "access", iss: options.issuer, iat, exp };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const input = `${HEADER}.${body}`;
  return { token: `${input}.${sign(input, secret)}`, expiresAt: exp * 1000 };
}

function invalid(message = "invalid access token"): AppError {
  return new AppError("unauthenticated", message);
}

function decodeJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
}

export function verifyAccessToken(token: string, secret: string, options: { issuer: string; nowMs: number }): AccessClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw invalid();
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];
  const header = decodeJson(headerSeg) as { alg?: unknown; typ?: unknown };
  if (typeof header !== "object" || header === null || header.alg !== "HS256") throw invalid("unsupported token algorithm");
  const expected = Buffer.from(sign(`${headerSeg}.${payloadSeg}`, secret));
  const actual = Buffer.from(signatureSeg);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalid();
  const claims = decodeJson(payloadSeg) as Partial<AccessClaims>;
  if (
    typeof claims !== "object" ||
    claims === null ||
    typeof claims.sub !== "string" ||
    typeof claims.sid !== "string" ||
    claims.typ !== "access" ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number"
  ) {
    throw invalid();
  }
  if (claims.iss !== options.issuer) throw invalid("token issuer mismatch");
  const now = Math.floor(options.nowMs / 1000);
  if (claims.iat > now + CLOCK_SKEW_SECONDS) throw invalid("token issued in the future");
  if (claims.exp <= now) throw new AppError("token_expired", "access token expired");
  return claims as AccessClaims;
}
