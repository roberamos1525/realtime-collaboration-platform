import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testConfig } from "./__tests__/helpers.js";
import { createCore } from "./app.js";
import { runCli } from "./cli.js";
import { createLogger } from "./core/logger.js";

describe("CLI", () => {
  const databasePath = join(mkdtempSync(join(tmpdir(), "rcp-cli-")), "cli.sqlite");
  const factory = () => createCore(testConfig({ databasePath }), { logger: createLogger("silent") });
  const run = async (...args: string[]) => {
    const lines: string[] = [];
    const code = await runCli(args, (l) => lines.push(l), factory);
    return { code, out: lines.join("\n") };
  };

  it("prints help and rejects unknown commands", async () => {
    expect((await run("help")).out).toContain("Usage:");
    const unknown = await run("frobnicate");
    expect(unknown.code).toBe(2);
    expect(unknown.out).toContain("unknown command");
  });

  it("seeds demo data idempotently and reports stats", async () => {
    const first = await run("seed", "--password", "demo-password-123");
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/seeded demo workspace ws_/);
    expect((await run("seed")).out).toBe("demo data already present");
    const stats = await run("stats");
    expect(stats.out).toMatch(/users\s+4/);
    expect(stats.out).toMatch(/documents\s+3/);
    expect(stats.out).toMatch(/tasks\s+5/);
  });

  it("creates users with validation", async () => {
    const bad = await run("create-user", "--email", "nope", "--username", "x", "--name", "", "--password", "short");
    expect(bad.code).toBe(2);
    expect(bad.out).toContain("invalid input");
    const ok = await run("create-user", "--email", "ops@example.test", "--username", "opsuser", "--name", "Ops", "--password", "a long password");
    expect(ok.out).toMatch(/created user opsuser \(usr_/);
    const dup = await run("create-user", "--email", "ops@example.test", "--username", "opsuser", "--name", "Ops", "--password", "a long password");
    expect(dup.code).toBe(1);
  });

  it("compacts documents and prunes sessions", async () => {
    expect((await run("compact")).out).toMatch(/compacted 3 documents/);
    expect((await run("prune-sessions", "--days=-1")).code).toBe(2);
    expect((await run("prune-sessions", "--bogus")).out).toContain("invalid arguments");
    expect((await run("prune-sessions", "--days", "0")).out).toMatch(/pruned \d+ sessions/);
    expect((await run("migrate")).out).toContain("schema is at migration 2");
  });
});
