import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Configuration is resolved in three layers: built-in defaults, an optional
 * JSON file (path from `CONFIG_FILE`), then environment variables. The merged
 * result is validated once at startup so misconfiguration fails fast.
 */

const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const bucket = z.object({
  capacity: z.number().int().positive(),
  refillPerSecond: z.number().positive(),
});

export const configSchema = z
  .object({
    env: z.enum(["development", "production", "test"]),
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    databasePath: z.string().min(1),
    staticDir: z.string().nullable(),
    logLevel: z.enum(LOG_LEVELS),
    trustProxy: z.boolean(),
    auth: z.object({
      jwtSecret: z.string().min(32, "JWT secret must be at least 32 characters"),
      jwtIssuer: z.string().min(1),
      accessTokenTtlSeconds: z.number().int().min(30).max(86_400),
      refreshTokenTtlSeconds: z.number().int().min(300).max(90 * 86_400),
      scryptCost: z.number().int().min(1024).max(1 << 20).refine((n) => (n & (n - 1)) === 0, "must be a power of two"),
    }),
    http: z.object({
      corsOrigins: z.array(z.string().min(1)),
      bodyLimitBytes: z.number().int().min(1024).max(10 * 1024 * 1024),
      hsts: z.boolean(),
      metricsToken: z.string().min(16).nullable(),
    }),
    rateLimit: z.object({
      global: bucket,
      auth: bucket,
      ws: bucket,
    }),
    realtime: z.object({
      heartbeatIntervalMs: z.number().int().min(1000),
      presenceTimeoutMs: z.number().int().min(2000),
      authTimeoutMs: z.number().int().min(500),
      maxConnectionsPerUser: z.number().int().positive(),
      maxBufferedBytes: z.number().int().min(64 * 1024),
    }),
    documents: z.object({
      snapshotEveryOps: z.number().int().min(10),
      idleEvictMs: z.number().int().min(1000),
      contentFlushMs: z.number().int().min(50),
      editActivityWindowMs: z.number().int().min(1000),
    }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.realtime.presenceTimeoutMs <= cfg.realtime.heartbeatIntervalMs) {
      ctx.addIssue({ code: "custom", path: ["realtime", "presenceTimeoutMs"], message: "must exceed heartbeatIntervalMs" });
    }
    if (cfg.env === "production" && cfg.auth.jwtSecret.startsWith("dev-")) {
      ctx.addIssue({ code: "custom", path: ["auth", "jwtSecret"], message: "JWT_SECRET must be set in production" });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type ConfigOverrides = DeepPartial<AppConfig>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultConfig(env: AppConfig["env"] = "development"): AppConfig {
  return {
    env,
    host: "127.0.0.1",
    port: 4000,
    databasePath: "./var/rcp.sqlite",
    staticDir: null,
    logLevel: env === "test" ? "silent" : "info",
    trustProxy: false,
    auth: {
      // Development-only secret; production refuses to start with it.
      jwtSecret: `dev-${randomBytes(24).toString("hex")}`,
      jwtIssuer: "rcp",
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 30 * 86_400,
      scryptCost: env === "test" ? 1024 : 16_384,
    },
    http: {
      corsOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
      bodyLimitBytes: 1024 * 1024,
      hsts: false,
      metricsToken: null,
    },
    rateLimit: {
      global: { capacity: 300, refillPerSecond: 50 },
      auth: { capacity: 10, refillPerSecond: 0.2 },
      ws: { capacity: 200, refillPerSecond: 100 },
    },
    realtime: {
      heartbeatIntervalMs: 15_000,
      presenceTimeoutMs: 45_000,
      authTimeoutMs: 5_000,
      maxConnectionsPerUser: 20,
      maxBufferedBytes: 4 * 1024 * 1024,
    },
    documents: {
      snapshotEveryOps: 200,
      idleEvictMs: 5 * 60_000,
      contentFlushMs: 1_000,
      editActivityWindowMs: 10 * 60_000,
    },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively merges `patch` into `base`; arrays and scalars replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function num(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} must be a number, got ${JSON.stringify(value)}`);
  return n;
}

function bool(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new ConfigError(`${name} must be a boolean, got ${JSON.stringify(value)}`);
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Maps supported environment variables onto a partial config. */
export function configFromEnv(env: NodeJS.ProcessEnv): ConfigOverrides {
  return {
    host: env.HOST || undefined,
    port: num(env.PORT, "PORT"),
    databasePath: env.DATABASE_PATH || undefined,
    staticDir: env.STATIC_DIR || undefined,
    logLevel: (env.LOG_LEVEL as LogLevel | undefined) || undefined,
    trustProxy: bool(env.TRUST_PROXY, "TRUST_PROXY"),
    auth: {
      jwtSecret: env.JWT_SECRET || undefined,
      accessTokenTtlSeconds: num(env.ACCESS_TOKEN_TTL_SECONDS, "ACCESS_TOKEN_TTL_SECONDS"),
      refreshTokenTtlSeconds: num(env.REFRESH_TOKEN_TTL_SECONDS, "REFRESH_TOKEN_TTL_SECONDS"),
      scryptCost: num(env.SCRYPT_COST, "SCRYPT_COST"),
    },
    http: {
      corsOrigins: list(env.CORS_ORIGINS),
      bodyLimitBytes: num(env.BODY_LIMIT_BYTES, "BODY_LIMIT_BYTES"),
      hsts: bool(env.HSTS, "HSTS"),
      metricsToken: env.METRICS_TOKEN || undefined,
    },
    documents: {
      snapshotEveryOps: num(env.SNAPSHOT_EVERY_OPS, "SNAPSHOT_EVERY_OPS"),
    },
  };
}

export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly overrides?: ConfigOverrides;
  readonly cwd?: string;
}

/** Resolves defaults <- CONFIG_FILE <- environment <- explicit overrides. */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const nodeEnv = env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  let merged: unknown = defaultConfig(nodeEnv);
  const file = env.CONFIG_FILE;
  if (file) {
    const path = resolve(options.cwd ?? process.cwd(), file);
    if (!existsSync(path)) throw new ConfigError(`CONFIG_FILE not found: ${path}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new ConfigError(`CONFIG_FILE is not valid JSON: ${(err as Error).message}`);
    }
    if (!isPlainObject(parsed)) throw new ConfigError("CONFIG_FILE must contain a JSON object");
    merged = deepMerge(merged, parsed);
  }
  merged = deepMerge(merged, configFromEnv(env));
  if (options.overrides) merged = deepMerge(merged, options.overrides);
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid configuration: ${details}`);
  }
  return result.data;
}
