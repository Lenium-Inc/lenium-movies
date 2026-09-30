import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

// =============================================================================
// Vite config.
//
// The template arrived with two Manus plugins wired in: a runtime plugin and a
// "debug collector" that injected a script and an unauthenticated
// POST /__manus__/logs endpoint writing browser console logs, network requests
// and session events to .manus-logs/ on disk. Neither is part of this product
// and neither is referenced by it, so both are removed rather than left as a
// build step that quietly logs everything a viewer's browser does.
// =============================================================================

const plugins = [
  react(),
  tailwindcss(),
  jsxLocPlugin(),
];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: true,
    proxy: {
      // The Flask backend owns every /api route; there is no second API server.
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});