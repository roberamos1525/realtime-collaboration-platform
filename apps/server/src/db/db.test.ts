import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { MIGRATIONS, MigrationError, migrate, type Migration } from "./migrations.js";

describe("Database", () => {
  it("runs nested transactions with savepoints", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (1)");
      expect(() =>
        db.transaction(() => {
          db.run("INSERT INTO t VALUES (2)");
          throw new Error("inner failure");
        }),
      ).toThrow("inner failure");
      db.run("INSERT INTO t VALUES (3)");
    });
    expect(db.all<{ v: number }>("SELECT v FROM t ORDER BY v").map((r) => r.v)).toEqual([1, 3]);
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t VALUES (4)");
        throw new Error("outer failure");
      }),
    ).toThrow();
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM t")?.n).toBe(2);
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it("supports positional and named parameters", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)");
    db.run("INSERT INTO kv VALUES (?, ?)", ["a", "1"]);
    db.run("INSERT INTO kv VALUES (:k, :v)", { k: "b", v: "2" });
    expect(db.get<{ v: string }>("SELECT v FROM kv WHERE k = :k", { k: "b" })?.v).toBe("2");
    expect(db.all("SELECT * FROM kv")).toHaveLength(2);
    db.close();
  });

  it("creates parent directories and enables WAL for file databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "rcp-db-"));
    const db = new Database(join(dir, "nested", "app.sqlite"));
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    db.close();
  });
});

describe("migrations", () => {
  it("applies all migrations once", () => {
    const db = new Database(":memory:");
    const first = migrate(db);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => `${m.id}_${m.name}`));
    expect(migrate(db).applied).toEqual([]);
    const columns = db.all<{ name: string }>("PRAGMA table_info(users)").map((c) => c.name);
    expect(columns).toContain("last_login_at");
    db.close();
  });

  it("detects edited migrations", () => {
    const db = new Database(":memory:");
    const base: Migration[] = [{ id: 1, name: "one", sql: "CREATE TABLE a (x INTEGER);" }];
    migrate(db, base);
    expect(() => migrate(db, [{ id: 1, name: "one", sql: "CREATE TABLE a (y INTEGER);" }])).toThrow(MigrationError);
    db.close();
  });

  it("refuses databases created by newer code and unordered lists", () => {
    const db = new Database(":memory:");
    migrate(db, [
      { id: 1, name: "one", sql: "CREATE TABLE a (x INTEGER);" },
      { id: 2, name: "two", sql: "CREATE TABLE b (x INTEGER);" },
    ]);
    expect(() => migrate(db, [{ id: 1, name: "one", sql: "CREATE TABLE a (x INTEGER);" }])).toThrow(/unknown migration/);
    expect(() =>
      migrate(new Database(":memory:"), [
        { id: 2, name: "b", sql: "SELECT 1;" },
        { id: 1, name: "a", sql: "SELECT 1;" },
      ]),
    ).toThrow(/ordered/);
    db.close();
  });

  it("rolls back a failing migration atomically", () => {
    const db = new Database(":memory:");
    const bad: Migration[] = [{ id: 1, name: "bad", sql: "CREATE TABLE ok (x INTEGER); INSERT INTO missing VALUES (1);" }];
    expect(() => migrate(db, bad)).toThrow();
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'ok'")).toEqual([]);
    expect(db.all("SELECT * FROM schema_migrations")).toEqual([]);
    db.close();
  });

  it("enforces foreign keys and check constraints", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() =>
      db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('w', 'u', 'editor', 'now')"),
    ).toThrow(/FOREIGN KEY/);
    db.run("INSERT INTO users (id, email, username, display_name, password_hash, created_at, updated_at) VALUES ('u','e','n','d','h','t','t')");
    db.run("INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at) VALUES ('w','n','s','u','t','t')");
    expect(() =>
      db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES ('w', 'u', 'superuser', 'now')"),
    ).toThrow(/CHECK/);
    db.close();
  });
});
