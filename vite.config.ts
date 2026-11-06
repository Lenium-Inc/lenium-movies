import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { seoOriginPlugin } from "./scripts/seoOriginPlugin";

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

const validateMediaOrigins: Plugin = {
  name: "streamvy:validate-media-origins",
  config(_config, { command, mode }) {
    if (command !== "build") return;

    const env = loadEnv(mode, import.meta.dirname, "");
    for (const key of [
      "VITE_STREAMVY_API_BASE_URL",
      "VITE_STREAMVY_PROXY_BASE_URL",
    ]) {
      const value = (env[key] || "").trim();
      if (!value) continue;

      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(
          `${key} must be an absolute HTTPS origin, not a relative path.`
        );
      }

      if (
        parsed.protocol !== "https:" ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error(
          `${key} must be a clean HTTPS origin (for example, https://api.example.com), not / or an API path.`
        );
      }
    }
  },
};

const plugins = [
  validateMediaOrigins,
  react(),
  tailwindcss(),
  jsxLocPlugin(),
  // Replaces the __SITE_ORIGIN__ token in index.html with the deployed origin, so
  // the canonical URL, og:url and og:image name the host they are served from
  // instead of a production hostname baked into the file.
  seoOriginPlugin(),
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
    rollupOptions: {
      output: {
        // Framework and icon code change on almost every deploy while the
        // route bundle changes with the feature -- one blob meant every deploy
        // invalidated the whole download. Split so a repeat visit reuses the
        // cached vendor chunks.
        manualChunks(id: string) {
          if (
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react/") ||
            id.includes("node_modules/scheduler")
          ) {
            return "react-vendor";
          }
          if (id.includes("node_modules/lucide-react")) return "icons";
        },
      },
    },
  },
  server: {
    host: true,
    proxy: {
      // Only used in local development when VITE_API_BASE_URL is deliberately
      // relative: forwards to the Streamvy FastAPI service and strips the legacy
      // /api prefix. Vercel builds require an absolute backend origin above;
      // vercel.json has no API proxy and otherwise rewrites /api to index.html.
      "/api": {
        target: "http://127.0.0.1:8001",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ""),
      },
    },
    allowedHosts: ["localhost", "127.0.0.1"],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
