import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.API_URL ?? "http://127.0.0.1:4000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@rcp/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/ws": { target: apiTarget.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      onwarn(warning, warn) {
        // zod ships comments Rollup cannot attach; they are harmless.
        if (warning.code === "INVALID_ANNOTATION" && warning.id?.includes("zod")) return;
        warn(warning);
      },
    },
  },
});
