import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const sharedSrc = fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url));
const alias = { "@rcp/shared": sharedSrc };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: "shared", include: ["packages/shared/src/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: { name: "server", include: ["apps/server/src/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: { name: "web", include: ["apps/web/src/**/*.test.ts"], environment: "node" },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
