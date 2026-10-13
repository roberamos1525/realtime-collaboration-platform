import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./core/config.js";
import { AppError, notFound, rateLimited, toAppError, unauthenticated } from "./core/errors.js";
import { EventBus } from "./core/events.js";
import { createLogger, type Logger } from "./core/logger.js";
import { createAppMetrics, type AppMetrics } from "./core/metrics.js";
import { RateLimiter } from "./core/rate-limiter.js";
import { newId, systemClock, type Clock } from "./core/util.js";
import { Database } from "./db/database.js";
import { migrate } from "./db/migrations.js";
import { RequestContext } from "./http/context.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerDocumentRoutes } from "./http/routes/documents.js";
import { registerInboxRoutes } from "./http/routes/inbox.js";
import { registerWorkspaceRoutes } from "./http/routes/workspaces.js";
import { Router } from "./http/router.js";
import { applySecurityHeaders, clientIp, handleCors } from "./http/security.js";
import { StaticFiles } from "./http/static.js";
import { RealtimeGateway } from "./realtime/gateway.js";
import { createRepositories, type Repositories } from "./repositories/index.js";
import { createServices, type Services } from "./services/index.js";

export interface AppOptions {
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface App {
  readonly config: AppConfig;
  readonly server: Server;
  readonly db: Database;
  readonly repos: Repositories;
  readonly services: Services;
  readonly gateway: RealtimeGateway;
  readonly metrics: AppMetrics;
  readonly router: Router;
  readonly logger: Logger;
  listen(port?: number, host?: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header) throw unauthenticated();
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw unauthenticated("malformed Authorization header");
  return match[1] as string;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface Core {
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: AppMetrics;
  readonly db: Database;
  readonly repos: Repositories;
  readonly events: EventBus;
  readonly services: Services;
}

/** Opens the database, applies migrations and wires services (no transport). */
export function createCore(config: AppConfig, options: AppOptions = {}): Core {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger(config.logLevel);
  const metrics = createAppMetrics();
  const db = new Database(config.databasePath);
  const migration = migrate(db);
  if (migration.applied.length > 0) logger.info("database migrated", { applied: migration.applied });
  const repos = createRepositories(db);
  const events = new EventBus(logger);
  const services = createServices({ config, db, repos, events, clock, logger, metrics });
  return { config, clock, logger, metrics, db, repos, events, services };
}

/** Builds the full application (HTTP + WebSocket + services) without listening. */
export function createApp(config: AppConfig, options: AppOptions = {}): App {
  const { clock, logger, metrics, db, repos, events, services } = createCore(config, options);
  const indexed = services.search.rebuild();
  logger.info("search index built", indexed);

  const router = new Router();
  registerAuthRoutes(router, services);
  registerWorkspaceRoutes(router, services);
  registerDocumentRoutes(router, services);
  registerInboxRoutes(router, services);

  const globalLimiter = new RateLimiter(config.rateLimit.global, clock);
  const authLimiter = new RateLimiter(config.rateLimit.auth, clock);
  const staticFiles = config.staticDir ? new StaticFiles(config.staticDir) : null;
  if (config.staticDir && !staticFiles?.available) logger.warn("static directory has no index.html; UI not served", { dir: config.staticDir });

  const gateway = new RealtimeGateway({
    config,
    logger,
    metrics,
    events,
    clock,
    auth: services.auth,
    access: services.access,
    sessions: services.sessions,
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const headerId = req.headers["x-request-id"];
    const requestId = typeof headerId === "string" && REQUEST_ID.test(headerId) ? headerId : newId("req", 12);
    res.setHeader("X-Request-Id", requestId);
    applySecurityHeaders(res, config);
    if (handleCors(req, res, config)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const ip = clientIp(req, config.trustProxy);
    const method = req.method ?? "GET";
    let routeLabel = "static";
    const stopTimer = metrics.httpDuration.startTimer();
    res.once("finish", () => metrics.httpRequests.inc({ method, route: routeLabel, status: res.statusCode }));
    try {
      if (url.pathname === "/healthz") {
        routeLabel = "/healthz";
        sendJson(res, 200, { data: { status: "ok" } });
        return;
      }
      const rate = globalLimiter.take(ip);
      if (!rate.allowed) {
        metrics.rateLimited.inc({ scope: "global" });
        throw rateLimited(rate.retryAfterSeconds);
      }
      if (url.pathname === "/readyz") {
        routeLabel = "/readyz";
        db.get("SELECT 1 AS ok");
        sendJson(res, 200, { data: { status: "ready", sessions: services.sessions.stats(), realtime: gateway.stats(), search: services.search.stats() } });
        return;
      }
      if (url.pathname === "/metrics") {
        routeLabel = "/metrics";
        if (config.http.metricsToken) {
          const auth = req.headers.authorization ?? "";
          if (!safeEqual(auth, `Bearer ${config.http.metricsToken}`)) throw unauthenticated("metrics token required");
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        res.end(metrics.registry.render());
        return;
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        routeLabel = "unmatched";
        const match = router.match(method, url.pathname);
        if (match.kind === "not_found") throw notFound("route");
        if (match.kind === "method_not_allowed") {
          throw new AppError("method_not_allowed", `method ${method} not allowed`, undefined, { Allow: match.allowed.join(", ") });
        }
        const { route, params } = match;
        routeLabel = route.pattern;
        if (route.options.rateLimit === "auth") {
          const authRate = authLimiter.take(ip);
          if (!authRate.allowed) {
            metrics.rateLimited.inc({ scope: "auth" });
            throw rateLimited(authRate.retryAfterSeconds);
          }
        }
        const ctx = new RequestContext(req, res, url, requestId, ip, config.http.bodyLimitBytes);
        ctx.params = params;
        if (route.options.auth !== false) ctx.auth = services.auth.authenticate(bearerToken(req));
        const result = await route.handler(ctx);
        if (result === undefined) {
          res.statusCode = 204;
          res.setHeader("Cache-Control", "no-store");
          res.end();
        } else {
          sendJson(res, route.options.status ?? 200, { data: result }, ctx.responseHeaders);
        }
        return;
      }
      if (staticFiles?.serve(req, res, url.pathname)) return;
      throw notFound("resource");
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.status >= 500) logger.error("request failed", { requestId, method, path: url.pathname, err });
      if (!res.headersSent) sendJson(res, appErr.status, appErr.toEnvelope(requestId), appErr.headers);
      else res.destroy();
    } finally {
      stopTimer({ method, route: routeLabel });
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      logger.error("unhandled request error", { err });
      if (!res.headersSent) sendJson(res, 500, { error: { code: "internal", message: "internal server error" } });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.on("upgrade", (req, socket, head) => {
    if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
  });

  const maintenance = setInterval(() => {
    try {
      const evicted = services.sessions.evictIdle();
      if (evicted > 0) logger.debug("evicted idle documents", { evicted });
    } catch (err) {
      logger.error("maintenance failed", { err });
    }
  }, 30_000);
  maintenance.unref();
  const prune = setInterval(() => services.auth.pruneSessions(), 6 * 3_600_000);
  prune.unref();

  let closed = false;
  return {
    config,
    server,
    db,
    repos,
    services,
    gateway,
    metrics,
    router,
    logger,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          logger.info("server listening", { host: address.address, port: address.port });
          resolve(address);
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(maintenance);
      clearInterval(prune);
      await gateway.shutdown();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
      });
      services.sessions.close();
      services.search.close();
      db.close();
      logger.info("server stopped");
    },
  };
}
