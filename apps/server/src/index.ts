#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";

/** Default location of the built web client relative to the compiled server. */
function defaultStaticDir(): string | null {
  const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  return existsSync(resolve(candidate, "index.html")) ? candidate : null;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`configuration error: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (config.staticDir === null) config = { ...config, staticDir: defaultStaticDir() };
  const logger = createLogger(config.logLevel);
  if (config.auth.jwtSecret.startsWith("dev-")) {
    logger.warn("JWT_SECRET not set; using an ephemeral development secret (sessions end on restart)");
  }
  const app = createApp(config, { logger });
  await app.listen();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info("shutting down", { signal });
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error("error during shutdown", { err });
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => logger.error("unhandled rejection", { err }));
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
