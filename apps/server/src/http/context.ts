import type { IncomingMessage, ServerResponse } from "node:http";
import type { ZodType } from "zod";
import type { AuthContext, ClientMeta } from "../auth/auth-service.js";
import { AppError, parseInput, unauthenticated } from "../core/errors.js";

/** Per-request state handed to route handlers. */
export class RequestContext {
  params: Record<string, string> = {};
  auth: AuthContext | null = null;
  status = 200;
  readonly responseHeaders: Record<string, string> = {};
  private bodyPromise: Promise<unknown> | null = null;

  constructor(
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
    readonly url: URL,
    readonly requestId: string,
    readonly ip: string,
    private readonly bodyLimit: number,
  ) {}

  get method(): string {
    return this.req.method ?? "GET";
  }

  get path(): string {
    return this.url.pathname;
  }

  /** The authenticated caller; throws 401 when the route ran without auth. */
  get user(): AuthContext {
    if (!this.auth) throw unauthenticated();
    return this.auth;
  }

  get userId(): string {
    return this.user.user.id;
  }

  param(name: string): string {
    const value = this.params[name];
    if (value === undefined) throw new AppError("bad_request", `missing path parameter ${name}`);
    return value;
  }

  clientMeta(): ClientMeta {
    const ua = this.req.headers["user-agent"];
    return { ip: this.ip, userAgent: typeof ua === "string" ? ua : null };
  }

  /** Reads and parses the JSON body once (subsequent calls reuse it). */
  body(): Promise<unknown> {
    this.bodyPromise ??= readJsonBody(this.req, this.bodyLimit);
    return this.bodyPromise;
  }

  async parseBody<S extends ZodType>(schema: S): Promise<ReturnType<S["parse"]>> {
    return parseInput(schema, (await this.body()) ?? {});
  }

  parseQuery<S extends ZodType>(schema: S): ReturnType<S["parse"]> {
    const query: Record<string, string> = {};
    for (const [k, v] of this.url.searchParams) query[k] = v;
    return parseInput(schema, query);
  }
}

/**
 * Reads a JSON request body with a hard size limit. Requests declaring a
 * larger Content-Length are refused before reading; chunked bodies are cut
 * off as soon as they exceed the limit.
 */
export function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new AppError("payload_too_large", `request body exceeds ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new AppError("payload_too_large", `request body exceeds ${limit} bytes`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      if (size === 0) {
        resolve(undefined);
        return;
      }
      const type = String(req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(type)) {
        reject(new AppError("unsupported_media_type", "request body must be application/json"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AppError("bad_request", "request body is not valid JSON"));
      }
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}
