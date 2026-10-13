import type { PublicUser, UserDto } from "@rcp/shared";
import type { Database } from "../db/database.js";

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
}

const COLUMNS = `id, email, username, display_name AS displayName, password_hash AS passwordHash,
  created_at AS createdAt, updated_at AS updatedAt, last_login_at AS lastLoginAt`;

export function toPublicUser(user: Pick<UserRecord, "id" | "username" | "displayName">): PublicUser {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

export function toUserDto(user: UserRecord): UserDto {
  return { ...toPublicUser(user), email: user.email, createdAt: user.createdAt };
}

export class UserRepository {
  constructor(private readonly db: Database) {}

  insert(user: UserRecord): void {
    this.db.run(
      `INSERT INTO users (id, email, username, display_name, password_hash, created_at, updated_at, last_login_at)
       VALUES (:id, :email, :username, :displayName, :passwordHash, :createdAt, :updatedAt, :lastLoginAt)`,
      {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        passwordHash: user.passwordHash,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
      },
    );
  }

  findById(id: string): UserRecord | undefined {
    return this.db.get<UserRecord>(`SELECT ${COLUMNS} FROM users WHERE id = ?`, [id]);
  }

  findByEmail(email: string): UserRecord | undefined {
    return this.db.get<UserRecord>(`SELECT ${COLUMNS} FROM users WHERE email = ?`, [email.toLowerCase()]);
  }

  findByUsername(username: string): UserRecord | undefined {
    return this.db.get<UserRecord>(`SELECT ${COLUMNS} FROM users WHERE username = ?`, [username]);
  }

  /** Looks a user up by e-mail (if it contains "@") or username. */
  findByLogin(login: string): UserRecord | undefined {
    return login.includes("@") ? this.findByEmail(login) : this.findByUsername(login);
  }

  findManyByIds(ids: readonly string[]): Map<string, UserRecord> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.all<UserRecord>(`SELECT ${COLUMNS} FROM users WHERE id IN (${placeholders})`, unique);
    return new Map(rows.map((r) => [r.id, r]));
  }

  findByUsernames(usernames: readonly string[]): UserRecord[] {
    if (usernames.length === 0) return [];
    const placeholders = usernames.map(() => "?").join(",");
    return this.db.all<UserRecord>(`SELECT ${COLUMNS} FROM users WHERE username IN (${placeholders})`, [...usernames]);
  }

  /** Prefix search on username / display name / e-mail, for member pickers. */
  search(query: string, limit: number): UserRecord[] {
    const like = `${query.replace(/[\\%_]/g, (c) => `\\${c}`).toLowerCase()}%`;
    return this.db.all<UserRecord>(
      `SELECT ${COLUMNS} FROM users
       WHERE lower(username) LIKE :like ESCAPE '\\' OR lower(display_name) LIKE :like ESCAPE '\\' OR email LIKE :like ESCAPE '\\'
       ORDER BY username LIMIT :limit`,
      { like, limit },
    );
  }

  updatePasswordHash(id: string, passwordHash: string, at: string): void {
    this.db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [passwordHash, at, id]);
  }

  touchLogin(id: string, at: string): void {
    this.db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [at, id]);
  }

  count(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM users")?.n ?? 0;
  }
}
