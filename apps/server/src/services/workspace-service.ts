import { canAssignRole, canRemoveMember, type MemberDto, type PublicUser, type Role, type WorkspaceDto } from "@rcp/shared";
import { badRequest, conflict, forbidden, notFound } from "../core/errors.js";
import { iso, newId, slugify } from "../core/util.js";
import { toPublicUser } from "../repositories/users.js";
import type { WorkspaceWithRole } from "../repositories/workspaces.js";
import type { ActivityService } from "./activity-service.js";
import type { AccessControl, ServiceDeps } from "./context.js";
import type { NotificationService } from "./notification-service.js";

function toDto(w: WorkspaceWithRole): WorkspaceDto {
  return {
    id: w.id,
    name: w.name,
    slug: w.slug,
    description: w.description,
    ownerId: w.ownerId,
    role: w.role,
    memberCount: w.memberCount,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

/** Workspaces, membership and role management. */
export class WorkspaceService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly access: AccessControl,
    private readonly activity: ActivityService,
    private readonly notifications: NotificationService,
    private readonly taskCleanup: { unassignMember(workspaceId: string, userId: string): number },
  ) {}

  list(userId: string): WorkspaceDto[] {
    return this.deps.repos.workspaces.listForUser(userId).map(toDto);
  }

  get(userId: string, workspaceId: string): WorkspaceDto {
    this.access.requireWorkspace(userId, workspaceId, "workspace.read");
    return toDto(this.deps.repos.workspaces.findForUser(workspaceId, userId) as WorkspaceWithRole);
  }

  create(userId: string, input: { name: string; description: string }): WorkspaceDto {
    const { workspaces } = this.deps.repos;
    const now = iso(this.deps.clock.now());
    const id = newId("ws");
    const base = slugify(input.name);
    let slug = base;
    for (let i = 2; workspaces.slugExists(slug); i++) slug = `${base}-${i}`;
    this.deps.db.transaction(() => {
      workspaces.insert({ id, name: input.name, slug, description: input.description, ownerId: userId, createdAt: now, updatedAt: now });
      workspaces.addMember(id, userId, "owner", now);
    });
    this.activity.record({ workspaceId: id, actorId: userId, verb: "workspace.created", targetType: "workspace", targetId: id, meta: { name: input.name } });
    return this.get(userId, id);
  }

  update(userId: string, workspaceId: string, patch: { name?: string | undefined; description?: string | undefined }): WorkspaceDto {
    this.access.requireWorkspace(userId, workspaceId, "workspace.update");
    this.deps.repos.workspaces.update(
      workspaceId,
      { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) },
      iso(this.deps.clock.now()),
    );
    this.activity.record({ workspaceId, actorId: userId, verb: "workspace.updated", targetType: "workspace", targetId: workspaceId, meta: { ...patch } });
    return this.get(userId, workspaceId);
  }

  delete(userId: string, workspaceId: string): void {
    this.access.requireWorkspace(userId, workspaceId, "workspace.delete");
    this.deps.repos.workspaces.delete(workspaceId);
    this.deps.events.emit({ type: "workspace.deleted", workspaceId });
    this.deps.logger.info("workspace deleted", { workspaceId, userId });
  }

  /** Prefix search over users for the "add member" picker (public fields only). */
  searchUsers(query: string): PublicUser[] {
    return this.deps.repos.users.search(query, 10).map(toPublicUser);
  }

  members(userId: string, workspaceId: string): MemberDto[] {
    this.access.requireWorkspace(userId, workspaceId, "member.list");
    return this.deps.repos.workspaces.listMembers(workspaceId).map((m) => ({
      user: { id: m.userId, username: m.username, displayName: m.displayName },
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  addMember(userId: string, workspaceId: string, identifier: string, role: Role): MemberDto[] {
    const { workspace, role: actorRole } = this.access.requireWorkspace(userId, workspaceId, "member.manage");
    const target = this.deps.repos.users.findByLogin(identifier);
    if (!target) throw notFound("user");
    const existing = this.deps.repos.workspaces.roleOf(workspaceId, target.id);
    if (existing) throw conflict("user is already a member");
    if (!canAssignRole(actorRole, null, role)) throw forbidden(`a ${actorRole} cannot grant the ${role} role`);
    this.deps.repos.workspaces.addMember(workspaceId, target.id, role, iso(this.deps.clock.now()));
    this.activity.record({ workspaceId, actorId: userId, verb: "member.added", targetType: "member", targetId: target.id, meta: { role, username: target.username } });
    this.notifications.notify({
      userId: target.id,
      kind: "member_added",
      title: `You were added to ${workspace.name}`,
      body: `Role: ${role}`,
      actorId: userId,
      workspaceId,
    });
    this.deps.events.emit({ type: "membership.changed", workspaceId, userId: target.id });
    return this.members(userId, workspaceId);
  }

  changeRole(userId: string, workspaceId: string, targetUserId: string, role: Role): MemberDto[] {
    const { role: actorRole } = this.access.requireWorkspace(userId, workspaceId, "member.manage");
    const current = this.deps.repos.workspaces.roleOf(workspaceId, targetUserId);
    if (!current) throw notFound("member");
    if (targetUserId === userId) throw badRequest("you cannot change your own role");
    if (!canAssignRole(actorRole, current, role)) throw forbidden(`a ${actorRole} cannot change a ${current} to ${role}`);
    this.deps.repos.workspaces.setRole(workspaceId, targetUserId, role);
    this.activity.record({ workspaceId, actorId: userId, verb: "member.role_changed", targetType: "member", targetId: targetUserId, meta: { from: current, to: role } });
    this.deps.events.emit({ type: "membership.changed", workspaceId, userId: targetUserId });
    return this.members(userId, workspaceId);
  }

  removeMember(userId: string, workspaceId: string, targetUserId: string): void {
    const actorRole = this.access.requireWorkspace(userId, workspaceId, "workspace.read").role;
    const current = this.deps.repos.workspaces.roleOf(workspaceId, targetUserId);
    if (!current) throw notFound("member");
    const isSelf = targetUserId === userId;
    if (!canRemoveMember(actorRole, current, isSelf)) {
      throw forbidden(current === "owner" ? "the owner cannot leave; transfer ownership first" : "you cannot remove this member");
    }
    this.deps.repos.workspaces.removeMember(workspaceId, targetUserId);
    const unassigned = this.taskCleanup.unassignMember(workspaceId, targetUserId);
    this.activity.record({
      workspaceId,
      actorId: userId,
      verb: isSelf ? "member.left" : "member.removed",
      targetType: "member",
      targetId: targetUserId,
      meta: { unassignedTasks: unassigned },
    });
    this.deps.events.emit({ type: "membership.changed", workspaceId, userId: targetUserId });
  }

  transferOwnership(userId: string, workspaceId: string, newOwnerId: string): MemberDto[] {
    this.access.requireWorkspace(userId, workspaceId, "workspace.transfer");
    if (newOwnerId === userId) throw badRequest("you already own this workspace");
    const current = this.deps.repos.workspaces.roleOf(workspaceId, newOwnerId);
    if (!current) throw notFound("member");
    const now = iso(this.deps.clock.now());
    this.deps.db.transaction(() => {
      this.deps.repos.workspaces.setRole(workspaceId, newOwnerId, "owner");
      this.deps.repos.workspaces.setRole(workspaceId, userId, "admin");
      this.deps.repos.workspaces.setOwner(workspaceId, newOwnerId, now);
    });
    this.activity.record({ workspaceId, actorId: userId, verb: "workspace.transferred", targetType: "workspace", targetId: workspaceId, meta: { to: newOwnerId } });
    this.deps.events.emit({ type: "membership.changed", workspaceId, userId });
    this.deps.events.emit({ type: "membership.changed", workspaceId, userId: newOwnerId });
    return this.members(userId, workspaceId);
  }
}
