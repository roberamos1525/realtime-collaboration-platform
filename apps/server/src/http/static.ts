import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serves the built single-page app. Hashed assets under /assets are cached
 * immutably; other paths without a file extension fall back to index.html so
 * client-side routes work on reload.
 */
export class StaticFiles {
  private readonly root: string;
  readonly available: boolean;

  constructor(dir: string) {
    this.root = resolve(dir);
    this.available = existsSync(join(this.root, "index.html"));
  }

  /** Returns true if the request was handled. */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (!this.available || (req.method !== "GET" && req.method !== "HEAD")) return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (decoded.includes("\0")) return false;
    const target = resolve(this.root, `.${normalize(decoded)}`);
    // Path traversal guard: the resolved path must stay inside the root.
    if (target !== this.root && !target.startsWith(this.root + sep)) return false;
    let file = target;
    let isFile = existsSync(file) && statSync(file).isFile();
    if (!isFile) {
      if (extname(decoded) !== "") return false;
      file = join(this.root, "index.html");
      isFile = true;
    }
    const ext = extname(file).toLowerCase();
    const stat = statSync(file);
    res.statusCode = 200;
    res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", decoded.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  }
}
