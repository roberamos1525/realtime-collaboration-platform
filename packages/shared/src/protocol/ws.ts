import { z } from "zod";
import { rgaOpSchema, type RgaOp } from "../crdt/ops.js";
import type { RgaSnapshot } from "../crdt/snapshot.js";
import type { Role } from "../permissions.js";
import type { ErrorCode } from "./errors.js";
import type { ActivityDto, CommentDto, DocumentDto, NotificationDto, TaskDto } from "./api.js";

/** Maximum size of a single WebSocket frame accepted by the server. */
export const MAX_WS_MESSAGE_BYTES = 256 * 1024;

const docId = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const anchor = z.string().max(64).regex(/^\d+@[A-Za-z0-9_-]+$/).nullable();

export const cursorSchema = z.object({ anchor, head: anchor });
export type CursorState = z.infer<typeof cursorSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(10).max(2048) }),
  z.object({ type: z.literal("ping"), t: z.number().finite() }),
  z.object({ type: z.literal("doc.join"), docId }),
  z.object({ type: z.literal("doc.leave"), docId }),
  z.object({ type: z.literal("doc.op"), docId, op: rgaOpSchema }),
  z.object({ type: z.literal("doc.ack"), docId, seq: z.number().int().nonnegative() }),
  z.object({ type: z.literal("presence.update"), docId, cursor: cursorSchema.nullable() }),
  z.object({ type: z.literal("workspace.subscribe"), workspaceId: docId }),
  z.object({ type: z.literal("workspace.unsubscribe"), workspaceId: docId }),
]);

type ParsedClientMessage = z.infer<typeof clientMessageSchema>;
/** Client frames; `doc.op` carries the (readonly) CRDT operation type. */
export type ClientMessage =
  | Exclude<ParsedClientMessage, { type: "doc.op" }>
  | { readonly type: "doc.op"; readonly docId: string; readonly op: RgaOp };

export interface PresencePeer {
  readonly connectionId: string;
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly color: string;
  readonly cursor: CursorState | null;
  readonly lastSeen: number;
}

export type WorkspaceEvent =
  | { readonly kind: "task.upserted"; readonly task: TaskDto }
  | { readonly kind: "task.deleted"; readonly taskId: string }
  | { readonly kind: "comment.upserted"; readonly comment: CommentDto }
  | { readonly kind: "comment.deleted"; readonly commentId: string; readonly documentId: string }
  | { readonly kind: "document.upserted"; readonly document: DocumentDto }
  | { readonly kind: "document.deleted"; readonly documentId: string }
  | { readonly kind: "activity"; readonly activity: ActivityDto }
  | { readonly kind: "members.changed" };

export type ServerMessage =
  | { readonly type: "ready"; readonly userId: string; readonly connectionId: string; readonly heartbeatMs: number }
  | { readonly type: "pong"; readonly t: number }
  | { readonly type: "error"; readonly code: ErrorCode; readonly message: string; readonly docId?: string }
  | {
      readonly type: "doc.joined";
      readonly docId: string;
      readonly site: string;
      readonly snapshot: RgaSnapshot;
      readonly seq: number;
      readonly role: Role;
      readonly peers: PresencePeer[];
    }
  | { readonly type: "doc.op"; readonly docId: string; readonly op: RgaOp; readonly seq: number; readonly userId: string }
  | { readonly type: "doc.ack"; readonly docId: string; readonly seq: number; readonly opSeq: number }
  | { readonly type: "doc.resync"; readonly docId: string; readonly reason: string }
  | { readonly type: "doc.meta"; readonly docId: string; readonly title: string }
  | { readonly type: "doc.closed"; readonly docId: string; readonly reason: string }
  | { readonly type: "presence.update"; readonly docId: string; readonly peer: PresencePeer }
  | { readonly type: "presence.leave"; readonly docId: string; readonly connectionId: string }
  | { readonly type: "workspace.event"; readonly workspaceId: string; readonly event: WorkspaceEvent }
  | { readonly type: "workspace.online"; readonly workspaceId: string; readonly userIds: string[] }
  | { readonly type: "notification"; readonly notification: NotificationDto; readonly unreadCount: number };

export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;

/** WebSocket close codes used by the server (4000-4999 is application space). */
export const CLOSE_CODES = {
  authTimeout: 4001,
  authFailed: 4003,
  rateLimited: 4008,
  sessionRevoked: 4010,
  heartbeatTimeout: 4011,
  shuttingDown: 1001,
  invalidMessage: 1007,
  tooLarge: 1009,
} as const;

/** Palette used for presence colours, chosen deterministically per user. */
export const PRESENCE_COLORS = [
  "#e5484d",
  "#f76b15",
  "#ffb224",
  "#30a46c",
  "#12a594",
  "#0090ff",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
  "#978365",
] as const;

export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] as string;
}
