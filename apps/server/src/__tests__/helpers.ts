import type { Role } from "@rcp/shared";
import { createCore, type Core } from "../app.js";
import { defaultConfig, deepMerge, type AppConfig, type ConfigOverrides } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { ManualClock } from "../core/util.js";

export function testConfig(overrides: ConfigOverrides = {}): AppConfig {
  const base = defaultConfig("test");
  return deepMerge(
    {
      ...base,
      databasePath: ":memory:",
      logLevel: "silent",
      auth: { ...base.auth, jwtSecret: "test-secret-0123456789-0123456789-abcdef", scryptCost: 1024 },
      documents: { ...base.documents, contentFlushMs: 50 },
    } satisfies AppConfig,
    overrides,
  );
}

export interface TestCore extends Core {
  readonly manualClock: ManualClock;
  close(): void;
}

export function createTestCore(overrides: ConfigOverrides = {}): TestCore {
  const manualClock = new ManualClock(Date.parse("2026-03-01T12:00:00Z"));
  const config = testConfig(overrides);
  const core = createCore(config, { clock: manualClock, logger: createLogger("silent") });
  return {
    ...core,
    manualClock,
    close() {
      core.services.sessions.close();
      core.services.search.close();
      core.db.close();
    },
  };
}

let counter = 0;

/** Registers a user and returns its id. */
export async function makeUser(core: Core, name?: string): Promise<{ id: string; username: string; accessToken: string; refreshToken: string }> {
  const username = name ?? `user${++counter}x`;
  const result = await core.services.auth.register(
    { email: `${username}@example.test`, username, displayName: username.toUpperCase(), password: "correct horse battery" },
    { ip: "127.0.0.1", userAgent: "vitest" },
  );
  return { id: result.user.id, username, accessToken: result.accessToken, refreshToken: result.refreshToken };
}

/** Creates a workspace owned by `ownerId` with additional members. */
export function makeWorkspace(core: Core, ownerId: string, members: Array<{ username: string; role: Exclude<Role, "owner"> }> = []): string {
  const ws = core.services.workspaces.create(ownerId, { name: `Workspace ${++counter}`, description: "" });
  for (const m of members) core.services.workspaces.addMember(ownerId, ws.id, m.username, m.role);
  return ws.id;
}
