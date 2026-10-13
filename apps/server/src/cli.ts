#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { registerSchema } from "@rcp/shared";
import { createCore, type Core } from "./app.js";
import { ConfigError, loadConfig } from "./core/config.js";
import { createLogger } from "./core/logger.js";
import { MIGRATIONS } from "./db/migrations.js";
import { seedDemo } from "./seed.js";

const HELP = `rcp-server CLI

Usage: node dist/cli.js <command> [options]

Commands:
  migrate                         Apply pending database migrations
  seed [--password <pw>]          Create demo users/workspace (idempotent)
  create-user --email <e> --username <u> --name <n> --password <p>
  compact                         Snapshot every document, GC tombstones, trim op logs
  prune-sessions [--days <n>]     Delete sessions expired/revoked more than n days ago (default 7)
  stats                           Print row counts and schema version
  help                            Show this message

Configuration comes from the same environment variables as the server
(DATABASE_PATH, CONFIG_FILE, ...).`;

type Out = (line: string) => void;

export async function runCli(argv: string[], out: Out = (l) => process.stdout.write(`${l}\n`), coreFactory?: () => Core): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        password: { type: "string" },
        email: { type: "string" },
        username: { type: "string" },
        name: { type: "string" },
        days: { type: "string" },
      },
    });
  } catch (err) {
    out(`invalid arguments: ${(err as Error).message}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const command = positionals[0] ?? "help";
  if (command === "help" || command === "--help") {
    out(HELP);
    return 0;
  }
  const known = ["migrate", "seed", "create-user", "compact", "prune-sessions", "stats"];
  if (!known.includes(command)) {
    out(`unknown command: ${command}\n\n${HELP}`);
    return 2;
  }
  const core =
    coreFactory?.() ??
    (() => {
      const config = loadConfig();
      return createCore(config, { logger: createLogger(config.logLevel === "info" ? "warn" : config.logLevel) });
    })();
  try {
    switch (command) {
      case "migrate":
        out(`schema is at migration ${MIGRATIONS.at(-1)?.id ?? 0}`);
        return 0;
      case "seed": {
        const password = values.password ?? "demo-password-123";
        const result = await seedDemo(core, password);
        out(result.created ? `seeded demo workspace ${result.workspaceId} (users: alice, bob, carol, dave)` : "demo data already present");
        return 0;
      }
      case "create-user": {
        const parsed = registerSchema.safeParse({
          email: values.email,
          username: values.username,
          displayName: values.name,
          password: values.password,
        });
        if (!parsed.success) {
          out(`invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
          return 2;
        }
        const result = await core.services.auth.register(parsed.data, { ip: null, userAgent: "cli" });
        out(`created user ${result.user.username} (${result.user.id})`);
        return 0;
      }
      case "compact": {
        let collected = 0;
        let trimmed = 0;
        const ids = core.repos.documents.listIds();
        for (const id of ids) {
          const session = core.services.sessions.get(id);
          const r = core.services.sessions.compact(session);
          collected += r.collected;
          trimmed += r.trimmed;
          core.services.sessions.drop(id);
        }
        out(`compacted ${ids.length} documents: ${collected} tombstones collected, ${trimmed} log entries trimmed`);
        return 0;
      }
      case "prune-sessions": {
        const days = Number(values.days ?? "7");
        if (!Number.isFinite(days) || days < 0) {
          out("--days must be a non-negative number");
          return 2;
        }
        out(`pruned ${core.services.auth.pruneSessions(days * 86_400_000)} sessions`);
        return 0;
      }
      case "stats": {
        const count = (table: string): number => core.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0;
        const tables = ["users", "sessions", "workspaces", "memberships", "documents", "document_ops", "document_versions", "comments", "tasks", "notifications", "activity"];
        out(`schema migration: ${MIGRATIONS.at(-1)?.id ?? 0}`);
        for (const t of tables) out(`${t.padEnd(18)} ${count(t)}`);
        return 0;
      }
    }
    return 2;
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    core.services.sessions.close();
    core.services.search.close();
    core.db.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof ConfigError) process.stderr.write(`configuration error: ${err.message}\n`);
      else process.stderr.write(`fatal: ${String(err)}\n`);
      process.exit(1);
    });
}
