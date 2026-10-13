import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConfigError, deepMerge, defaultConfig, loadConfig } from "./config.js";
import { AppError, parseInput, rateLimited, toAppError, validationError } from "./errors.js";
import { EventBus } from "./events.js";
import { createLogger, createMemoryLogger } from "./logger.js";
import { MetricsRegistry, createAppMetrics } from "./metrics.js";
import { RateLimiter } from "./rate-limiter.js";
import { ManualClock, decodeCursor, encodeCursor, newId, slugify } from "./util.js";

describe("config", () => {
  it("loads defaults for development", () => {
    const config = loadConfig({ env: {} });
    expect(config.env).toBe("development");
    expect(config.port).toBe(4000);
    expect(config.auth.jwtSecret.startsWith("dev-")).toBe(true);
  });

  it("applies environment overrides with type coercion", () => {
    const config = loadConfig({
      env: { PORT: "8080", CORS_ORIGINS: "https://a.test, https://b.test", HSTS: "true", SNAPSHOT_EVERY_OPS: "50", JWT_SECRET: "x".repeat(40) },
    });
    expect(config.port).toBe(8080);
    expect(config.http.corsOrigins).toEqual(["https://a.test", "https://b.test"]);
    expect(config.http.hsts).toBe(true);
    expect(config.documents.snapshotEveryOps).toBe(50);
  });

  it("layers a JSON config file below the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "rcp-config-"));
    writeFileSync(join(dir, "c.json"), JSON.stringify({ port: 5000, host: "0.0.0.0", realtime: { heartbeatIntervalMs: 5000 } }));
    const config = loadConfig({ env: { CONFIG_FILE: "c.json", PORT: "5001" }, cwd: dir });
    expect(config.port).toBe(5001);
    expect(config.host).toBe("0.0.0.0");
    expect(config.realtime.heartbeatIntervalMs).toBe(5000);
    expect(config.realtime.presenceTimeoutMs).toBe(45_000);
  });

  it("rejects invalid values with a readable message", () => {
    expect(() => loadConfig({ env: { PORT: "abc" } })).toThrow(ConfigError);
    expect(() => loadConfig({ env: { PORT: "70000" } })).toThrow(/port/);
    expect(() => loadConfig({ env: { HSTS: "maybe" } })).toThrow(/boolean/);
    expect(() => loadConfig({ env: { CONFIG_FILE: "missing.json" } })).toThrow(/not found/);
    expect(() => loadConfig({ env: {}, overrides: { realtime: { heartbeatIntervalMs: 50_000 } } })).toThrow(/presenceTimeoutMs/);
  });

  it("requires a real JWT secret in production", () => {
    expect(() => loadConfig({ env: { NODE_ENV: "production" } })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ env: { NODE_ENV: "production", JWT_SECRET: "short" } })).toThrow(/32/);
    expect(loadConfig({ env: { NODE_ENV: "production", JWT_SECRET: "p".repeat(48) } }).env).toBe("production");
  });

  it("deep merges objects but replaces arrays", () => {
    const merged = deepMerge(defaultConfig("test"), { http: { corsOrigins: ["x"] }, auth: { accessTokenTtlSeconds: 60 } });
    expect(merged.http.corsOrigins).toEqual(["x"]);
    expect(merged.http.bodyLimitBytes).toBe(1024 * 1024);
    expect(merged.auth.accessTokenTtlSeconds).toBe(60);
  });
});

