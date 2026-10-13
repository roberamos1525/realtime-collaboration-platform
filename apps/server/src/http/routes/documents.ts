import {
  createCommentSchema,
  createVersionSchema,
  moveTaskSchema,
  pageQuerySchema,
  updateCommentSchema,
  updateDocumentSchema,
  updateTaskSchema,
} from "@rcp/shared";
import type { Services } from "../../services/index.js";
import type { Router } from "../router.js";
import { idParam } from "./workspaces.js";

export function registerDocumentRoutes(router: Router, services: Services): void {
  const { documents, comments, tasks, activity } = services;

  // ------------------------------------------------------------ documents

  router.get("/api/documents/:id", (ctx) => documents.get(ctx.userId, idParam(ctx, "id")));

  router.patch("/api/documents/:id", async (ctx) => {
    const { title } = await ctx.parseBody(updateDocumentSchema);
    return documents.rename(ctx.userId, idParam(ctx, "id"), title);
  });

  router.delete("/api/documents/:id", (ctx) => {
    documents.delete(ctx.userId, idParam(ctx, "id"));
    return undefined;
  });

  router.get("/api/documents/:id/activity", (ctx) => {
    const { limit, cursor } = ctx.parseQuery(pageQuerySchema);
    return activity.listForDocument(ctx.userId, idParam(ctx, "id"), limit, cursor);
  });

  // ------------------------------------------------------------- versions

  router.get("/api/documents/:id/versions", (ctx) => documents.listVersions(ctx.userId, idParam(ctx, "id")));

  router.post(
    "/api/documents/:id/versions",
    async (ctx) => {
      const { label } = await ctx.parseBody(createVersionSchema);
      return documents.createVersion(ctx.userId, idParam(ctx, "id"), label);
    },
    { status: 201 },
  );

  router.get("/api/documents/:id/versions/:versionId", (ctx) =>
    documents.getVersion(ctx.userId, idParam(ctx, "id"), idParam(ctx, "versionId")),
  );

  router.post("/api/documents/:id/versions/:versionId/restore", (ctx) =>
    documents.restoreVersion(ctx.userId, idParam(ctx, "id"), idParam(ctx, "versionId")),
  );

  // ------------------------------------------------------------- comments

  router.get("/api/documents/:id/comments", (ctx) => comments.list(ctx.userId, idParam(ctx, "id")));

  router.post(
    "/api/documents/:id/comments",
    async (ctx) => comments.create(ctx.userId, idParam(ctx, "id"), await ctx.parseBody(createCommentSchema)),
    { status: 201 },
  );

  router.patch("/api/comments/:id", async (ctx) => {
    const { body } = await ctx.parseBody(updateCommentSchema);
    return comments.update(ctx.userId, idParam(ctx, "id"), body);
  });

  router.post("/api/comments/:id/resolve", (ctx) => comments.setResolved(ctx.userId, idParam(ctx, "id"), true));
  router.post("/api/comments/:id/reopen", (ctx) => comments.setResolved(ctx.userId, idParam(ctx, "id"), false));

  router.delete("/api/comments/:id", (ctx) => {
    comments.delete(ctx.userId, idParam(ctx, "id"));
    return undefined;
  });

  // ---------------------------------------------------------------- tasks

  router.get("/api/tasks/:id", (ctx) => tasks.get(ctx.userId, idParam(ctx, "id")));

  router.patch("/api/tasks/:id", async (ctx) => tasks.update(ctx.userId, idParam(ctx, "id"), await ctx.parseBody(updateTaskSchema)));

  router.post("/api/tasks/:id/move", async (ctx) => {
    const { status, beforeId } = await ctx.parseBody(moveTaskSchema);
    return tasks.move(ctx.userId, idParam(ctx, "id"), status, beforeId);
  });

  router.delete("/api/tasks/:id", (ctx) => {
    tasks.delete(ctx.userId, idParam(ctx, "id"));
    return undefined;
  });
}
