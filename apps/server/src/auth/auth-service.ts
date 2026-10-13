import type { AuthResult, LoginInput, RegisterInput } from "@rcp/shared";
import { AppError, conflict, unauthenticated } from "../core/errors.js";
import { iso, newId, randomToken, sha256 } from "../core/util.js";
import { toUserDto, type UserRecord } from "../repositories/users.js";
import type { ServiceDeps } from "../services/context.js";
import { signAccessToken, verifyAccessToken } from "./jwt.js";
import { defaultParams, hashPassword, needsRehash, verifyPassword, type ScryptParams } from "./password.js";

export interface ClientMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuthContext {
  readonly user: UserRecord;
  readonly sessionId: string;
}

/**
 * Registration, login, refresh-token rotation and revocation.
 *
 * Access tokens are short-lived HS256 JWTs bound to a session id. Refresh
 * tokens are opaque random strings; only their SHA-256 is stored. Every
 * refresh rotates the token, and presenting an already-rotated token revokes
 * the whole session (refresh token reuse detection). Access tokens are also
 * checked against the session on every request so logout takes effect
 * immediately.
 */
export class AuthService {
  private readonly params: ScryptParams;
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly deps: ServiceDeps) {
    this.params = defaultParams(deps.config.auth.scryptCost);
  }

  async register(input: RegisterInput, meta: ClientMeta): Promise<AuthResult> {
    const { users } = this.deps.repos;
    if (users.findByEmail(input.email)) throw conflict("an account with this e-mail already exists", { field: "email" });
    if (users.findByUsername(input.username)) throw conflict("this username is taken", { field: "username" });
    const passwordHash = await hashPassword(input.password, this.params);
    const now = iso(this.deps.clock.now());
    const user: UserRecord = {
      id: newId("usr"),
      email: input.email.toLowerCase(),
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    };
    try {
      users.insert(user);
    } catch (err) {
      // Lost a race against a concurrent registration with the same identity.
      if (String((err as Error).message).includes("UNIQUE")) throw conflict("account already exists");
      throw err;
    }
    this.deps.metrics.authEvents.inc({ event: "register" });
    this.deps.logger.info("user registered", { userId: user.id });
    return this.startSession(user, meta);
  }

  async login(input: LoginInput, meta: ClientMeta): Promise<AuthResult> {
    const user = this.deps.repos.users.findByLogin(input.login.trim());
    if (!user) {
      // Spend comparable time for unknown users to avoid account enumeration.
      this.dummyHash ??= hashPassword("not-a-real-password", this.params);
      await verifyPassword(input.password, await this.dummyHash);
      this.deps.metrics.authEvents.inc({ event: "login_failed" });
      throw unauthenticated("invalid credentials");
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      this.deps.metrics.authEvents.inc({ event: "login_failed" });
      throw unauthenticated("invalid credentials");
    }
    const now = iso(this.deps.clock.now());
    if (needsRehash(user.passwordHash, this.params)) {
      this.deps.repos.users.updatePasswordHash(user.id, await hashPassword(input.password, this.params), now);
    }
    this.deps.repos.users.touchLogin(user.id, now);
    this.deps.metrics.authEvents.inc({ event: "login" });
    return this.startSession(user, meta);
  }

  refresh(refreshToken: string, meta: ClientMeta): AuthResult {
    const { sessions, users } = this.deps.repos;
    const hash = sha256(refreshToken);
    const nowMs = this.deps.clock.now();
    const session = sessions.findByRefreshHash(hash);
    if (!session) {
      const reused = sessions.findByPreviousHash(hash);
      if (reused && !reused.revokedAt) {
        sessions.revoke(reused.id, "refresh_token_reuse", iso(nowMs));
        this.deps.events.emit({ type: "session.revoked", sessionId: reused.id });
        this.deps.metrics.authEvents.inc({ event: "refresh_reuse_detected" });
        this.deps.logger.warn("refresh token reuse detected; session revoked", { sessionId: reused.id, ip: meta.ip });
      }
      throw unauthenticated("invalid refresh token");
    }
    if (session.revokedAt) throw unauthenticated("session has been revoked");
    if (Date.parse(session.expiresAt) <= nowMs) throw unauthenticated("refresh token expired");
    const user = users.findById(session.userId);
    if (!user) throw unauthenticated("account no longer exists");
    const next = `${session.id}.${randomToken(32)}`;
    const refreshExpires = nowMs + this.deps.config.auth.refreshTokenTtlSeconds * 1000;
    if (!sessions.rotate(session.id, hash, sha256(next), iso(nowMs), iso(refreshExpires))) {
      throw unauthenticated("refresh token already used");
    }
    this.deps.metrics.authEvents.inc({ event: "refresh" });
    return this.buildResult(user, session.id, next, refreshExpires);
  }

  logout(sessionId: string): void {
    if (this.deps.repos.sessions.revoke(sessionId, "logout", iso(this.deps.clock.now()))) {
      this.deps.events.emit({ type: "session.revoked", sessionId });
      this.deps.metrics.authEvents.inc({ event: "logout" });
    }
  }

  /** Revokes every session of the user except (optionally) the current one. */
  logoutAll(userId: string, exceptSessionId?: string): number {
    const ids = this.deps.repos.sessions.revokeAllForUser(userId, "logout_all", iso(this.deps.clock.now()), exceptSessionId ?? null);
    for (const sessionId of ids) this.deps.events.emit({ type: "session.revoked", sessionId });
    return ids.length;
  }

  async changePassword(ctx: AuthContext, currentPassword: string, newPassword: string): Promise<number> {
    if (!(await verifyPassword(currentPassword, ctx.user.passwordHash))) {
      throw new AppError("forbidden", "current password is incorrect");
    }
    const hash = await hashPassword(newPassword, this.params);
    this.deps.repos.users.updatePasswordHash(ctx.user.id, hash, iso(this.deps.clock.now()));
    return this.logoutAll(ctx.user.id, ctx.sessionId);
  }

  /** Validates an access token and its session; returns the caller identity. */
  authenticate(accessToken: string): AuthContext {
    const nowMs = this.deps.clock.now();
    const claims = verifyAccessToken(accessToken, this.deps.config.auth.jwtSecret, {
      issuer: this.deps.config.auth.jwtIssuer,
      nowMs,
    });
    const session = this.deps.repos.sessions.findById(claims.sid);
    if (!session || session.userId !== claims.sub || session.revokedAt) throw unauthenticated("session is no longer valid");
    if (Date.parse(session.expiresAt) <= nowMs) throw unauthenticated("session expired");
    const user = this.deps.repos.users.findById(claims.sub);
    if (!user) throw unauthenticated("account no longer exists");
    return { user, sessionId: session.id };
  }

  /** Deletes long-expired and revoked sessions. */
  pruneSessions(olderThanMs = 7 * 86_400_000): number {
    return this.deps.repos.sessions.prune(iso(this.deps.clock.now() - olderThanMs));
  }

  private startSession(user: UserRecord, meta: ClientMeta): AuthResult {
    const nowMs = this.deps.clock.now();
    const sessionId = newId("ses");
    const refreshToken = `${sessionId}.${randomToken(32)}`;
    const refreshExpires = nowMs + this.deps.config.auth.refreshTokenTtlSeconds * 1000;
    this.deps.repos.sessions.insert({
      id: sessionId,
      userId: user.id,
      refreshHash: sha256(refreshToken),
      userAgent: meta.userAgent?.slice(0, 256) ?? null,
      ip: meta.ip,
      createdAt: iso(nowMs),
      lastUsedAt: iso(nowMs),
      expiresAt: iso(refreshExpires),
    });
    return this.buildResult(user, sessionId, refreshToken, refreshExpires);
  }

  private buildResult(user: UserRecord, sessionId: string, refreshToken: string, refreshExpires: number): AuthResult {
    const { token, expiresAt } = signAccessToken({ sub: user.id, sid: sessionId }, this.deps.config.auth.jwtSecret, {
      issuer: this.deps.config.auth.jwtIssuer,
      ttlSeconds: this.deps.config.auth.accessTokenTtlSeconds,
      nowMs: this.deps.clock.now(),
    });
    return {
      user: toUserDto(user),
      accessToken: token,
      accessTokenExpiresAt: iso(expiresAt),
      refreshToken,
      refreshTokenExpiresAt: iso(refreshExpires),
    };
  }
}
