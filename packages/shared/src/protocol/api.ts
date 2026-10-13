import { z } from "zod";
import type { Role } from "../permissions.js";
import { USERNAME_PATTERN } from "../text/mentions.js";

// ------------------------------------------------------------------ helpers

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const id = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/, "invalid id");
const elementKey = z.string().max(64).regex(/^\d+@[A-Za-z0-9_-]+$/, "invalid anchor key");
const assignableRole = z.enum(["viewer", "commenter", "editor", "admin"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const idSchema = id;

// --------------------------------------------------------------------- auth

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  username: z.string().trim().regex(USERNAME_PATTERN, "3-32 chars: letters, digits, _ . -"),
  displayName: trimmed(1, 80),
  password: z.string().min(10, "at least 10 characters").max(256),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  login: trimmed(3, 254),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(512) });
export const logoutSchema = z.object({ refreshToken: z.string().min(20).max(512).optional() });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(10).max(256),
});

// --------------------------------------------------------------- workspaces

export const createWorkspaceSchema = z.object({
  name: trimmed(2, 80),
  description: z.string().trim().max(500).default(""),
});
export const updateWorkspaceSchema = z
  .object({ name: trimmed(2, 80).optional(), description: z.string().trim().max(500).optional() })
  .refine((v) => v.name !== undefined || v.description !== undefined, "nothing to update");

export const addMemberSchema = z.object({
  identifier: trimmed(3, 254),
  role: assignableRole.default("editor"),
});
export const updateMemberSchema = z.object({ role: assignableRole });
export const transferOwnershipSchema = z.object({ userId: id });

// ---------------------------------------------------------------- documents

export const MAX_DOCUMENT_LENGTH = 500_000;

export const createDocumentSchema = z.object({
  title: trimmed(1, 200),
  content: z.string().max(MAX_DOCUMENT_LENGTH).default(""),
});
export const updateDocumentSchema = z.object({ title: trimmed(1, 200) });
export const createVersionSchema = z.object({ label: trimmed(1, 120) });

// ----------------------------------------------------------------- comments

export const commentAnchorSchema = z.object({
  start: elementKey,
  end: elementKey,
  quote: z.string().max(1000),
});
export const createCommentSchema = z
  .object({
    body: trimmed(1, 5000),
    anchor: commentAnchorSchema.optional(),
    parentId: id.optional(),
  })
  .refine((v) => !(v.anchor && v.parentId), "replies cannot carry an anchor");
export const updateCommentSchema = z.object({ body: trimmed(1, 5000) });

// -------------------------------------------------------------------- tasks

export const TASK_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const labelsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(32).regex(/^[a-z0-9][a-z0-9 _-]*$/, "invalid label"))
  .max(10)
  .transform((labels) => [...new Set(labels)]);

export const createTaskSchema = z.object({
  title: trimmed(1, 200),
  description: z.string().trim().max(10_000).default(""),
  status: z.enum(TASK_STATUSES).default("todo"),
  priority: z.enum(TASK_PRIORITIES).default("medium"),
  assigneeId: id.nullable().default(null),
  dueDate: isoDate.nullable().default(null),
  labels: labelsSchema.default([]),
  documentId: id.nullable().default(null),
});
export const updateTaskSchema = z
  .object({
    title: trimmed(1, 200).optional(),
    description: z.string().trim().max(10_000).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeId: id.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    labels: labelsSchema.optional(),
    documentId: id.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "nothing to update");
export const moveTaskSchema = z.object({
  status: z.enum(TASK_STATUSES),
  /** Place the task directly before this task (null = end of column). */
  beforeId: id.nullable().default(null),
});
export const taskQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: id.optional(),
  label: z.string().max(32).optional(),
});

// ------------------------------------------------------------ search/paging

export const SEARCH_TYPES = ["document", "comment", "task"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const searchQuerySchema = z.object({
  q: trimmed(1, 200),
  workspaceId: id.optional(),
  types: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return [...SEARCH_TYPES];
      const parts = v.split(",").map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        if (!(SEARCH_TYPES as readonly string[]).includes(p)) {
          ctx.addIssue({ code: "custom", message: `unknown type ${p}` });
          return z.NEVER;
        }
      }
      return parts as SearchType[];
    }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(64).optional(),
});
export const notificationQuerySchema = pageQuerySchema.extend({
  unread: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

// --------------------------------------------------------------------- DTOs

export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export interface UserDto extends PublicUser {
  readonly email: string;
  readonly createdAt: string;
}

export interface AuthResult {
  readonly user: UserDto;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

export interface WorkspaceDto {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly ownerId: string;
  readonly role: Role;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemberDto {
  readonly user: PublicUser;
  readonly role: Role;
  readonly joinedAt: string;
}

export interface DocumentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly excerpt: string;
}

export interface DocumentDetailDto extends DocumentDto {
  readonly text: string;
  readonly headSeq: number;
  readonly role: Role;
}

export interface VersionDto {
  readonly id: string;
  readonly documentId: string;
  readonly label: string;
  readonly seq: number;
  readonly length: number;
  readonly createdBy: PublicUser | null;
  readonly createdAt: string;
}

export interface VersionDetailDto extends VersionDto {
  readonly text: string;
}

export interface CommentAnchor {
  readonly start: string;
  readonly end: string;
  readonly quote: string;
}

export interface CommentDto {
  readonly id: string;
  readonly documentId: string;
  readonly workspaceId: string;
  readonly parentId: string | null;
  readonly author: PublicUser | null;
  readonly body: string;
  readonly anchor: CommentAnchor | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotificationDto {
  readonly id: string;
  readonly kind: "mention" | "comment_reply" | "task_assigned" | "member_added" | "document_restored";
  readonly title: string;
  readonly body: string;
  readonly workspaceId: string | null;
  readonly documentId: string | null;
  readonly entityId: string | null;
  readonly actor: PublicUser | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface ActivityDto {
  readonly id: number;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly actor: PublicUser | null;
  readonly verb: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly meta: Record<string, unknown>;
  readonly createdAt: string;
}

export interface TaskDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly assignee: PublicUser | null;
  readonly dueDate: string | null;
  readonly labels: string[];
  readonly position: number;
  readonly documentId: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SearchHit {
  readonly type: SearchType;
  readonly id: string;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly title: string;
  readonly snippet: string;
  /** [start, end) character ranges inside `snippet` that matched the query. */
  readonly highlights: Array<[number, number]>;
  readonly score: number;
  readonly updatedAt: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}
