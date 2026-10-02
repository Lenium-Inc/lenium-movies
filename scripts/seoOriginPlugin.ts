/**
 * Makes the deployment's own origin the only origin the build emits.
 *
 * The problem
 * -----------
 * `index.html` and `sitemap.xml` are the two SEO surfaces a crawler reads
 * directly, and both have to be literal files -- there is no server to render
 * them. So the canonical URL, the `og:url`, the `<loc>` entries and the `Sitemap:`
 * line in `robots.txt` all have to name a host, and the obvious thing to write is
 * the production hostname.
 *
 * That is wrong for every environment that is not production. A Vercel preview
 * deploy then advertises `https://vy-virid.vercel.app` as the canonical URL of
 * every page on it, and as the location of every film, which tells a search engine
 * the preview *is* the live site. The same literal was independently duplicated in
 * `server/seo.ts` and `public/robots.txt`, so the host was in four places and
 * could only ever be right in one of them.
 *
 * The fix
 * -------
 * Two parts, and the second is the one that matters.
 *
 * 1. `index.html` writes a `__SITE_ORIGIN__` token which is substituted at build
 *    time from the same `VITE_SITE_URL` the client resolves in `siteUrl.ts` -- one
 *    env var, one origin.
 * 2. `sitemap.xml` and `robots.txt` are *generated* here, rather than being
 *    hand-maintained files in `public/`. Both are now derived from the route table
 *    in `client/src/lib/seo.ts`, so a new public route cannot be added without
 *    appearing in the sitemap, and a private route cannot leak into it. The old
 *    sitemap was a fourth hand-written copy of the route list, with the origin
 *    written into all four entries.
 *
 * With `VITE_SITE_URL` unset the origin becomes an empty string, leaving URLs
 * root-relative. A relative canonical is resolved against the document's own
 * origin and is accepted by every major engine, so an unconfigured build degrades
 * to "correct wherever this is served from" instead of "confidently wrong". Note
 * that a relative `<loc>` is *not* valid inside a sitemap -- the spec wants an
 * absolute URL -- so an unconfigured production deploy would ship a sitemap
 * engines may reject. That is the intended failure: a rejected sitemap costs
 * nothing, whereas a sitemap pointing at the wrong host canonicalises the wrong
 * URLs.
 */

import { loadEnv, type Plugin } from "vite";
import { INDEXABLE_PATHS, ROBOTS_DISALLOW_PATHS } from "../client/src/lib/seo";

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

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * `sitemap.xml`, built from `INDEXABLE_PATHS`.
 *
 * Carries `<loc>` and nothing else. The previous file also carried:
 *
 * - a `lastmod` of `2026-10-01` on all four URLs, a date no commit history
 *   supports. `lastmod` is a hint about how often to re-crawl, so a wrong value is
 *   not inert -- a crawler trusting it can skip a page that genuinely changed.
 * - `changefreq` and `priority`, which Google states it ignores outright. They
 *   looked like tuning and were decoration.
 * - an `image:image` entry pointing at the 32x32 SVG brand mark, on the
 *   homepage. Google Images wants raster, and an image entry is meant for a page
 *   whose primary content is that image; the homepage's primary content is a
 *   film catalogue.
 *
 * The one thing a sitemap cannot express without an absolute URL is `<loc>`, which
 * is why an unconfigured build is documented above as a degraded state rather than
 * a supported one.
 */
export function renderSitemap(
  paths: readonly string[] = INDEXABLE_PATHS,
  origin = ""
): string {
  const entries = paths
    .map(path => {
      const loc = `${origin}${path === "/" ? "/" : path}`;
      return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

/**
 * `robots.txt`, built from `ROBOTS_DISALLOW_PATHS`.
 *
 * One `User-agent: *` group. The file also had an identical `Googlebot` group,
 * which is redundant rather than clarifying: a crawler picks the most specific
 * group that matches it and falls back to `*`, so where the two groups are the
 * same the second changes nothing while implying the first might not apply.
 */
export function renderRobots(
  disallow: readonly string[] = ROBOTS_DISALLOW_PATHS,
  origin = ""
): string {
  const lines = [
    "User-agent: *",
    "Allow: /",
    "",
    ...disallow.map(path => `Disallow: ${path}/`),
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ];
  return lines.join("\n");
}

export function seoOriginPlugin(): Plugin {
  let origin = "";

  return {
    name: "streamvy:seo-origin",
    /*
     * `configResolved` rather than reading `process.env` inline: Vite does *not*
     * populate `process.env` from the `.env` files it loads, so a `VITE_SITE_URL`
     * committed in `.env` would reach the client through `import.meta.env` while
     * the static head silently kept its unresolved token. `loadEnv` is the
     * supported way to read the same files the client is built from, and reading
     * the real environment too means a platform-injected variable still wins.
     */
    configResolved(config) {
      const fromFile = loadEnv(config.mode, config.envDir, "VITE_SITE_URL");
      origin = normalizeOrigin(
        fromFile.VITE_SITE_URL ?? process.env.VITE_SITE_URL
      );
    },

    transformIndexHtml(html: string) {
      return injectOrigin(html, origin);
    },

    /*
     * Emitted rather than read from `public/`, so the file is derived from the
     * route table instead of maintained beside it.
     */
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: renderSitemap(INDEXABLE_PATHS, origin),
      });
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: renderRobots(ROBOTS_DISALLOW_PATHS, origin),
      });
    },

    /*
     * `npm run dev` gets the same two files, from the same functions, so a local
     * run shows what production will ship instead of a hand-written copy of it.
     * Sitemaps only matter to crawlers, which never visit localhost, so this is
     * for fidelity rather than for indexing.
     */
    configureServer(server) {
      server.middlewares.use("/sitemap.xml", (_request, response) => {
        response.setHeader("Content-Type", "application/xml; charset=utf-8");
        response.end(renderSitemap(INDEXABLE_PATHS, origin));
      });
      server.middlewares.use("/robots.txt", (_request, response) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(renderRobots(ROBOTS_DISALLOW_PATHS, origin));
      });
    },
  };
}

export default seoOriginPlugin;
