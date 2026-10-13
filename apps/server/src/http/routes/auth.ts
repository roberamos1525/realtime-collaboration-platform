import { changePasswordSchema, loginSchema, logoutSchema, refreshSchema, registerSchema } from "@rcp/shared";
import { z } from "zod";
import { toUserDto } from "../../repositories/users.js";
import type { Services } from "../../services/index.js";
import type { Router } from "../router.js";

export function registerAuthRoutes(router: Router, services: Services): void {
  const { auth } = services;

  router.post(
    "/api/auth/register",
    async (ctx) => auth.register(await ctx.parseBody(registerSchema), ctx.clientMeta()),
    { auth: false, rateLimit: "auth", status: 201 },
  );

  router.post("/api/auth/login", async (ctx) => auth.login(await ctx.parseBody(loginSchema), ctx.clientMeta()), {
    auth: false,
    rateLimit: "auth",
  });

  router.post(
    "/api/auth/refresh",
    async (ctx) => {
      const { refreshToken } = await ctx.parseBody(refreshSchema);
      return auth.refresh(refreshToken, ctx.clientMeta());
    },
    { auth: false, rateLimit: "auth" },
  );

  router.post("/api/auth/logout", async (ctx) => {
    await ctx.parseBody(logoutSchema);
    auth.logout(ctx.user.sessionId);
    return undefined;
  });

  router.post("/api/auth/logout-all", (ctx) => ({ revoked: auth.logoutAll(ctx.userId) }));

  router.get("/api/auth/me", (ctx) => toUserDto(ctx.user.user));

  router.post(
    "/api/auth/password",
    async (ctx) => {
      const input = await ctx.parseBody(changePasswordSchema);
      return { otherSessionsRevoked: await auth.changePassword(ctx.user, input.currentPassword, input.newPassword) };
    },
    { rateLimit: "auth" },
  );

  router.get("/api/users", (ctx) => {
    const { q } = ctx.parseQuery(z.object({ q: z.string().trim().min(2).max(64) }));
    return services.workspaces.searchUsers(q);
  });
}