describe("errors", () => {
  it("maps codes to statuses and envelopes", () => {
    const err = new AppError("not_found", "nope", { id: 1 });
    expect(err.status).toBe(404);
    expect(err.toEnvelope("req-1")).toEqual({ error: { code: "not_found", message: "nope", details: { id: 1 }, requestId: "req-1" } });
    expect(toAppError(new Error("boom")).status).toBe(500);
    expect(rateLimited(2.2).headers["Retry-After"]).toBe("3");
  });

  it("converts zod errors into validation envelopes", () => {
    const schema = z.object({ name: z.string().min(2), age: z.number() });
    const result = schema.safeParse({ name: "a", age: "x" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const err = validationError(result.error);
      expect(err.status).toBe(422);
      expect((err.details as { issues: Array<{ path: string }> }).issues.map((i) => i.path)).toEqual(["name", "age"]);
    }
    expect(() => parseInput(schema, {})).toThrow(AppError);
    expect(parseInput(schema, { name: "ok", age: 3 })).toEqual({ name: "ok", age: 3 });
  });
});

describe("RateLimiter", () => {
  it("allows bursts up to capacity then refills over time", () => {
    const clock = new ManualClock();
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1 }, clock);
    expect([1, 2, 3].map(() => limiter.take("ip").allowed)).toEqual([true, true, true]);
    const denied = limiter.take("ip");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeCloseTo(1);
    clock.advance(1500);
    expect(limiter.take("ip").allowed).toBe(true);
    expect(limiter.take("other").allowed).toBe(true);
  });

  it("bounds memory by evicting least recently used keys and pruning idle ones", () => {
    const clock = new ManualClock();
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1 }, clock, 3);
    for (const k of ["a", "b", "c", "d"]) limiter.take(k);
    expect(limiter.size).toBe(3);
    clock.advance(120_000);
    limiter.take("e");
    expect(limiter.size).toBe(1);
  });
});

describe("metrics", () => {
  it("renders counters, gauges and histograms in Prometheus format", () => {
    const registry = new MetricsRegistry();
    const c = registry.counter("test_total", "a counter");
    c.inc({ route: "/a", status: 200 });
    c.inc({ route: "/a", status: 200 }, 2);
    const g = registry.gauge("test_gauge", "a gauge").collect(() => 7);
    const h = registry.histogram("test_seconds", "a histogram", [0.1, 1]);
    h.observe(0.05);
    h.observe(0.5);
    const text = registry.render();
    expect(text).toContain('test_total{route="/a",status="200"} 3');
    expect(text).toContain("test_gauge 7");
    expect(text).toContain('test_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('test_seconds_bucket{le="+Inf"} 2');
    expect(g.get()).toBe(7);
    expect(() => registry.counter("test_total", "dup")).toThrow(/already/);
    expect(() => c.inc(undefined, -1)).toThrow();
  });

  it("creates the application metric set", () => {
    const m = createAppMetrics();
    const stop = m.httpDuration.startTimer({ method: "GET" });
    stop({ route: "/x" });
    expect(m.httpDuration.count({ method: "GET", route: "/x" })).toBe(1);
    expect(m.registry.render()).toContain("rcp_http_requests_total");
  });
});

describe("logger", () => {
  it("writes JSON lines with bindings and redacts secrets", () => {
    const { logger, lines } = createMemoryLogger("info");
    logger.debug("hidden");
    logger.child({ component: "x" }).info("hello", { password: "p", n: 1, err: new Error("bad") });
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: "info", msg: "hello", component: "x", password: "[redacted]", n: 1 });
    expect((out[0]?.err as { message: string }).message).toBe("bad");
  });

  it("is silent at level silent", () => {
    const sink = vi.fn();
    createLogger("silent", sink).error("x");
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("EventBus", () => {
  it("delivers typed events and isolates listener failures", () => {
    const { logger, lines } = createMemoryLogger();
    const bus = new EventBus(logger);
    const seen: string[] = [];
    bus.on("workspace.deleted", () => {
      throw new Error("listener bug");
    });
    const off = bus.on("workspace.deleted", (e) => seen.push(e.workspaceId));
    bus.emit({ type: "workspace.deleted", workspaceId: "w1" });
    off();
    bus.emit({ type: "workspace.deleted", workspaceId: "w2" });
    expect(seen).toEqual(["w1"]);
    expect(lines().some((l) => l.msg === "event listener failed")).toBe(true);
    expect(bus.listenerCount("workspace.deleted")).toBe(1);
  });
});

describe("util", () => {
  it("creates prefixed ids, slugs and cursors", () => {
    expect(newId("doc")).toMatch(/^doc_[0-9A-Za-z]{16}$/);
    expect(slugify("  Héllo, World!! ")).toBe("hello-world");
    expect(slugify("!!!")).toBe("workspace");
    const cursor = encodeCursor(["2026-01-01", "id_1"]);
    expect(decodeCursor(cursor)).toEqual(["2026-01-01", "id_1"]);
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});
