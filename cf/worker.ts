/**
 * The Cloudflare Worker entry point.
 *
 * One Worker replaces the Vercel split: the built SPA from `dist/public` is
 * served through the ASSETS binding, and every `/api/*` route that used to be a
 * file under `api/` is dispatched here.
 *
 * Route precedence mirrors Vercel's file-based routing: the specific handlers
 * win over the account catch-all. `/api/v1/playback/*`, `/api/catalog/*`,
 * `/api/movies/*` and the rest of the catalogue live on the external MovieBox
 * API and never reach this Worker.
 */

import accountHandler from "../api/[...path]";
import androidVersionHandler from "../api/android-version";
import trailerHandler from "../api/trailer";
import streamProxyHandler from "../api/proxy/stream";
import downloadProxyHandler from "../api/proxy/download";
import { runNodeHandler } from "./adapter";
import { handleImage } from "./image";

/**
 * Minimal shapes for the Worker globals, declared locally so the Worker can be
 * type-checked without pulling `@cloudflare/workers-types` into the app's
 * TypeScript project.
 */
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  ASSETS: Fetcher;
  DATABASE_URL?: string;
  TMDB_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    try {
      if (pathname === "/api/image") return await handleImage(request);
      if (pathname === "/api/trailer") return await trailerHandler(request);
      if (pathname === "/api/android-version") {
        return await androidVersionHandler(request);
      }
      if (pathname === "/api/proxy/stream")
        return await streamProxyHandler(request);
      if (pathname === "/api/proxy/download") {
        return await downloadProxyHandler(request);
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        return await runNodeHandler(request, accountHandler);
      }
    } catch (error) {
      console.error("[worker]", pathname, error);
      return new Response(
        JSON.stringify({ error: "The service could not fulfil this request." }),
        {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    // Static assets, with the SPA fallback from `not_found_handling`.
    return env.ASSETS.fetch(request);
  },
};
