/**
 * Injects the deployment's own origin into the static head.
 *
 * The problem
 * -----------
 * `index.html` is the only SEO surface a crawler reliably reads, and it has to be
 * a literal file -- there is no server to render it. So the canonical URL, the
 * `og:url` and the `og:image` have to name a host in the file itself, and the
 * obvious thing to write is the production hostname.
 *
 * That is wrong for every environment that is not production. A Vercel preview
 * deploy then advertises `https://vy-virid.vercel.app` as the canonical URL of
 * every page on it, which tells a search engine the preview *is* the live site.
 * The same literal was independently duplicated in `server/seo.ts`, so the host
 * was in three places and could only ever be right in one environment.
 *
 * The fix
 * -------
 * `index.html` writes a `__SITE_ORIGIN__` token and this plugin substitutes the
 * real value at build time from the same `VITE_SITE_URL` the runtime resolves in
 * `client/src/lib/siteUrl.ts` -- one source for the origin, used by both the
 * static head and the client.
 *
 * With `VITE_SITE_URL` unset the token becomes an empty string, leaving a
 * root-relative URL. A relative canonical is resolved against the document's own
 * origin and is accepted by every major engine, so an unconfigured build degrades
 * to "correct wherever this is served from" instead of "confidently wrong".
 */

import type { Plugin } from "vite";

export const SITE_ORIGIN_TOKEN = "__SITE_ORIGIN__";

/**
 * Normalise a configured origin: trimmed, without a trailing slash.
 *
 * Exported separately from the plugin so it can be tested without constructing a
 * Vite build.
 */
export function normalizeOrigin(value: string | undefined | null): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

/**
 * Replace the token in a document.
 *
 * A single pass, so an origin that itself contains the token cannot be
 * substituted into again.
 */
export function injectOrigin(html: string, origin: string): string {
  if (!html.includes(SITE_ORIGIN_TOKEN)) return html;
  return html.split(SITE_ORIGIN_TOKEN).join(origin);
}

export function seoOriginPlugin(): Plugin {
  return {
    name: "streamvy:seo-origin",
    /*
     * `loadEnv` is not in scope inside a plugin method, so this reads the
     * process env -- which Vite has already populated from the `envDir` in
     * vite.config.ts by the time transforms run. That is the same variable the
     * client's `siteUrl.ts` falls back to, which is the point: one env var, one
     * origin.
     */
    transformIndexHtml(html: string) {
      return injectOrigin(html, normalizeOrigin(process.env.VITE_SITE_URL));
    },
  };
}

export default seoOriginPlugin;
