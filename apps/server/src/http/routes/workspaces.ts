import {
  addMemberSchema,
  createDocumentSchema,
  createTaskSchema,
  createWorkspaceSchema,
  idSchema,
  pageQuerySchema,
  taskQuerySchema,
  transferOwnershipSchema,
  updateMemberSchema,
  updateWorkspaceSchema,
} from "@rcp/shared";
import { parseInput } from "../../core/errors.js";
import type { Services } from "../../services/index.js";
import type { RequestContext } from "../context.js";
import type { Router } from "../router.js";

/** Validates an id path parameter so malformed ids fail fast with 422. */
export function idParam(ctx: RequestContext, name: string): string {
  return parseInput(idSchema, ctx.param(name));
}

export function registerWorkspaceRoutes(router: Router, services: Services): void {
  const { workspaces, documents, tasks, activity } = services;

  router.get("/api/workspaces", (ctx) => workspaces.list(ctx.userId));

  router.post("/api/workspaces", async (ctx) => workspaces.create(ctx.userId, await ctx.parseBody(createWorkspaceSchema)), { status: 201 });

  router.get("/api/workspaces/:id", (ctx) => workspaces.get(ctx.userId, idParam(ctx, "id")));

  router.patch("/api/workspaces/:id", async (ctx) =>
    workspaces.update(ctx.userId, idParam(ctx, "id"), await ctx.parseBody(updateWorkspaceSchema)),
  );

  router.delete("/api/workspaces/:id", (ctx) => {
    workspaces.delete(ctx.userId, idParam(ctx, "id"));
    return undefined;
  });

  // ------------------------------------------------------------- members

  router.get("/api/workspaces/:id/members", (ctx) => workspaces.members(ctx.userId, idParam(ctx, "id")));

  router.post(
    "/api/workspaces/:id/members",
    async (ctx) => {
      const input = await ctx.parseBody(addMemberSchema);
      return workspaces.addMember(ctx.userId, idParam(ctx, "id"), input.identifier, input.role);
    },
    { status: 201 },
  );

  router.patch("/api/workspaces/:id/members/:userId", async (ctx) => {
    const { role } = await ctx.parseBody(updateMemberSchema);
    return workspaces.changeRole(ctx.userId, idParam(ctx, "id"), idParam(ctx, "userId"), role);
  });

  router.delete("/api/workspaces/:id/members/:userId", (ctx) => {
    workspaces.removeMember(ctx.userId, idParam(ctx, "id"), idParam(ctx, "userId"));
    return undefined;
  });

  router.post("/api/workspaces/:id/transfer", async (ctx) => {
    const { userId } = await ctx.parseBody(transferOwnershipSchema);
    return workspaces.transferOwnership(ctx.userId, idParam(ctx, "id"), userId);
  });

  // ---------------------------------------------------- nested collections

  router.get("/api/workspaces/:id/documents", (ctx) => documents.list(ctx.userId, idParam(ctx, "id")));

  router.post(
    "/api/workspaces/:id/documents",
    async (ctx) => documents.create(ctx.userId, idParam(ctx, "id"), await ctx.parseBody(createDocumentSchema)),
    { status: 201 },
  );

  router.get("/api/workspaces/:id/tasks", (ctx) => {
    const filter = ctx.parseQuery(taskQuerySchema);
    return tasks.list(ctx.userId, idParam(ctx, "id"), {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.assigneeId ? { assigneeId: filter.assigneeId } : {}),
      ...(filter.label ? { label: filter.label } : {}),
    });
  });

  router.post(
    "/api/workspaces/:id/tasks",
    async (ctx) => tasks.create(ctx.userId, idParam(ctx, "id"), await ctx.parseBody(createTaskSchema)),
    { status: 201 },
  );

  router.get("/api/workspaces/:id/activity", (ctx) => {
    const { limit, cursor } = ctx.parseQuery(pageQuerySchema);
    return activity.listForWorkspace(ctx.userId, idParam(ctx, "id"), limit, cursor);
  });
}
