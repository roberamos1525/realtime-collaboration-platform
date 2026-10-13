import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCore, makeUser, type TestCore } from "../__tests__/helpers.js";
import type { AppError } from "../core/errors.js";
import { signAccessToken, verifyAccessToken } from "./jwt.js";
import { defaultParams, hashPassword, needsRehash, verifyPassword } from "./password.js";

const SECRET = "unit-test-secret-unit-test-secret-1234";

describe("password hashing", () => {
  it("hashes with a random salt and verifies", async () => {
    const params = defaultParams(1024);
    const a = await hashPassword("hunter2hunter2", params);
    const b = await hashPassword("hunter2hunter2", params);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(await verifyPassword("hunter2hunter2", a)).toBe(true);
    expect(await verifyPassword("hunter3hunter3", a)).toBe(false);
  });

  it("normalises unicode before hashing", async () => {
    const hash = await hashPassword("café-password", defaultParams(1024));
    expect(await verifyPassword("café-password", hash)).toBe(true);
  });

  it("never verifies malformed hashes and flags rehash needs", async () => {
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1024$8$1$c2FsdA$c2hvcnQ")).toBe(false);
    const hash = await hashPassword("pw-pw-pw-pw", defaultParams(1024));
    expect(needsRehash(hash, defaultParams(1024))).toBe(false);
    expect(needsRehash(hash, defaultParams(2048))).toBe(true);
    expect(needsRehash("garbage", defaultParams(1024))).toBe(true);
  });
});

describe("JWT access tokens", () => {
  const now = Date.parse("2026-05-01T00:00:00Z");

  it("round-trips claims", () => {
    const { token, expiresAt } = signAccessToken({ sub: "usr_1", sid: "ses_1" }, SECRET, { issuer: "rcp", ttlSeconds: 60, nowMs: now });
    expect(expiresAt).toBe(now + 60_000);
    const claims = verifyAccessToken(token, SECRET, { issuer: "rcp", nowMs: now + 1000 });
    expect(claims).toMatchObject({ sub: "usr_1", sid: "ses_1", typ: "access", iss: "rcp" });
  });

  it("rejects expired, tampered, foreign and alg=none tokens", () => {
    const { token } = signAccessToken({ sub: "usr_1", sid: "ses_1" }, SECRET, { issuer: "rcp", ttlSeconds: 60, nowMs: now });
    const expectCode = (fn: () => unknown, code: string) => {
      try {
        fn();
        expect.unreachable();
      } catch (err) {
        expect((err as AppError).code).toBe(code);
      }
    };
    expectCode(() => verifyAccessToken(token, SECRET, { issuer: "rcp", nowMs: now + 61_000 }), "token_expired");
    expectCode(() => verifyAccessToken(token, "another-secret-another-secret-123456", { issuer: "rcp", nowMs: now }), "unauthenticated");
    expectCode(() => verifyAccessToken(token, SECRET, { issuer: "other", nowMs: now }), "unauthenticated");
    const [h, p] = token.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "usr_2" })).toString("base64url");
    expectCode(() => verifyAccessToken(`${h}.${forged}.${token.split(".")[2]}`, SECRET, { issuer: "rcp", nowMs: now }), "unauthenticated");
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expectCode(() => verifyAccessToken(`${none}.${p}.`, SECRET, { issuer: "rcp", nowMs: now }), "unauthenticated");
    expectCode(() => verifyAccessToken("not-a-token", SECRET, { issuer: "rcp", nowMs: now }), "unauthenticated");
    expectCode(() => verifyAccessToken(token, SECRET, { issuer: "rcp", nowMs: now - 120_000 }), "unauthenticated");
  });
});

