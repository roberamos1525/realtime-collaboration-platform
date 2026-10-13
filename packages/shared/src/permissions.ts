/**
 * Workspace role model. Roles are strictly ordered; every permission is
 * granted from a minimum role upwards. The same table is enforced by the
 * server (HTTP and WebSocket) and used by the client to hide controls.
 */
export const ROLES = ["viewer", "commenter", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3, owner: 4 };

export const ACTIONS = {
  "workspace.read": "viewer",
  "workspace.update": "admin",
  "workspace.delete": "owner",
  "workspace.transfer": "owner",
  "member.list": "viewer",
  "member.manage": "admin",
  "document.read": "viewer",
  "document.create": "editor",
  "document.edit": "editor",
  "document.rename": "editor",
  "document.delete": "admin",
  "version.create": "editor",
  "version.restore": "admin",
  "comment.read": "viewer",
  "comment.create": "commenter",
  "comment.resolve": "editor",
  "comment.moderate": "admin",
  "task.read": "viewer",
  "task.write": "editor",
  "task.delete": "admin",
  "activity.read": "viewer",
} as const satisfies Record<string, Role>;

export type Action = keyof typeof ACTIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return RANK[role];
}

/** True when `role` is at least `minimum`. */
export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

/** Whether a member with `role` may perform `action`. */
export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return roleAtLeast(role, ACTIONS[action]);
}

/**
 * Rules for changing another member's role. Only the owner may create or
 * demote admins; nobody can assign `owner` (ownership is transferred
 * explicitly) and the owner's own membership cannot be changed this way.
 */
export function canAssignRole(actor: Role, currentTarget: Role | null, nextRole: Role): boolean {
  if (nextRole === "owner") return false;
  if (currentTarget === "owner") return false;
  if (!can(actor, "member.manage")) return false;
  if (actor === "owner") return true;
  // Admins manage everyone below admin.
  if (currentTarget !== null && roleAtLeast(currentTarget, "admin")) return false;
  return !roleAtLeast(nextRole, "admin");
}

/** Whether `actor` may remove a member currently holding `target`. */
export function canRemoveMember(actor: Role, target: Role, isSelf: boolean): boolean {
  if (target === "owner") return false;
  if (isSelf) return true;
  if (!can(actor, "member.manage")) return false;
  return actor === "owner" || !roleAtLeast(target, "admin");
}
