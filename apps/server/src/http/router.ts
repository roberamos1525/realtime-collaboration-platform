import type { RequestContext } from "./context.js";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type RouteHandler = (ctx: RequestContext) => unknown | Promise<unknown>;

export interface RouteOptions {
  /** Require a valid access token (default true). */
  readonly auth?: boolean;
  /** Extra rate-limit bucket applied in addition to the global one. */
  readonly rateLimit?: "auth";
  /** Status for successful responses with a body (default 200). */
  readonly status?: number;
}

export interface Route {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: RouteHandler;
  readonly options: RouteOptions;
  readonly regex: RegExp;
  readonly keys: string[];
}

export type MatchResult =
  | { readonly kind: "found"; readonly route: Route; readonly params: Record<string, string> }
  | { readonly kind: "method_not_allowed"; readonly allowed: HttpMethod[] }
  | { readonly kind: "not_found" };

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        keys.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^${source}/?$`), keys };
}

/** Small path router with `:param` segments and 405 detection. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: HttpMethod, pattern: string, handler: RouteHandler, options: RouteOptions = {}): this {
    const { regex, keys } = compile(pattern);
    if (this.routes.some((r) => r.method === method && r.pattern === pattern)) {
      throw new Error(`duplicate route ${method} ${pattern}`);
    }
    this.routes.push({ method, pattern, handler, options, regex, keys });
    return this;
  }

  get(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add("GET", pattern, handler, options);
  }

  post(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add("POST", pattern, handler, options);
  }

  patch(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add("PATCH", pattern, handler, options);
  }

  delete(pattern: string, handler: RouteHandler, options?: RouteOptions): this {
    return this.add("DELETE", pattern, handler, options);
  }

  match(method: string, path: string): MatchResult {
    const allowed: HttpMethod[] = [];
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      let malformed = false;
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1] as string);
        } catch {
          malformed = true;
        }
      });
      if (malformed) return { kind: "not_found" };
      return { kind: "found", route, params };
    }
    return allowed.length > 0 ? { kind: "method_not_allowed", allowed } : { kind: "not_found" };
  }

  list(): Array<{ method: HttpMethod; pattern: string; auth: boolean }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern, auth: r.options.auth !== false }));
  }
}