describe("AuthService", () => {
  let core: TestCore;
  beforeEach(() => {
    core = createTestCore();
  });
  afterEach(() => core.close());

  it("registers users and rejects duplicates", async () => {
    const user = await makeUser(core, "alice");
    expect(core.services.auth.authenticate(user.accessToken).user.username).toBe("alice");
    await expect(makeUser(core, "alice")).rejects.toMatchObject({ code: "conflict" });
    await expect(
      core.services.auth.register(
        { email: "alice@example.test", username: "other", displayName: "x", password: "long-enough-pw" },
        { ip: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ code: "conflict", details: { field: "email" } });
  });

  it("logs in by username or e-mail and rejects bad credentials uniformly", async () => {
    await makeUser(core, "bob");
    const meta = { ip: null, userAgent: null };
    expect((await core.services.auth.login({ login: "bob", password: "correct horse battery" }, meta)).user.username).toBe("bob");
    expect((await core.services.auth.login({ login: "BOB@example.test", password: "correct horse battery" }, meta)).user.username).toBe(
      "bob",
    );
    await expect(core.services.auth.login({ login: "bob", password: "wrong" }, meta)).rejects.toMatchObject({ message: "invalid credentials" });
    await expect(core.services.auth.login({ login: "nobody", password: "wrong" }, meta)).rejects.toMatchObject({
      message: "invalid credentials",
    });
    expect(core.metrics.authEvents.get({ event: "login_failed" })).toBe(2);
  });

  it("rotates refresh tokens and detects reuse", async () => {
    const user = await makeUser(core);
    const meta = { ip: null, userAgent: null };
    const first = core.services.auth.refresh(user.refreshToken, meta);
    expect(first.refreshToken).not.toBe(user.refreshToken);
    const revoked: string[] = [];
    core.events.on("session.revoked", (e) => revoked.push(e.sessionId));
    // Replaying the old token revokes the session, including the new token.
    expect(() => core.services.auth.refresh(user.refreshToken, meta)).toThrow(/invalid refresh token/);
    expect(revoked).toHaveLength(1);
    expect(() => core.services.auth.refresh(first.refreshToken, meta)).toThrow(/revoked/);
    expect(() => core.services.auth.authenticate(first.accessToken)).toThrow(/no longer valid/);
  });

  it("expires access tokens and refresh tokens", async () => {
    const user = await makeUser(core);
    core.manualClock.advance(16 * 60_000);
    expect(() => core.services.auth.authenticate(user.accessToken)).toThrow(/expired/);
    const refreshed = core.services.auth.refresh(user.refreshToken, { ip: null, userAgent: null });
    expect(core.services.auth.authenticate(refreshed.accessToken).user.id).toBe(user.id);
    core.manualClock.advance(31 * 86_400_000);
    expect(() => core.services.auth.refresh(refreshed.refreshToken, { ip: null, userAgent: null })).toThrow(/expired/);
  });

  it("revokes sessions on logout and logout-all", async () => {
    const user = await makeUser(core, "carol");
    const second = await core.services.auth.login({ login: "carol", password: "correct horse battery" }, { ip: null, userAgent: null });
    const ctx = core.services.auth.authenticate(user.accessToken);
    core.services.auth.logout(ctx.sessionId);
    expect(() => core.services.auth.authenticate(user.accessToken)).toThrow();
    expect(core.services.auth.authenticate(second.accessToken).user.id).toBe(user.id);
    expect(core.services.auth.logoutAll(user.id)).toBe(1);
    expect(() => core.services.auth.authenticate(second.accessToken)).toThrow();
  });

  it("changes passwords, keeping only the current session", async () => {
    const user = await makeUser(core, "dave");
    const other = await core.services.auth.login({ login: "dave", password: "correct horse battery" }, { ip: null, userAgent: null });
    const ctx = core.services.auth.authenticate(user.accessToken);
    await expect(core.services.auth.changePassword(ctx, "wrong", "new password 123")).rejects.toMatchObject({ code: "forbidden" });
    expect(await core.services.auth.changePassword(ctx, "correct horse battery", "new password 123")).toBe(1);
    expect(() => core.services.auth.authenticate(other.accessToken)).toThrow();
    expect(core.services.auth.authenticate(user.accessToken).user.id).toBe(user.id);
    await expect(core.services.auth.login({ login: "dave", password: "new password 123" }, { ip: null, userAgent: null })).resolves.toBeTruthy();
  });

  it("upgrades password hashes when the cost parameter changes", async () => {
    await makeUser(core, "erin");
    const stronger = createTestCore({ auth: { scryptCost: 2048 } });
    try {
      const before = core.repos.users.findByUsername("erin");
      stronger.repos.users.insert({ ...(before as NonNullable<typeof before>) });
      await stronger.services.auth.login({ login: "erin", password: "correct horse battery" }, { ip: null, userAgent: null });
      expect(stronger.repos.users.findByUsername("erin")?.passwordHash).toMatch(/^scrypt\$2048\$/);
    } finally {
      stronger.close();
    }
  });

  it("prunes old sessions", async () => {
    const user = await makeUser(core);
    core.services.auth.logout(core.services.auth.authenticate(user.accessToken).sessionId);
    core.manualClock.advance(8 * 86_400_000);
    expect(core.services.auth.pruneSessions()).toBe(1);
  });
});
