import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../core/config.js";

/** Baseline security headers applied to every HTTP response. */
export function applySecurityHeaders(res: ServerResponse, config: AppConfig): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' ws: wss:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (config.http.hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

const ALLOWED_HEADERS = "Authorization, Content-Type, X-Request-Id";
const ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

/**
 * Applies CORS headers for allow-listed origins. Returns true when the
 * request was a preflight that has been answered.
 */
export function handleCors(req: IncomingMessage, res: ServerResponse, config: AppConfig): boolean {
  const origin = req.headers.origin;
  const allowed = typeof origin === "string" && config.http.corsOrigins.includes(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id, Retry-After");
  }
  if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
    if (allowed) {
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.setHeader("Access-Control-Max-Age", "600");
    }
    res.statusCode = allowed ? 204 : 403;
    res.end();
    return true;
  }
  return false;
}

/** Client IP, honouring X-Forwarded-For only when behind a trusted proxy. */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}
